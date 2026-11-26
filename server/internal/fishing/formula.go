package fishing

import (
	"maps"
	"math"
	"slices"

	"deepmarket/server/internal/repo"
)

const (
	EnergyPerCatch                      = 10000.0
	BaseEnergyPerSecond                 = 1000.0
	LowDurabilityThreshold              = 10
	MinDurability                       = 1
	RecoveryMs                    int64 = 5000
	AutoRepairCooldownMs          int64 = 8000
	SawThresholdBase                    = 0.8
	DefaultRepairMaterial               = "深蓝晶片"
	DefaultRepairAmount                 = 50
	DefaultRepairCost             int64 = 1
	DefaultAutoRepairRestoreRatio       = 0.9
	AutoRepairThresholdBase             = 10
	AutoRepairThresholdStep             = 10
)

// TraitEffect modifies one part of the bite calculation.
type TraitEffect struct {
	Type  string
	Mode  string
	Value float64
}

// TraitDef defines a catch trait and its contribution to bite selection.
type TraitDef struct {
	ID         string
	Label      string
	BiteChance float64
	Effects    []TraitEffect
}

var traits = [...]TraitDef{
	{"swift", "迅游", 1.15, []TraitEffect{{"tensionRate", "multiply", 1.12}}},
	{"armored", "重甲", 1.35, []TraitEffect{{"loss", "add", 4}, {"maxTension", "multiply", 0.94}}},
	{"luminous", "辉光", 1.50, []TraitEffect{{"chargeRate", "multiply", 0.94}}},
	{"heavy", "巨型", 1.60, []TraitEffect{{"loss", "add", 6}, {"sawLoss", "multiply", 3}}},
	{"ancient", "远古", 1.75, []TraitEffect{{"maxTension", "multiply", 0.90}, {"tensionDelay", "add", 180}}},
	{"surge", "深涌", 1.90, []TraitEffect{{"tensionRate", "multiply", 1.08}, {"sawThreshold", "add", -0.05}}},
	{"abyssal", "渊印", 2.05, []TraitEffect{{"tensionRate", "multiply", 1.12}, {"sawLoss", "multiply", 4}}},
	{"prismatic", "棱彩", 2.30, []TraitEffect{{"maxTension", "multiply", 0.82}, {"chargeRate", "multiply", 0.90}, {"sawThreshold", "add", -0.10}}},
}

// FishDef gives a species its weight in the depth's pool and its base rarity.
type FishDef struct {
	SpeciesID  string
	Name       string
	BaseWeight float64
	Rarity     int
}

// DepthDef gives a fishing area its pressure, trait distribution, and species pool.
type DepthDef struct {
	ID            string
	Pressure      float64
	TraitCountMin int
	TraitCountMax int
	Value         float64
	TraitWeights  map[string]float64
	FishPool      []FishDef
}

func traitWeights(swift, armored, luminous, heavy, ancient, surge, abyssal, prismatic float64) map[string]float64 {
	return map[string]float64{
		"swift": swift, "armored": armored, "luminous": luminous, "heavy": heavy,
		"ancient": ancient, "surge": surge, "abyssal": abyssal, "prismatic": prismatic,
	}
}

var depths = map[string]DepthDef{
	"shore": {"shore", 1.22, 1, 2, 1, traitWeights(1, 1, 1, 0, 0, 0, 0, 0), []FishDef{
		{"jack", "银鳞鲹", 100, 6}, {"bream", "暮光鲷", 58, 12}, {"tuna", "蓝脊鲔", 24, 22}, {"marlin", "星痕旗鱼", 7, 34},
	}},
	"shelf": {"shelf", 1.45, 2, 3, 1.4, traitWeights(2, 2, 2, 1, 0, 0, 0, 0), []FishDef{
		{"bream", "暮光鲷", 60, 12}, {"tuna", "蓝脊鲔", 36, 22}, {"grouper", "玄甲石斑", 18, 30}, {"eel", "虹膜鳗", 8, 40},
	}},
	"open": {"open", 1.79, 3, 4, 2.1, traitWeights(3, 3, 3, 2, 1, 1, 0, 0), []FishDef{
		{"tuna", "蓝脊鲔", 40, 22}, {"grouper", "玄甲石斑", 26, 32}, {"eel", "虹膜鳗", 15, 42}, {"marlin", "星痕旗鱼", 7, 52}, {"lantern", "深渊灯笼鱼", 3, 62},
	}},
	"deep": {"deep", 2.29, 4, 5, 3.3, traitWeights(4, 4, 4, 3, 2, 2, 1, 0), []FishDef{
		{"grouper", "玄甲石斑", 30, 34}, {"eel", "虹膜鳗", 20, 44}, {"marlin", "星痕旗鱼", 12, 54}, {"lantern", "深渊灯笼鱼", 6, 64}, {"spear", "苍白矛吻鱼", 2, 74},
	}},
	"rift": {"rift", 2.32, 5, 6, 4.2, traitWeights(5, 5, 5, 4, 3, 3, 2, 1), []FishDef{
		{"eel", "虹膜鳗", 22, 46}, {"marlin", "星痕旗鱼", 16, 54}, {"lantern", "深渊灯笼鱼", 12, 62}, {"ray", "渊影鳐", 7, 70}, {"angler", "熔核鮟鱇", 3, 78},
	}},
	"abyss": {"abyss", 2.96, 5, 6, 5.2, traitWeights(6, 6, 6, 5, 4, 4, 3, 2), []FishDef{
		{"lantern", "深渊灯笼鱼", 22, 60}, {"ray", "渊影鳐", 16, 70}, {"spear", "苍白矛吻鱼", 11, 74}, {"angler", "熔核鮟鱇", 7, 78}, {"jelly", "静海幽灵水母", 3, 86},
	}},
}

