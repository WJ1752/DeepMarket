package repo

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"deepmarket/server/internal/lottery"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrAlreadyRevealed     = errors.New("scratch card already revealed")
	ErrBatchAlreadyDrawn   = errors.New("lottery batch already drawn")
	ErrInsufficientTickets = errors.New("insufficient blank tickets")
)

const lotteryDrawLock int64 = 0x4c4f545444524157

type LotteryBatch struct {
	lottery.Batch
	Drawn bool `json:"drawn"`
}

type LotteryDraw struct {
	BatchID        string    `json:"batch_id"`
	PoolID         string    `json:"pool_id"`
	WinningNumbers []int     `json:"winning_numbers"`
	DrawSeedHash   string    `json:"draw_seed_hash"`
	DrawnAt        time.Time `json:"drawn_at"`
}

type LotteryStatus struct {
	CurrentBatch LotteryBatch      `json:"current_batch"`
	RecentDraws  []LotteryDraw     `json:"recent_draws"`
	BlankTickets int64             `json:"blank_tickets"`
	Tickets      []lottery.Ticket  `json:"tickets"`
	Pools        []lottery.PoolDef `json:"pools"`
}

type CraftResult struct {
	Tickets      []lottery.Ticket `json:"tickets"`
	BlankTickets int64            `json:"blank_tickets"`
	Player       Player           `json:"player"`
	Replayed     bool             `json:"replayed"`
}

type ClaimedTicket struct {
	lottery.Ticket
	Hits   int                 `json:"hits"`
	Prizes []lottery.PrizeItem `json:"prizes"`
}

type ClaimResult struct {
	Claimed  int             `json:"claimed"`
	Tickets  []ClaimedTicket `json:"tickets"`
	Player   Player          `json:"player"`
	Replayed bool            `json:"replayed"`
}

type BuyScratchResult struct {
	Card     lottery.PublicScratchCard `json:"card"`
	Player   Player                    `json:"player"`
	Replayed bool                      `json:"replayed"`
}

type RevealScratchResult struct {
	Card     lottery.PublicScratchCard `json:"card"`
	Player   Player                    `json:"player"`
	Replayed bool                      `json:"replayed"`
}

// LotteryRepo manages batch draws, numbered tickets, and scratch cards.
type LotteryRepo struct {
	pool          *pgxpool.Pool
	rodDurability func(string) (int, bool)
}

func NewLotteryRepo(pool *pgxpool.Pool) *LotteryRepo {
	return &LotteryRepo{pool: pool, rodDurability: func(id string) (int, bool) {
		switch id {
		case "azure":
			return 1500, true
		case "abyss":
			return 2000, true
		default:
			return 0, false
		}
	}}
}

// SetRodDurabilityLookup connects the fishing template registry during startup.
func (r *LotteryRepo) SetRodDurabilityLookup(lookup func(string) (int, bool)) {
	r.rodDurability = lookup
}

const insertLotteryBatch = `
	INSERT INTO lottery_batches (batch_id, start_at, end_at, rules)
	VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
	ON CONFLICT (batch_id) DO NOTHING`

func (r *LotteryRepo) EnsureBatch(ctx context.Context, batchID string, startAt, endAt time.Time, rules any) error {
	if _, err := r.pool.Exec(ctx, insertLotteryBatch, batchID, startAt, endAt, rules); err != nil {
		return fmt.Errorf("ensure lottery batch: %w", err)
	}
	return nil
}

