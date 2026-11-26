package fishing

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	"deepmarket/server/internal/repo"
	"deepmarket/server/internal/sse"
)

var (
	ErrRodBroken     = errors.New("fishing rod is broken")
	ErrLowDurability = errors.New("fishing rod durability is too low")
)

const (
	phaseCharging      = "charging"
	phaseReeling       = "reeling"
	autoRepairCoinCost = int64(1)
)

// PlayerFishingState is the authoritative fishing state within players.state.
type PlayerFishingState struct {
	Running           bool       `json:"running"`
	SelectedDepthID   string     `json:"selected_depth_id"`
	Phase             string     `json:"phase"`
	Progress          float64    `json:"progress"`
	Tension           float64    `json:"tension"`
	RecoverUntilMs    int64      `json:"recover_until_ms"`
	RecoverFrom       float64    `json:"recover_from"`
	AutoRepairLevel   int        `json:"auto_repair_level"`
	AutoRepairAtMs    int64      `json:"auto_repair_at_ms"`
	LowDurability     bool       `json:"low_durability"`
	AutoStopped       bool       `json:"auto_stopped"`
	ManualResume      bool       `json:"manual_resume"`
	LastTickAtMs      int64      `json:"last_tick_at_ms"`
	Bite              *BiteState `json:"bite"`
	AllowCoinFallback bool       `json:"allow_coin_fallback"`
}

// RollContext supplies the server-owned inputs for a new bite.
type RollContext struct {
	UserID   int64
	DepthID  string
	Rod      *repo.EquipmentInstance
	Progress float64
	NowMs    int64
}

// EngineConfig controls timer intervals and allows deterministic clocks and rolls in tests.
type EngineConfig struct {
	TickInterval       time.Duration
	AutoRepairCooldown time.Duration
	RecoveryDuration   time.Duration
	Clock              func() time.Time
	RNG                func() float64
	BiteRoller         func(RollContext) BiteState

	// OnCatch observes committed catches before the engine publishes their SSE event.
	OnCatch func(ctx context.Context, userID int64, fish FishRoll, qty int64)
}

// StateSnapshot pairs the player and equipped rod with the current fishing state.
type StateSnapshot struct {
	Player repo.Player             `json:"player"`
	Rod    *repo.EquipmentInstance `json:"rod"`
	State  PlayerFishingState      `json:"state"`
}

type StartResult = StateSnapshot

type StopResult = StateSnapshot

type userSlot struct {
	mu         sync.Mutex
	cancel     context.CancelFunc
	active     bool
	timer      context.Context
	references int // guarded by Engine.mu
}

// Engine settles fishing transitions and owns at most one active timer for each user.
type Engine struct {
	repo *repo.FishingRepo
	hub  *sse.Hub
	cfg  EngineConfig

	mu           sync.Mutex
	users        map[int64]*userSlot
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	shutdownOnce sync.Once
	done         chan struct{}
	hookMu       sync.Mutex
}