// GetDepth returns a copy of the configured depth and its roll tables.
func GetDepth(id string) (DepthDef, bool) {
	depth, ok := depths[id]
	depth.TraitWeights = maps.Clone(depth.TraitWeights)
	depth.FishPool = slices.Clone(depth.FishPool)
	return depth, ok
}

// TensionConfig controls the tension limit, acceleration, and escape damage.
type TensionConfig struct {
	MaxTension float64
	AccelMs    float64
	MaxRate    float64
	BaseLoss   float64
	DelayMs    float64
}

// RodTemplate contains the base stats shared by instances of a rod.
type RodTemplate struct {
	ID              string
	MaxDurability   int
	Resistance      float64
	EnergyPerSecond float64
	Breakable       bool
	TensionConfig   TensionConfig
}

var rods = map[string]RodTemplate{
	"tide":   {"tide", 1000, 0.08, BaseEnergyPerSecond, false, TensionConfig{1200, 1000, 87.5, 10, 0}},
	"azure":  {"azure", 1500, 0.18, 2000, true, TensionConfig{1380, 1000, 134, 10, 0}},
	"abyss":  {"abyss", 2000, 0.33, 2000, true, TensionConfig{1450, 1000, 82, 10, 0}},
	"shadow": {"shadow", 2200, 0.36, 2300, true, TensionConfig{1450, 1000, 82, 10, 0}},
}

// GetRodTemplate returns the base stats for the given template ID.
func GetRodTemplate(id string) (RodTemplate, bool) {
	template, ok := rods[id]
	return template, ok
}

// AffixBonuses combines all modifiers on one equipment instance.
type AffixBonuses struct {
	SpeedBonus        float64
	TechniqueBonus    float64
	RarityBonus       float64
	MaterialBonus     float64
	SizeBonus         float64
	DoubleCatchChance float64
}

// AggregateAffixes sums matching affixes and bounds the double-catch chance.
func AggregateAffixes(affixes []repo.Affix) AffixBonuses {
	var bonuses AffixBonuses
	for _, affix := range affixes {
		if math.IsNaN(affix.Value) || math.IsInf(affix.Value, 0) {
			continue
		}
		switch affix.Type {
		case "speed":
			bonuses.SpeedBonus += affix.Value
		case "technique":
			bonuses.TechniqueBonus += affix.Value
		case "rarity":
			bonuses.RarityBonus += affix.Value
		case "material":
			bonuses.MaterialBonus += affix.Value
		case "size":
			bonuses.SizeBonus += affix.Value
		case "doubleCatch":
			bonuses.DoubleCatchChance += affix.Value
		}
	}
	bonuses.DoubleCatchChance = min(0.75, max(0, bonuses.DoubleCatchChance))
	return bonuses
}

func rodModifiers(rod *repo.EquipmentInstance) (RodTemplate, AffixBonuses) {
	if rod == nil {
		return rods["tide"], AffixBonuses{}
	}
	template, ok := GetRodTemplate(rod.TemplateID)
	if !ok {
		template = rods["tide"]
	}
	return template, AggregateAffixes(rod.Affixes)
}

// EffectiveRodEnergy returns the rod's charge per second after the speed affix.
func EffectiveRodEnergy(rod *repo.EquipmentInstance) float64 {
	template, bonuses := rodModifiers(rod)
	return template.EnergyPerSecond * max(0.1, 1+bonuses.SpeedBonus)
}