func (r *LotteryRepo) ListDueLotteryBatches(ctx context.Context, now time.Time) ([]lottery.Batch, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT batch_id, start_at, end_at FROM lottery_batches
		WHERE end_at <= $1 AND NOT drawn ORDER BY end_at, batch_id`, now)
	if err != nil {
		return nil, fmt.Errorf("list due lottery batches: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (lottery.Batch, error) {
		var batch lottery.Batch
		err := row.Scan(&batch.ID, &batch.StartAt, &batch.EndAt)
		return batch, err
	})
}

func (r *LotteryRepo) DrawBatchIdempotent(ctx context.Context, batchID string, startAt, endAt, drawnAt time.Time, rng func() float64) (map[string][]int, bool, error) {
	draws := make(map[string][]int)
	newlyDrawn := false
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lotteryDrawLock); err != nil {
			return fmt.Errorf("lock lottery draw: %w", err)
		}
		if _, err := tx.Exec(ctx, insertLotteryBatch, batchID, startAt, endAt, nil); err != nil {
			return fmt.Errorf("ensure lottery batch: %w", err)
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM lottery_batches WHERE batch_id = $1 FOR UPDATE`, batchID); err != nil {
			return fmt.Errorf("lock lottery batch for draw: %w", err)
		}
		existing, err := loadLotteryDraws(ctx, tx, `WHERE batch_id = $1`, batchID)
		if err != nil {
			return err
		}
		for _, draw := range existing {
			draws[draw.PoolID] = draw.WinningNumbers
		}
		for _, pool := range lottery.AllPools() {
			if _, ok := draws[pool.ID]; ok {
				continue
			}
			numbers := lottery.DrawPoolNumbers(pool, rng)
			var salt [32]byte
			if _, err := rand.Read(salt[:]); err != nil {
				return fmt.Errorf("generate lottery draw salt: %w", err)
			}
			seedHash := lottery.DrawSeedHash(batchID, pool.ID, numbers, salt[:])
			if _, err := tx.Exec(ctx, `
				INSERT INTO lottery_draws (batch_id, pool_id, winning_numbers, draw_seed_hash, drawn_at)
				VALUES ($1, $2, $3, $4, $5)`, batchID, pool.ID, numbers, seedHash, drawnAt); err != nil {
				return fmt.Errorf("insert lottery draw: %w", err)
			}
			draws[pool.ID] = numbers
			newlyDrawn = true
		}
		if _, err := tx.Exec(ctx, `UPDATE lottery_batches SET drawn = TRUE WHERE batch_id = $1 AND NOT drawn`, batchID); err != nil {
			return fmt.Errorf("mark lottery batch drawn: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return draws, newlyDrawn, nil
}

func loadLotteryDraws(ctx context.Context, tx pgx.Tx, filter string, arg any) ([]LotteryDraw, error) {
	rows, err := tx.Query(ctx, `
		SELECT batch_id, pool_id, winning_numbers, draw_seed_hash, drawn_at
		FROM lottery_draws `+filter, arg)
	if err != nil {
		return nil, fmt.Errorf("load lottery draws: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (LotteryDraw, error) {
		var draw LotteryDraw
		err := row.Scan(&draw.BatchID, &draw.PoolID, &draw.WinningNumbers, &draw.DrawSeedHash, &draw.DrawnAt)
		return draw, err
	})
}

func (r *LotteryRepo) CraftLotteryTickets(ctx context.Context, userID int64, tier string, quantity int, batchID string, startAt, endAt time.Time, requestKey string, rng func() float64, now time.Time) (*CraftResult, error) {
	const action = "lottery_craft"
	result, replayed, err := runLotteryAction(ctx, r, userID, requestKey, action, func(tx pgx.Tx, player *Player, result *CraftResult) error {
		pool, ok := lottery.GetPool(tier)
		if !ok || quantity <= 0 || int64(quantity) > math.MaxInt64/pool.TicketCost {
			return fmt.Errorf("%w: invalid lottery tier or quantity", ErrInvalidInput)
		}
		if _, err := tx.Exec(ctx, insertLotteryBatch, batchID, startAt, endAt, nil); err != nil {
			return fmt.Errorf("ensure lottery batch: %w", err)
		}
		var drawn bool
		// Concurrent crafts can share this row lock until the draw takes it exclusively.
		if err := tx.QueryRow(ctx, `SELECT drawn FROM lottery_batches WHERE batch_id = $1 FOR SHARE`, batchID).Scan(&drawn); err != nil {
			return fmt.Errorf("lock lottery batch for craft: %w", err)
		}
		if drawn {
			return ErrBatchAlreadyDrawn
		}
		cost := int64(quantity) * pool.TicketCost
		if err := debitBlankTickets(ctx, tx, userID, cost); err != nil {
			return err
		}
		root, tickets, err := readLotteryTickets(player.State)
		if err != nil {
			return err
		}
		result.Tickets = make([]lottery.Ticket, 0, quantity)
		assignedAt := now.UTC().Format(time.RFC3339Nano)
		for range quantity {
			result.Tickets = append(result.Tickets, lottery.Ticket{
				ID: rand.Text(), Tier: tier, BatchID: batchID,
				Numbers: lottery.DrawPoolNumbers(pool, rng), Status: "ASSIGNED", AssignedAt: assignedAt,
			})
		}
		state, err := writeLotteryTickets(root, append(tickets, result.Tickets...))
		if err != nil {
			return err
		}
		if err := updateEconomyPlayer(ctx, tx, player, 0, state, &result.Player); err != nil {
			return err
		}
		result.BlankTickets, err = countBlankTickets(ctx, tx, userID)
		if err != nil {
			return err
		}
		return recordLotteryLedger(ctx, tx, result.Player, action, requestKey, map[string]any{
			"blank_tickets": -cost, "quantity": quantity, "tier": tier, "batch_id": batchID,
		})
	})
	if err != nil {
		return nil, err
	}
	result.Replayed = replayed
	return result, nil
}

func debitBlankTickets(ctx context.Context, tx pgx.Tx, userID, cost int64) error {
	rows, err := tx.Query(ctx, `SELECT id, quantity FROM inventory_items
		WHERE user_id = $1 AND item_kind = 'ticket' AND item_id = 'blank' AND quantity > 0
		ORDER BY id FOR UPDATE`, userID)
	if err != nil {
		return fmt.Errorf("lock blank ticket stacks: %w", err)
	}
	type ticketStack struct{ id, qty int64 }
	stacks, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (ticketStack, error) {
		var stack ticketStack
		err := row.Scan(&stack.id, &stack.qty)
		return stack, err
	})
	if err != nil {
		return fmt.Errorf("read blank ticket stacks: %w", err)
	}
	for _, stack := range stacks {
		debit := min(stack.qty, cost)
		if debit == stack.qty {
			_, err = tx.Exec(ctx, `DELETE FROM inventory_items WHERE id = $1`, stack.id)
		} else {
			_, err = tx.Exec(ctx, `UPDATE inventory_items SET quantity = quantity - $2 WHERE id = $1`, stack.id, debit)
		}
		if err != nil {
			return fmt.Errorf("debit blank tickets: %w", err)
		}
		cost -= debit
		if cost == 0 {
			return nil
		}
	}
	return ErrInsufficientTickets
}