// NewEngine initializes a fishing engine with defaults for unspecified settings.
func NewEngine(fishingRepo *repo.FishingRepo, hub *sse.Hub, cfg EngineConfig) *Engine {
	if cfg.TickInterval <= 0 {
		cfg.TickInterval = 250 * time.Millisecond
	}
	if cfg.AutoRepairCooldown <= 0 {
		cfg.AutoRepairCooldown = time.Duration(AutoRepairCooldownMs) * time.Millisecond
	}
	if cfg.RecoveryDuration <= 0 {
		cfg.RecoveryDuration = time.Duration(RecoveryMs) * time.Millisecond
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.RNG == nil {
		cfg.RNG = func() float64 {
			var random [8]byte
			rand.Read(random[:])
			return float64(binary.BigEndian.Uint64(random[:])>>11) / (1 << 53)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Engine{
		repo: fishingRepo, hub: hub, cfg: cfg,
		users: make(map[int64]*userSlot), ctx: ctx, cancel: cancel, done: make(chan struct{}),
	}
}

// Start equips a starter rod if necessary and begins or resumes fishing.
func (e *Engine) Start(ctx context.Context, userID int64, depthID string) (*StartResult, error) {
	slot := e.lockUser(userID)
	defer e.unlockUser(userID, slot)
	if err := e.ctx.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	stopCancel := context.AfterFunc(e.ctx, cancel)
	defer cancel()
	defer stopCancel()

	player, err := e.repo.GetPlayerByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	state, document, err := readFishingState(player.State)
	if err != nil {
		return nil, err
	}
	if depthID == "" {
		depthID = state.SelectedDepthID
	}
	if _, ok := GetDepth(depthID); !ok {
		return nil, fmt.Errorf("%w: unknown fishing depth %q", repo.ErrInvalidInput, depthID)
	}
	rod, err := e.repo.EnsureStarterRod(ctx, userID)
	if err != nil {
		return nil, err
	}

	nowMs := e.now().UnixMilli()
	input := repo.FishingCommitInput{}
	var repairDelta map[string]any
	if rod.Durability <= MinDurability || (state.AutoStopped && rod.Durability < AutoRepairThreshold(state.AutoRepairLevel)) {
		materialQty, err := e.repo.GetMaterialQty(ctx, userID, DefaultRepairMaterial)
		if err != nil {
			return nil, err
		}
		repairState := state
		repairState.Running = true
		decision := e.evaluateRepair(repairState, rod, player.Coins, materialQty, nowMs)
		if decision.Triggered && decision.NewDurability > MinDurability {
			state.AutoRepairAtMs = nowMs
			input, repairDelta = repairTransition(rod, decision)
		} else if rod.Durability <= MinDurability {
			if rodBreakable(rod) && rod.Durability <= 0 {
				return nil, ErrRodBroken
			}
			return nil, ErrLowDurability
		}
	}
	if !state.Running {
		pausedMs := max(0, nowMs-state.LastTickAtMs)
		if state.Bite != nil {
			state.Bite.StartedAtMs += pausedMs
		}
		if state.RecoverUntilMs > 0 {
			state.RecoverUntilMs += pausedMs
		}
	}
	durability := rod.Durability
	if input.RodID > 0 {
		durability = input.NewRodDurability
	}
	state.Running = true
	state.ManualResume = true
	state.AutoStopped = false
	state.LowDurability = durability < AutoStopThreshold(state.AutoRepairLevel)
	state.SelectedDepthID = depthID
	state.LastTickAtMs = nowMs
	started := map[string]any{"running": true, "depth_id": depthID, "durability": durability}
	input.LedgerEntries = append(input.LedgerEntries, repo.LedgerEntryInput{EventType: "fishing_started", Delta: started})
	committed, err := e.commit(ctx, player, document, state, input)
	if err != nil {
		return nil, err
	}
	if committed.Rod != nil {
		rod = committed.Rod
		e.publish(&committed.Player, "auto_repair", repairDelta, false)
	}
	e.publish(&committed.Player, "fishing_started", started, false)
	e.startTimer(userID, slot)
	return &StartResult{Player: committed.Player, Rod: rod, State: state}, nil
}

// Stop persists a manual pause and cancels the user's timer after the commit.
func (e *Engine) Stop(ctx context.Context, userID int64) (*StopResult, error) {
	slot := e.lockUser(userID)
	defer e.unlockUser(userID, slot)
	player, state, document, rod, err := e.load(ctx, userID)
	if err != nil {
		return nil, err
	}
	if state.Running {
		nowMs := e.now().UnixMilli()
		e.projectState(&state, rod, nowMs)
		state.LastTickAtMs = nowMs
	}
	state.Running = false
	state.AutoStopped = false
	state.ManualResume = false
	stopped := map[string]any{"running": false, "depth_id": state.SelectedDepthID}
	committed, err := e.commit(ctx, player, document, state, repo.FishingCommitInput{
		LedgerEntries: []repo.LedgerEntryInput{{EventType: "fishing_stopped", Delta: stopped}},
	})
	if err != nil {
		return nil, err
	}
	slot.stopTimer()
	e.publish(&committed.Player, "fishing_stopped", stopped, false)
	return &StopResult{Player: committed.Player, Rod: rod, State: state}, nil
}

// GetState returns a snapshot with progress and tension projected from the persisted timeline.
func (e *Engine) GetState(ctx context.Context, userID int64) (*StateSnapshot, error) {
	slot := e.lockUser(userID)
	defer e.unlockUser(userID, slot)
	player, state, _, rod, err := e.load(ctx, userID)
	if err != nil {
		return nil, err
	}
	if state.Running {
		nowMs := e.now().UnixMilli()
		e.projectState(&state, rod, nowMs)
		state.LastTickAtMs = nowMs
	}
	return &StateSnapshot{Player: *player, Rod: rod, State: state}, nil
}

// TickOnce advances a player's persisted timeline and settles at most one bite.
func (e *Engine) TickOnce(ctx context.Context, userID int64) error {
	slot := e.lockUser(userID)
	defer e.unlockUser(userID, slot)
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := e.ctx.Err(); err != nil {
		return err
	}
	player, state, document, rod, err := e.load(ctx, userID)
	if errors.Is(err, repo.ErrNotFound) {
		slot.stopTimer()
	}
	if err != nil {
		return err
	}
	// A failed settlement repair leaves its timer active to retry against fresh assets.
	if !state.Running && (!slot.active || !state.AutoStopped) {
		slot.stopTimer()
		return nil
	}
	if rod == nil {
		slot.stopTimer()
		return repo.ErrNotFound
	}
	materialQty, err := e.repo.GetMaterialQty(ctx, userID, DefaultRepairMaterial)
	if err != nil {
		return err
	}
	now := e.now()
	nowMs := now.UnixMilli()
	if !state.Running || rod.Durability <= MinDurability {
		return e.handleUnusableRod(ctx, slot, player, document, state, rod, materialQty, nowMs)
	}
	if state.RecoverUntilMs > nowMs {
		return nil // The persisted recovery anchor defines the snapshot tension.
	}
	state.RecoverUntilMs, state.RecoverFrom = 0, 0
	newBite := state.Bite == nil
	if newBite {
		bite := e.rollBite(RollContext{
			UserID: userID, DepthID: state.SelectedDepthID, Rod: rod, Progress: state.Progress, NowMs: nowMs,
		})
		if bite.StartedAtMs == 0 || bite.StartedAtMs > nowMs {
			bite.StartedAtMs = nowMs
		}
		if bite.ChargeAtBite == 0 {
			bite.ChargeAtBite = state.Progress
		}
		bite.ChargeAtBite = min(bite.requiredCharge(), max(0, bite.ChargeAtBite))
		state.Bite = &bite
		state.Phase = phaseReeling
		state.Tension = 0
		state.LastTickAtMs = nowMs
	}
	config := EffectiveRodTension(rod)
	timing := BiteTiming(EffectiveRodEnergy(rod), state.Bite.requiredCharge(), *state.Bite, config)
	if float64(nowMs-state.Bite.StartedAtMs) < timing.ResolvedAtMs {
		if newBite {
			_, err = e.commit(ctx, player, document, state, repo.FishingCommitInput{})
		}
		return err
	}
	return e.settleBite(ctx, slot, player, document, state, rod, materialQty, config, timing, now)
}

func (e *Engine) settleBite(ctx context.Context, slot *userSlot, player *repo.Player, document stateDocument, state PlayerFishingState, rod *repo.EquipmentInstance, materialQty int64, config TensionConfig, timing TimingResult, now time.Time) error {
	bite := *state.Bite
	traitIDs := bite.Fish.Traits
	if traitIDs == nil {
		traitIDs = []string{}
	}
	multiplier, maxTension, delayMs := bite.tensionConfig(config)
	tension := TensionAt(timing.ResolvedAtMs, multiplier, maxTension, config, delayMs)
	if timing.Escaped {
		tension = maxTension
	}
	saw := SawWear(traitIDs, tension, maxTension)
	loss := saw.Loss
	if timing.Escaped {
		loss += max(1, math.Round(bite.LossBase*(1-EffectiveRodResistance(rod))))
	}
	floor := MinDurability
	if rodBreakable(rod) {
		floor = 0
	}
	durability := max(floor, rod.Durability-RoundDurabilityLoss(loss))
	nowMs := now.UnixMilli()
	state.Bite = nil
	state.Phase = phaseCharging
	state.Progress = 0
	state.Tension = 0
	state.LastTickAtMs = nowMs
	event, ledger := "catch", "fishing_catch"
	delta := map[string]any{
		"species_id": bite.Fish.SpeciesID, "name": bite.Fish.Name, "tier": bite.Fish.Tier,
		"traits": traitIDs, "weight_g": bite.Fish.WeightG, "durability": durability,
		"previous_durability": rod.Durability, "durability_loss": rod.Durability - durability,
	}
	input := repo.FishingCommitInput{
		RodID: rod.ID, NewRodDurability: durability, SettleAt: &now,
	}
	var quantity int64
	if timing.Escaped {
		event, ledger = "escape", "fishing_escape"
		state.Tension, state.RecoverFrom = tension, tension
		state.RecoverUntilMs = nowMs + e.recoveryMillis()
	} else {
		var materials map[string]int64
		quantity, materials = e.catchBonuses(rod.Affixes)
		delta["quantity"] = quantity
		if len(materials) > 0 {
			delta["materials"] = materials
		}
		input.AddedItems = []repo.NewInventoryItem{{
			ItemKind: "fish", ItemID: bite.Fish.SpeciesID, Tier: bite.Fish.Tier,
			Traits: traitIDs, WeightG: bite.Fish.WeightG, Quantity: quantity,
		}}
		input.MaterialDeltas = materials
		materialQty += materials[DefaultRepairMaterial]
	}

	state.LowDurability = durability < AutoStopThreshold(state.AutoRepairLevel)
	state.Running = durability > MinDurability && (!state.LowDurability || state.ManualResume)
	if state.AutoRepairLevel > 0 && state.LowDurability {
		// Persist a stopped state until the repair payment and durability are committed.
		state.Running = false
	}
	state.AutoStopped = !state.Running
	input.LedgerEntries = []repo.LedgerEntryInput{{EventType: ledger, Delta: delta}}
	committed, err := e.commit(ctx, player, document, state, input)
	if err != nil {
		return err
	}
	if !timing.Escaped && e.cfg.OnCatch != nil {
		e.cfg.OnCatch(ctx, player.UserID, bite.Fish, quantity)
	}
	e.publish(&committed.Player, event, delta, event == "catch" && bite.Fish.Tier == "legendary")

	decision := e.evaluateRepair(state, committed.Rod, committed.Player.Coins, materialQty, nowMs)
	if decision.Triggered {
		state, err = e.commitRepair(ctx, &committed.Player, document, state, committed.Rod, decision, nowMs)
		if err != nil {
			return err
		}
	}
	if !state.Running {
		slot.stopTimer()
	}
	return nil
}

func (e *Engine) handleUnusableRod(ctx context.Context, slot *userSlot, player *repo.Player, document stateDocument, state PlayerFishingState, rod *repo.EquipmentInstance, materialQty int64, nowMs int64) error {
	decision := e.evaluateRepair(state, rod, player.Coins, materialQty, nowMs)
	if decision.Triggered {
		updated, err := e.commitRepair(ctx, player, document, state, rod, decision, nowMs)
		if err == nil && !updated.Running {
			slot.stopTimer()
		}
		return err
	}
	if !state.Running {
		slot.stopTimer()
		return nil
	}
	state.Running = false
	state.AutoStopped = true
	state.LowDurability = true
	state.LastTickAtMs = nowMs
	delta := map[string]any{"running": false, "auto_stopped": true, "durability": rod.Durability}
	committed, err := e.commit(ctx, player, document, state, repo.FishingCommitInput{
		LedgerEntries: []repo.LedgerEntryInput{{EventType: "fishing_stopped", Delta: delta}},
	})
	if err != nil {
		return err
	}
	slot.stopTimer()
	e.publish(&committed.Player, "fishing_stopped", delta, false)
	return nil
}

func (e *Engine) evaluateRepair(state PlayerFishingState, rod *repo.EquipmentInstance, coins, materialQty, nowMs int64) AutoRepairDecision {
	breakable := rodBreakable(rod)
	return EvaluateAutoRepair(AutoRepairInput{
		Durability: rod.Durability, MaxDurability: rod.MaxDurability,
		Breakable: breakable, Broken: breakable && rod.Durability <= 0,
		AutoRepairLevel: state.AutoRepairLevel, MaterialQty: materialQty, Coins: coins,
		LastAutoRepairAtMs: state.AutoRepairAtMs, NowMs: nowMs,
		CooldownMs:        max(1, e.cfg.AutoRepairCooldown.Milliseconds()),
		AllowCoinFallback: state.AllowCoinFallback, CoinCost: autoRepairCoinCost,
		Running: state.Running, AutoStopped: state.AutoStopped,
	})
}

func repairTransition(rod *repo.EquipmentInstance, decision AutoRepairDecision) (repo.FishingCommitInput, map[string]any) {
	delta := map[string]any{
		"durability": decision.NewDurability, "previous_durability": rod.Durability,
		"restored": decision.Restored, "material_used": decision.MaterialUsed, "coins_used": decision.CoinsUsed,
		"cleared_broken": decision.ClearedBroken,
	}
	input := repo.FishingCommitInput{
		RodID: rod.ID, NewRodDurability: decision.NewDurability, CoinsDelta: -decision.CoinsUsed,
		LedgerEntries: []repo.LedgerEntryInput{{EventType: "rod_auto_repair", Delta: delta}},
	}
	if decision.MaterialUsed > 0 {
		input.MaterialDeltas = map[string]int64{DefaultRepairMaterial: -decision.MaterialUsed}
	}
	return input, delta
}

func (e *Engine) commitRepair(ctx context.Context, player *repo.Player, document stateDocument, state PlayerFishingState, rod *repo.EquipmentInstance, decision AutoRepairDecision, nowMs int64) (PlayerFishingState, error) {
	updated := state
	updated.AutoRepairAtMs = nowMs
	updated.LowDurability = decision.LowDurability
	updated.Running = decision.NewRunning
	updated.AutoStopped = decision.NewAutoStopped
	updated.ManualResume = state.ManualResume && decision.LowDurability
	input, delta := repairTransition(rod, decision)
	committed, err := e.commit(ctx, player, document, updated, input)
	if err != nil {
		return state, err
	}
	e.publish(&committed.Player, "auto_repair", delta, false)
	return updated, nil
}

func (e *Engine) catchBonuses(affixes []repo.Affix) (int64, map[string]int64) {
	bonuses := AggregateAffixes(affixes)
	e.hookMu.Lock()
	defer e.hookMu.Unlock()
	var quantity int64 = 1
	if bonuses.DoubleCatchChance > 0 && e.cfg.RNG() < bonuses.DoubleCatchChance {
		quantity++
	}
	if bonuses.MaterialBonus <= 0 || !(e.cfg.RNG() < min(1, bonuses.MaterialBonus)) {
		return quantity, nil
	}
	material := DefaultRepairMaterial
	if e.cfg.RNG() < 0.5 {
		material = "浮木纤维"
	}
	amount := 1 + int64(math.Floor(min(bonuses.MaterialBonus, math.MaxInt32-1)))
	return quantity, map[string]int64{material: amount}
}

func (e *Engine) rollBite(ctx RollContext) BiteState {
	e.hookMu.Lock()
	defer e.hookMu.Unlock()
	if e.cfg.BiteRoller != nil {
		return e.cfg.BiteRoller(ctx)
	}
	return RollBite(ctx.DepthID, ctx.Rod, ctx.Progress, ctx.NowMs, e.cfg.RNG)
}

func (e *Engine) now() time.Time {
	e.hookMu.Lock()
	defer e.hookMu.Unlock()
	return e.cfg.Clock()
}

func (e *Engine) recoveryMillis() int64 {
	return max(1, e.cfg.RecoveryDuration.Milliseconds())
}

func (e *Engine) projectState(state *PlayerFishingState, rod *repo.EquipmentInstance, nowMs int64) {
	if state.RecoverUntilMs > 0 {
		fraction := float64(state.RecoverUntilMs-nowMs) / float64(e.recoveryMillis())
		state.Tension = state.RecoverFrom * min(1, max(0, fraction))
		if state.RecoverUntilMs <= nowMs {
			state.RecoverUntilMs, state.RecoverFrom = 0, 0
		}
		return
	}
	if state.Bite == nil || rod == nil {
		return
	}
	bite := *state.Bite
	config := EffectiveRodTension(rod)
	energy := EffectiveRodEnergy(rod)
	required := bite.requiredCharge()
	timing := BiteTiming(energy, required, bite, config)
	elapsed := min(timing.ResolvedAtMs, max(0, float64(nowMs-bite.StartedAtMs)))
	multiplier, maxTension, delayMs := bite.tensionConfig(config)
	state.Tension = TensionAt(elapsed, multiplier, maxTension, config, delayMs)
	state.Progress = min(required, bite.ChargeAtBite+elapsed*energy*bite.chargeRate()/1000)
}

func rodBreakable(rod *repo.EquipmentInstance) bool {
	template, _ := rodModifiers(rod)
	return template.Breakable
}

func (e *Engine) load(ctx context.Context, userID int64) (*repo.Player, PlayerFishingState, stateDocument, *repo.EquipmentInstance, error) {
	player, err := e.repo.GetPlayerByID(ctx, userID)
	if err != nil {
		return nil, PlayerFishingState{}, stateDocument{}, nil, err
	}
	state, document, err := readFishingState(player.State)
	if err != nil {
		return nil, PlayerFishingState{}, stateDocument{}, nil, err
	}
	rod, err := e.repo.GetEquippedRod(ctx, userID)
	if errors.Is(err, repo.ErrNotFound) {
		err = nil
	}
	return player, state, document, rod, err
}

func (e *Engine) commit(ctx context.Context, player *repo.Player, document stateDocument, state PlayerFishingState, input repo.FishingCommitInput) (*repo.FishingCommitResult, error) {
	encoded, err := document.encode(state)
	if err != nil {
		return nil, err
	}
	input.UserID, input.ExpectedVersion = player.UserID, player.Version
	input.NewState = encoded
	return e.repo.CommitFishingTransition(ctx, input)
}

func (e *Engine) publish(player *repo.Player, event string, payload map[string]any, global bool) {
	if e.hub == nil {
		return
	}
	payload["inv_rev"] = player.InvRev
	if _, err := e.hub.PublishUser(player.UserID, event, player.InvRev, player.Version, payload); err != nil {
		slog.Warn("publish user fishing event", "event", event, "user_id", player.UserID, "error", err)
	}
	if global {
		if _, err := e.hub.PublishGlobal(player.UserID, event, player.InvRev, player.Version, payload); err != nil {
			slog.Warn("publish global fishing event", "event", event, "user_id", player.UserID, "error", err)
		}
	}
}

type stateDocument struct {
	root    map[string]json.RawMessage
	fishing map[string]json.RawMessage
}

func readFishingState(raw json.RawMessage) (PlayerFishingState, stateDocument, error) {
	state := PlayerFishingState{SelectedDepthID: "shore", Phase: phaseCharging}
	document := stateDocument{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &document.root); err != nil {
			return state, document, fmt.Errorf("decode player state: %w", err)
		}
	}
	var fields map[string]json.RawMessage
	if nested, ok := document.root["fishing"]; ok {
		if err := json.Unmarshal(nested, &document.fishing); err != nil {
			return state, document, fmt.Errorf("decode fishing state: %w", err)
		}
		fields = document.fishing
	} else if hasLegacyFishingFields(document.root) {
		fields = document.root
	}
	if len(fields) == 0 {
		return state, document, nil
	}
	aliases := map[string]string{
		"selecteddepthid": "selected_depth_id", "recoveruntilms": "recover_until_ms",
		"recoveruntil": "recover_until_ms", "recoverfrom": "recover_from",
		"autorepairlevel": "auto_repair_level", "autorepairatms": "auto_repair_at_ms",
		"autorepairat": "auto_repair_at_ms", "lowdurability": "low_durability",
		"autostopped": "auto_stopped", "manualresume": "manual_resume",
		"lasttickatms": "last_tick_at_ms", "lasttickat": "last_tick_at_ms",
		"allowcoinfallback": "allow_coin_fallback",
	}
	normalized := make(map[string]json.RawMessage, len(fields))
	for key, value := range fields {
		if canonical, ok := aliases[strings.ToLower(key)]; ok {
			if _, exists := fields[canonical]; !exists {
				normalized[canonical] = value
			}
			continue
		}
		normalized[key] = value
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return state, document, fmt.Errorf("normalize fishing state: %w", err)
	}
	if err := json.Unmarshal(encoded, &state); err != nil {
		return state, document, fmt.Errorf("decode fishing state: %w", err)
	}
	if state.SelectedDepthID == "" {
		state.SelectedDepthID = "shore"
	}
	state.Phase = phaseCharging
	if state.Bite != nil {
		state.Phase = phaseReeling
	}
	return state, document, nil
}

func hasLegacyFishingFields(fields map[string]json.RawMessage) bool {
	for key, value := range fields {
		switch strings.ToLower(strings.ReplaceAll(key, "_", "")) {
		case "selecteddepthid", "autorepairlevel", "recoveruntilms", "recoveruntil", "lowdurability", "allowcoinfallback":
			return true
		case "phase":
			var phase string
			if json.Unmarshal(value, &phase) == nil && (phase == phaseCharging || phase == phaseReeling) {
				return true
			}
		}
	}
	return false
}

func (d stateDocument) encode(state PlayerFishingState) (json.RawMessage, error) {
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("encode fishing state: %w", err)
	}
	if err := json.Unmarshal(encoded, &d.fishing); err != nil {
		return nil, fmt.Errorf("merge fishing state: %w", err)
	}
	encoded, err = json.Marshal(d.fishing)
	if err != nil {
		return nil, fmt.Errorf("encode merged fishing state: %w", err)
	}
	if d.root == nil {
		d.root = make(map[string]json.RawMessage, 1)
	}
	d.root["fishing"] = encoded
	return json.Marshal(d.root)
}

func (e *Engine) lockUser(userID int64) *userSlot {
	e.mu.Lock()
	slot := e.users[userID]
	if slot == nil {
		slot = &userSlot{}
		e.users[userID] = slot
	}
	slot.references++
	e.mu.Unlock()
	slot.mu.Lock()
	return slot
}

func (e *Engine) unlockUser(userID int64, slot *userSlot) {
	e.mu.Lock()
	slot.references--
	if !slot.active && slot.references == 0 {
		delete(e.users, userID)
	}
	e.mu.Unlock()
	slot.mu.Unlock()
}

func (e *Engine) startTimer(userID int64, slot *userSlot) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if slot.active || e.ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithCancel(e.ctx)
	slot.timer, slot.cancel, slot.active = ctx, cancel, true
	e.wg.Add(1)
	go e.runTimer(ctx, userID, slot)
}

func (slot *userSlot) stopTimer() {
	if slot.active {
		slot.cancel()
		slot.cancel, slot.timer, slot.active = nil, nil, false
	}
}

func (e *Engine) runTimer(ctx context.Context, userID int64, slot *userSlot) {
	defer e.wg.Done()
	defer func() {
		slot.mu.Lock()
		defer slot.mu.Unlock()
		if slot.timer == ctx {
			slot.stopTimer()
			e.mu.Lock()
			if slot.references == 0 {
				delete(e.users, userID)
			}
			e.mu.Unlock()
		}
	}()
	ticker := time.NewTicker(e.cfg.TickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := e.TickOnce(ctx, userID); err != nil && ctx.Err() == nil {
				slog.Warn("tick fishing", "user_id", userID, "error", err)
			}
		}
	}
}

// Shutdown cancels the timers and waits for workers up to the caller's deadline.
func (e *Engine) Shutdown(ctx context.Context) {
	e.shutdownOnce.Do(func() {
		e.mu.Lock()
		e.cancel()
		e.mu.Unlock()
		go func() {
			e.wg.Wait()
			close(e.done)
		}()
	})
	select {
	case <-e.done:
	case <-ctx.Done():
	}
}