// EffectiveRodResistance returns the fraction of base escape damage prevented.
func EffectiveRodResistance(rod *repo.EquipmentInstance) float64 {
	template, bonuses := rodModifiers(rod)
	return min(0.95, max(0, template.Resistance+min(0.25, bonuses.TechniqueBonus*0.2)))
}

// DurabilityTensionFactor interpolates the maximum tension by remaining durability.
func DurabilityTensionFactor(ratio float64) float64 {
	switch {
	case math.IsNaN(ratio), ratio >= 0.8:
		return 1.2
	case ratio >= 0.6:
		return 1 + (ratio - 0.6)
	case ratio >= 0.2:
		return 0.8 + (ratio-0.2)*0.5
	default:
		return 0.8
	}
}

// EffectiveRodTension applies durability and technique to the rod's tension limit.
func EffectiveRodTension(rod *repo.EquipmentInstance) TensionConfig {
	template, bonuses := rodModifiers(rod)
	ratio := 1.0
	if rod != nil {
		ratio = float64(rod.Durability) / float64(max(1, rod.MaxDurability))
	}
	cfg := template.TensionConfig
	cfg.MaxTension = max(1, math.Round(cfg.MaxTension*DurabilityTensionFactor(ratio))*(1+bonuses.TechniqueBonus))
	return cfg
}

// TensionAt integrates a linear ramp in tension rate, then a steady rate.
func TensionAt(elapsedMs, multiplier, maxTension float64, cfg TensionConfig, delayMs float64) float64 {
	seconds := max(0, elapsedMs-max(0, delayMs)) / 1000
	accel := max(0.001, cfg.AccelMs/1000)
	rate := max(0, cfg.MaxRate) * max(0, multiplier)
	ramp := min(seconds, accel)
	points := 0.5*rate*ramp*ramp/accel + rate*(seconds-ramp)
	return min(max(1, maxTension), points)
}

// TensionFillMs inverts the tension curve to find the escape time.
func TensionFillMs(multiplier, maxTension float64, cfg TensionConfig, delayMs float64) float64 {
	accel := max(0.001, cfg.AccelMs/1000)
	rate := max(0.001, cfg.MaxRate) * max(0.0001, multiplier)
	limit := max(1, maxTension)
	seconds := limit/rate + 0.5*accel
	if limit <= 0.5*rate*accel {
		seconds = math.Sqrt(2 * limit * accel / rate)
	}
	return max(0, delayMs) + seconds*1000
}

// FishRoll is the authoritative fish payload selected at the start of a bite.
type FishRoll struct {
	SpeciesID string   `json:"species_id"`
	Name      string   `json:"name"`
	Tier      string   `json:"tier"`
	Traits    []string `json:"traits"`
	WeightG   int      `json:"weight_g"`
}

// BiteState preserves the charge and fish modifiers needed to settle a bite.
type BiteState struct {
	StartedAtMs    int64    `json:"started_at_ms"`
	Fish           FishRoll `json:"fish"`
	ChargeAtBite   float64  `json:"charge_at_bite"`
	ChargeRequired float64  `json:"charge_required"`
	ChargeRate     float64  `json:"charge_rate"`
	TensionRate    float64  `json:"tension_rate"`
	MaxTension     float64  `json:"max_tension"`
	TensionDelayMs float64  `json:"tension_delay_ms"`
	LossBase       float64  `json:"loss_base"`
}

func (b BiteState) requiredCharge() float64 {
	if b.ChargeRequired > 0 {
		return b.ChargeRequired
	}
	return EnergyPerCatch
}

func (b BiteState) chargeRate() float64 {
	if b.ChargeRate > 0 {
		return b.ChargeRate
	}
	return 1
}

func (b BiteState) tensionConfig(cfg TensionConfig) (rate, limit, delay float64) {
	rate = b.TensionRate
	if rate <= 0 {
		rate = 1
	}
	limit = b.MaxTension
	if limit <= 0 {
		limit = cfg.MaxTension
	}
	return rate, max(1, limit), max(0, cfg.DelayMs+b.TensionDelayMs)
}

// TimingResult gives the time from bite start to each bar filling and to settlement.
type TimingResult struct {
	ChargeMs     float64
	FillMs       float64
	ResolvedAtMs float64
	Escaped      bool
}

// BiteTiming resolves the race between charge and tension, giving tension the tie.
func BiteTiming(energyPerSecond, chargeRequired float64, bite BiteState, rodTension TensionConfig) TimingResult {
	chargeMs := max(1, max(0, chargeRequired-bite.ChargeAtBite)/(energyPerSecond*bite.chargeRate())*1000)
	rate, limit, delay := bite.tensionConfig(rodTension)
	fillMs := TensionFillMs(rate, limit, rodTension, delay)
	return TimingResult{
		ChargeMs: chargeMs, FillMs: fillMs,
		ResolvedAtMs: min(fillMs, chargeMs), Escaped: fillMs <= chargeMs,
	}
}