func countBlankTickets(ctx context.Context, tx pgx.Tx, userID int64) (int64, error) {
	var quantity int64
	err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(quantity), 0)::bigint FROM inventory_items
		WHERE user_id = $1 AND item_kind = 'ticket' AND item_id = 'blank'`, userID).Scan(&quantity)
	if err != nil {
		return 0, fmt.Errorf("count blank tickets: %w", err)
	}
	return quantity, nil
}

const lotteryTicketsKey = "lottery_tickets"

func readLotteryTickets(state json.RawMessage) (map[string]json.RawMessage, []lottery.Ticket, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(state, &root); err != nil {
		return nil, nil, fmt.Errorf("decode player state: %w", err)
	}
	tickets := []lottery.Ticket{}
	if raw, ok := root[lotteryTicketsKey]; ok {
		if err := json.Unmarshal(raw, &tickets); err != nil {
			return nil, nil, fmt.Errorf("decode numbered lottery tickets: %w", err)
		}
	}
	if root == nil {
		root = make(map[string]json.RawMessage)
	}
	if tickets == nil {
		tickets = []lottery.Ticket{}
	}
	return root, tickets, nil
}

func writeLotteryTickets(root map[string]json.RawMessage, tickets []lottery.Ticket) (json.RawMessage, error) {
	encoded, err := json.Marshal(tickets)
	if err != nil {
		return nil, fmt.Errorf("encode numbered lottery tickets: %w", err)
	}
	root[lotteryTicketsKey] = encoded
	return json.Marshal(root)
}

func (r *LotteryRepo) ClaimLotteryTickets(ctx context.Context, userID int64, requestKey string, now time.Time) (*ClaimResult, error) {
	const action = "lottery_claim"
	result, replayed, err := runLotteryAction(ctx, r, userID, requestKey, action, func(tx pgx.Tx, player *Player, result *ClaimResult) error {
		result.Player = *player
		result.Tickets = []ClaimedTicket{}
		root, tickets, err := readLotteryTickets(player.State)
		if err != nil || len(tickets) == 0 {
			return err
		}
		batchIDs := make([]string, 0, len(tickets))
		seen := make(map[string]bool)
		for _, ticket := range tickets {
			if !seen[ticket.BatchID] {
				batchIDs = append(batchIDs, ticket.BatchID)
				seen[ticket.BatchID] = true
			}
		}
		draws, err := loadLotteryDraws(ctx, tx, `WHERE batch_id = ANY($1)
			AND batch_id IN (SELECT batch_id FROM lottery_batches WHERE drawn)`, batchIDs)
		if err != nil {
			return err
		}
		type drawKey struct{ batchID, poolID string }
		winning := make(map[drawKey][]int, len(draws))
		for _, draw := range draws {
			winning[drawKey{draw.BatchID, draw.PoolID}] = draw.WinningNumbers
		}
		remaining := make([]lottery.Ticket, 0, len(tickets))
		rewards := lotteryRewards{materials: make(map[string]int64), rods: make(map[string]int64)}
		for _, ticket := range tickets {
			numbers, drawn := winning[drawKey{ticket.BatchID, ticket.Tier}]
			pool, known := lottery.GetPool(ticket.Tier)
			if !drawn || !known || ticket.Status != "ASSIGNED" {
				remaining = append(remaining, ticket)
				continue
			}
			hits := lottery.CountHits(ticket.Numbers, numbers)
			prizes := lottery.RewardForHits(pool, hits)
			for _, prize := range prizes {
				if err := rewards.add(prize.Type, prize.Name, prize.RodID, prize.Qty); err != nil {
					return err
				}
			}
			result.Tickets = append(result.Tickets, ClaimedTicket{Ticket: ticket, Hits: hits, Prizes: prizes})
		}
		result.Claimed = len(result.Tickets)
		if result.Claimed == 0 {
			return nil
		}
		state, err := writeLotteryTickets(root, remaining)
		if err != nil {
			return err
		}
		if err := r.creditLotteryRewards(ctx, tx, userID, rewards); err != nil {
			return err
		}
		if err := updateEconomyPlayer(ctx, tx, player, rewards.coins, state, &result.Player); err != nil {
			return err
		}
		return recordLotteryLedger(ctx, tx, result.Player, action, requestKey, map[string]any{
			"claimed": result.Claimed, "coins": rewards.coins, "materials": rewards.materials, "rods": rewards.rods, "claimed_at": now.UTC(),
		})
	})
	if err != nil {
		return nil, err
	}
	result.Replayed = replayed
	return result, nil
}

type lotteryRewards struct {
	coins     int64
	materials map[string]int64
	rods      map[string]int64
}

func (r *lotteryRewards) add(kind, name, rodID string, qty int64) error {
	if qty <= 0 {
		return fmt.Errorf("invalid lottery reward quantity: %d", qty)
	}
	switch kind {
	case "coin":
		if r.coins > math.MaxInt64-qty {
			return fmt.Errorf("lottery coin reward exceeds balance range")
		}
		r.coins += qty
	case "material":
		r.materials[name] += qty
	case "rod":
		if r.rods == nil {
			return fmt.Errorf("unexpected rod reward")
		}
		r.rods[rodID] += qty
	default:
		return fmt.Errorf("unknown lottery reward kind %q", kind)
	}
	return nil
}

func (r *LotteryRepo) creditLotteryRewards(ctx context.Context, tx pgx.Tx, userID int64, rewards lotteryRewards) error {
	for name, qty := range rewards.materials {
		if err := creditMaterial(ctx, tx, userID, name, qty); err != nil {
			return err
		}
	}
	for rodID, qty := range rewards.rods {
		durability, ok := r.rodDurability(rodID)
		if !ok || durability <= 0 {
			return fmt.Errorf("unknown lottery rod template %q", rodID)
		}
		for range qty {
			if _, err := insertEquipment(ctx, tx, EquipmentInstance{
				UserID: userID, TemplateID: rodID, SlotType: "rod", Durability: durability, MaxDurability: durability,
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *LotteryRepo) GetLotteryStatus(ctx context.Context, userID int64, now time.Time) (*LotteryStatus, error) {
	status := &LotteryStatus{
		CurrentBatch: LotteryBatch{Batch: lottery.Batch{ID: lottery.BatchIDAt(now), StartAt: lottery.BatchStart(now), EndAt: lottery.BatchEnd(now)}},
		Pools:        lottery.AllPools(),
	}
	err := pgx.BeginTxFunc(ctx, r.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var state json.RawMessage
		err := tx.QueryRow(ctx, `SELECT state FROM players WHERE user_id = $1`, userID).Scan(&state)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("load lottery player: %w", err)
		}
		_, status.Tickets, err = readLotteryTickets(state)
		if err != nil {
			return err
		}
		status.BlankTickets, err = countBlankTickets(ctx, tx, userID)
		if err != nil {
			return err
		}
		batch := &status.CurrentBatch
		err = tx.QueryRow(ctx, `SELECT start_at, end_at, drawn FROM lottery_batches WHERE batch_id = $1`, batch.ID).
			Scan(&batch.StartAt, &batch.EndAt, &batch.Drawn)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("load current lottery batch: %w", err)
		}
		status.RecentDraws, err = loadLotteryDraws(ctx, tx, `WHERE batch_id IN (
			SELECT batch_id FROM lottery_batches WHERE drawn AND start_at <= $1 ORDER BY start_at DESC, batch_id DESC LIMIT 7
		) ORDER BY batch_id DESC, pool_id`, now)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("get lottery status: %w", err)
	}
	return status, nil
}

func (r *LotteryRepo) BuyScratchCard(ctx context.Context, userID int64, cardType lottery.ScratchTypeDef, requestKey string, rng func() float64) (*BuyScratchResult, error) {
	const action = "scratch_buy"
	result, replayed, err := runLotteryAction(ctx, r, userID, requestKey, action, func(tx pgx.Tx, player *Player, result *BuyScratchResult) error {
		if cardType.ID == "" || cardType.Slots <= 0 || cardType.CostCoins <= 0 {
			return fmt.Errorf("%w: invalid scratch card type", ErrInvalidInput)
		}
		if player.Coins < cardType.CostCoins {
			return ErrInsufficientCoins
		}
		face := lottery.DrawScratchFace(cardType, rng)
		if len(face) != cardType.Slots {
			return fmt.Errorf("%w: invalid scratch card prize table", ErrInvalidInput)
		}
		settlement := lottery.SettleScratchFace(face)
		card := &result.Card
		err := tx.QueryRow(ctx, `
			INSERT INTO scratch_cards (user_id, card_type, slots, server_face, server_payout, revealed)
			VALUES ($1, $2, $3, $4, $5, FALSE)
			RETURNING id, card_type, slots, revealed, created_at, revealed_at`,
			userID, cardType.ID, cardType.Slots, face, settlement,
		).Scan(&card.ID, &card.CardType, &card.Slots, &card.Revealed, &card.CreatedAt, &card.RevealedAt)
		if err != nil {
			return fmt.Errorf("insert scratch card: %w", err)
		}
		if err := updateEconomyPlayer(ctx, tx, player, -cardType.CostCoins, player.State, &result.Player); err != nil {
			return err
		}
		return recordLotteryLedger(ctx, tx, result.Player, action, requestKey, map[string]any{
			"coins": -cardType.CostCoins, "card_id": card.ID, "card_type": card.CardType,
		})
	})
	if err != nil {
		return nil, err
	}
	result.Replayed = replayed
	return result, nil
}

func (r *LotteryRepo) ListScratchCards(ctx context.Context, userID int64) ([]lottery.PublicScratchCard, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, card_type, slots, revealed, created_at, revealed_at,
			CASE WHEN revealed THEN server_face END, CASE WHEN revealed THEN server_payout END
		FROM scratch_cards WHERE user_id = $1 ORDER BY id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list scratch cards: %w", err)
	}
	cards, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (lottery.PublicScratchCard, error) {
		card, face, settlement, err := scanScratchCard(row)
		if card.Revealed {
			card.Face, card.Payouts = face, settlement.Payouts
		}
		return card, err
	})
	if err != nil {
		return nil, fmt.Errorf("read scratch cards: %w", err)
	}
	return cards, nil
}

func (r *LotteryRepo) RevealScratchCard(ctx context.Context, userID, cardID int64, requestKey string) (*RevealScratchResult, error) {
	const action = "scratch_reveal"
	result, replayed, err := runLotteryAction(ctx, r, userID, requestKey, action, func(tx pgx.Tx, player *Player, result *RevealScratchResult) error {
		card, face, settlement, err := scanScratchCard(tx.QueryRow(ctx, `
			SELECT id, card_type, slots, revealed, created_at, revealed_at,
				CASE WHEN NOT revealed THEN server_face END, CASE WHEN NOT revealed THEN server_payout END
			FROM scratch_cards WHERE id = $1 AND user_id = $2 FOR UPDATE`, cardID, userID))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock scratch card: %w", err)
		}
		if card.Revealed {
			return ErrAlreadyRevealed
		}
		rewards := lotteryRewards{materials: make(map[string]int64)}
		for _, payout := range settlement.Payouts {
			if err := rewards.add(payout.Kind, payout.Name, "", payout.Qty); err != nil {
				return err
			}
		}
		err = tx.QueryRow(ctx, `UPDATE scratch_cards SET revealed = TRUE, revealed_at = NOW()
			WHERE id = $1 AND user_id = $2 RETURNING revealed, revealed_at`, cardID, userID).
			Scan(&card.Revealed, &card.RevealedAt)
		if err != nil {
			return fmt.Errorf("mark scratch card revealed: %w", err)
		}
		card.Face, card.Payouts = face, settlement.Payouts
		if err := r.creditLotteryRewards(ctx, tx, userID, rewards); err != nil {
			return err
		}
		if err := updateEconomyPlayer(ctx, tx, player, rewards.coins, player.State, &result.Player); err != nil {
			return err
		}
		result.Card = card
		return recordLotteryLedger(ctx, tx, result.Player, action, requestKey, map[string]any{
			"card_id": cardID, "coins": rewards.coins, "materials": rewards.materials, "pairs": settlement.Pairs,
		})
	})
	if err != nil {
		return nil, err
	}
	result.Replayed = replayed
	return result, nil
}

func scanScratchCard(row pgx.Row) (lottery.PublicScratchCard, []lottery.ScratchSlot, lottery.ScratchSettlement, error) {
	var card lottery.PublicScratchCard
	var face []lottery.ScratchSlot
	var settlement lottery.ScratchSettlement
	var rawFace, rawPayout json.RawMessage
	if err := row.Scan(&card.ID, &card.CardType, &card.Slots, &card.Revealed, &card.CreatedAt, &card.RevealedAt, &rawFace, &rawPayout); err != nil {
		return card, nil, settlement, err
	}
	if len(rawFace) > 0 {
		if err := json.Unmarshal(rawFace, &face); err != nil {
			return card, nil, settlement, fmt.Errorf("decode scratch face: %w", err)
		}
	}
	if len(rawPayout) > 0 {
		if err := json.Unmarshal(rawPayout, &settlement); err != nil {
			return card, nil, settlement, fmt.Errorf("decode scratch payout: %w", err)
		}
	}
	return card, face, settlement, nil
}

// AddBlankTickets grants blank tickets that can be consumed in any pool.
func (r *LotteryRepo) AddBlankTickets(ctx context.Context, userID, qty int64) error {
	if qty <= 0 {
		return fmt.Errorf("%w: positive ticket quantity required", ErrInvalidInput)
	}
	return pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if err := lockFishingUser(ctx, tx, userID); err != nil {
			return err
		}
		_, err := insertInventoryItem(ctx, tx, userID, NewInventoryItem{
			ItemKind: "ticket", ItemID: "blank", Quantity: qty,
		})
		return err
	})
}

func recordLotteryLedger(ctx context.Context, tx pgx.Tx, player Player, action, requestKey string, delta map[string]any) error {
	entry := LedgerEntryInput{EventType: action, Delta: delta}
	if requestKey != "" {
		entry.RequestKey = &requestKey
	}
	return recordFishingLedger(ctx, tx, player, []LedgerEntryInput{entry})
}

// runLotteryAction serializes request replays with all other player asset changes.
func runLotteryAction[T any](ctx context.Context, r *LotteryRepo, userID int64, requestKey, action string, apply func(pgx.Tx, *Player, *T) error) (*T, bool, error) {
	if strings.ContainsRune(requestKey, '\x00') {
		return nil, false, fmt.Errorf("%w: request key contains a NUL character", ErrInvalidInput)
	}
	var result T
	replayed := false
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		player, err := lockEconomyPlayer(ctx, tx, userID)
		if err != nil {
			return err
		}
		if requestKey == "" {
			return apply(tx, player, &result)
		}
		var storedAction string
		var response json.RawMessage
		err = tx.QueryRow(ctx, `SELECT action, response FROM action_log WHERE user_id = $1 AND request_key = $2`,
			userID, requestKey).Scan(&storedAction, &response)
		if err == nil {
			if storedAction != action {
				return fmt.Errorf("%w: request key belongs to a different action", ErrInvalidInput)
			}
			replayed = true
			return json.Unmarshal(response, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("load action replay: %w", err)
		}
		if err := apply(tx, player, &result); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO action_log (user_id, request_key, action, status_code, response)
			VALUES ($1, $2, $3, 200, $4)`, userID, requestKey, action, &result); err != nil {
			return fmt.Errorf("record action response: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, false, fmt.Errorf("%s: %w", action, err)
	}
	return &result, replayed, nil
}