// SawWearResult describes wear caused by saw-loss traits above the threshold.
type SawWearResult struct {
	Threshold  float64
	Multiplier float64
	Excess     float64
	Loss       float64
}

// SawWear combines the selected traits and rounds additional wear to tenths.
func SawWear(traitIDs []string, tension, maxTension float64) SawWearResult {
	threshold, multiplier := SawThresholdBase, 1.0
	active := false
	for _, id := range traitIDs {
		for _, trait := range traits {
			if trait.ID != id {
				continue
			}
			for _, effect := range trait.Effects {
				switch effect.Type {
				case "sawThreshold":
					threshold += effect.Value
				case "sawLoss":
					multiplier *= effect.Value
					active = true
				}
			}
			break
		}
	}
	if !active {
		multiplier = 0
	}
	threshold = min(SawThresholdBase, max(0, threshold))
	excess := max(0, tension-threshold*max(1, maxTension))
	return SawWearResult{
		Threshold: threshold, Multiplier: multiplier, Excess: excess,
		Loss: math.Round((excess/100)*multiplier*10) / 10,
	}
}

// RoundDurabilityLoss converts positive wear into at least one durability point.
func RoundDurabilityLoss(raw float64) int {
	if raw <= 0 || math.IsNaN(raw) {
		return 0
	}
	return int(max(1, math.Round(raw)))
}

// AutoRepairThreshold returns the durability below which the given level repairs.
func AutoRepairThreshold(level int) int {
	if level <= 0 {
		return 0
	}
	return AutoRepairThresholdBase + min(level, (math.MaxInt-AutoRepairThresholdBase)/AutoRepairThresholdStep)*AutoRepairThresholdStep
}

// AutoStopThreshold matches the repair threshold when auto-repair is enabled.
func AutoStopThreshold(autoRepairLevel int) int {
	if autoRepairLevel > 0 {
		return AutoRepairThreshold(autoRepairLevel)
	}
	return LowDurabilityThreshold
}

// TierFromRarity maps rarity to a tier and applies at most one affix promotion.
func TierFromRarity(rarity int, rarityBonus, roll float64) string {
	tiers := [...]string{"normal", "rare", "epic", "legendary"}
	tier := 0
	switch {
	case rarity >= 70:
		tier = 3
	case rarity >= 45:
		tier = 2
	case rarity >= 25:
		tier = 1
	}
	if rarityBonus > 0 && roll < min(0.5, rarityBonus*0.25) {
		tier = min(tier+1, len(tiers)-1)
	}
	return tiers[tier]
}

// RollBite samples a trait combination for each candidate, then weighs the fish
// by species rarity and the combination's bite chance. rng returns values in [0, 1).
func RollBite(depthID string, rod *repo.EquipmentInstance, progress float64, nowMs int64, rng func() float64) BiteState {
	depth, ok := depths[depthID]
	if !ok {
		depth = depths["shore"]
	}
	_, bonuses := rodModifiers(rod)
	count := depth.TraitCountMin + int(rng()*float64(depth.TraitCountMax-depth.TraitCountMin+1))
	type candidate struct {
		fish   FishDef
		traits []TraitDef
		weight float64
	}
	candidates := make([]candidate, 0, len(depth.FishPool))
	var total float64
	for _, fish := range depth.FishPool {
		picked := pickTraits(depth.TraitWeights, count, rng)
		traitChance := 1.0
		for _, trait := range picked {
			traitChance *= trait.BiteChance
		}
		rarity := float64(fish.Rarity)
		rarityBoost := 1 + max(0, bonuses.RarityBonus)*(rarity/100)
		weight := fish.BaseWeight * math.Exp2(-rarity/25) * traitChance * rarityBoost
		candidates = append(candidates, candidate{fish, picked, weight})
		total += weight
	}
	roll := rng() * total
	chosen := candidates[len(candidates)-1]
	for _, c := range candidates {
		roll -= c.weight
		if roll < 0 {
			chosen = c
			break
		}
	}

	traitIDs := make([]string, len(chosen.traits))
	for i, trait := range chosen.traits {
		traitIDs[i] = trait.ID
	}
	baseWeightG := math.Round((depth.Value*2+rng()*4)*10) * 100
	weightG := min(math.MaxInt32, max(1, math.Round(baseWeightG*(1+bonuses.SizeBonus))))
	cfg := EffectiveRodTension(rod)
	return BiteState{
		StartedAtMs: nowMs,
		Fish: FishRoll{
			SpeciesID: chosen.fish.SpeciesID,
			Name:      chosen.fish.Name,
			Tier:      TierFromRarity(chosen.fish.Rarity, bonuses.RarityBonus, rng()),
			Traits:    traitIDs,
			WeightG:   int(weightG),
		},
		ChargeAtBite:   min(EnergyPerCatch, max(0, progress)),
		ChargeRequired: EnergyPerCatch,
		ChargeRate:     min(5, max(0.05, aggregateTraitEffect(chosen.traits, "chargeRate", 1))),
		TensionRate:    max(0.05, aggregateTraitEffect(chosen.traits, "tensionRate", 1)*depth.Pressure),
		MaxTension:     max(10, aggregateTraitEffect(chosen.traits, "maxTension", cfg.MaxTension)),
		TensionDelayMs: aggregateTraitEffect(chosen.traits, "tensionDelay", 0),
		LossBase:       max(0, aggregateTraitEffect(chosen.traits, "loss", cfg.BaseLoss)),
	}
}

func pickTraits(weights map[string]float64, count int, rng func() float64) []TraitDef {
	var remaining [len(traits)]float64
	var total float64
	for i, trait := range traits {
		remaining[i] = weights[trait.ID]
		total += remaining[i]
	}
	picked := make([]TraitDef, 0, count)
	for len(picked) < count && total > 0 {
		roll := rng() * total
		chosen := 0
		for i, weight := range remaining {
			if weight == 0 {
				continue
			}
			chosen = i
			if roll < weight {
				break
			}
			roll -= weight
		}
		picked = append(picked, traits[chosen])
		total -= remaining[chosen]
		remaining[chosen] = 0
	}
	return picked
}

func aggregateTraitEffect(picked []TraitDef, kind string, base float64) float64 {
	multiplier := 1.0
	for _, trait := range picked {
		for _, effect := range trait.Effects {
			if effect.Type != kind {
				continue
			}
			if effect.Mode == "multiply" {
				multiplier *= effect.Value
			} else {
				base += effect.Value
			}
		}
	}
	return base * multiplier
}

// AutoRepairInput contains the resources and fishing state available for repair.
type AutoRepairInput struct {
	Durability         int
	MaxDurability      int
	Breakable          bool
	Broken             bool
	AutoRepairLevel    int
	MaterialQty        int64
	Coins              int64
	LastAutoRepairAtMs int64
	NowMs              int64
	CooldownMs         int64
	AllowCoinFallback  bool
	CoinCost           int64
	Running            bool
	AutoStopped        bool
}

// AutoRepairDecision specifies the costs and state to commit together.
type AutoRepairDecision struct {
	Triggered      bool
	NewDurability  int
	Restored       int
	MaterialUsed   int64
	CoinsUsed      int64
	NewRunning     bool
	NewAutoStopped bool
	LowDurability  bool
	ClearedBroken  bool
}

// EvaluateAutoRepair checks the repair gate, preferring material to coin fallback.
func EvaluateAutoRepair(in AutoRepairInput) AutoRepairDecision {
	stopThreshold := AutoStopThreshold(in.AutoRepairLevel)
	decision := AutoRepairDecision{
		NewDurability: in.Durability, NewRunning: in.Running, NewAutoStopped: in.AutoStopped,
		LowDurability: in.Durability < stopThreshold,
	}
	threshold := AutoRepairThreshold(in.AutoRepairLevel)
	cooldown := in.CooldownMs
	if cooldown <= 0 {
		cooldown = AutoRepairCooldownMs
	}
	if threshold <= 0 || in.Durability >= threshold || !(in.Running || in.AutoStopped || in.Broken) ||
		in.NowMs-in.LastAutoRepairAtMs < cooldown {
		return decision
	}
	switch {
	case in.MaterialQty >= DefaultRepairCost:
		decision.MaterialUsed = DefaultRepairCost
	case in.AllowCoinFallback && in.CoinCost > 0 && in.Coins >= in.CoinCost:
		decision.CoinsUsed = in.CoinCost
	default:
		return decision
	}
	decision.Triggered = true
	decision.Restored = max(1, int(math.Round(DefaultRepairAmount*DefaultAutoRepairRestoreRatio)))
	decision.NewDurability = in.Durability + decision.Restored
	decision.LowDurability = decision.NewDurability < stopThreshold
	decision.ClearedBroken = in.Broken && decision.NewDurability > 0
	decision.NewRunning = decision.NewDurability > 0 && !decision.LowDurability
	decision.NewAutoStopped = decision.LowDurability
	return decision
}
