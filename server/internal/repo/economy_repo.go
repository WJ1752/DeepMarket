package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"deepmarket/server/internal/fx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInsufficientCoins    = errors.New("insufficient coins")
	ErrPositionLimit        = errors.New("fx position limit exceeded")
	ErrInsufficientPosition = errors.New("insufficient fx position")
)

type FXFlow struct {
	Symbol string  `json:"symbol"`
	Net    float64 `json:"net"`
	Volume float64 `json:"volume"`
}

type GuildQuoteItem struct {
	ID         int64    `json:"id"`
	ItemID     string   `json:"item_id"`
	Tier       string   `json:"tier"`
	Traits     []string `json:"traits"`
	WeightG    int      `json:"weight_g"`
	Quantity   int64    `json:"quantity"`
	UnitPrice  int64    `json:"unit_price"`
	TotalPrice int64    `json:"total_price"`
}

type GuildSellResult struct {
	Player        Player   `json:"player"`
	SoldCount     int64    `json:"sold_count"`
	CoinsEarned   int64    `json:"coins_earned"`
	TicketsEarned int64    `json:"tickets_earned"`
	FXFlows       []FXFlow `json:"fx_flows"`
}

type FXTradeResult struct {
	Player         Player  `json:"player"`
	Symbol         string  `json:"symbol"`
	Side           string  `json:"side"`
	Quantity       int64   `json:"quantity"`
	UnitPrice      int64   `json:"unit_price"`
	Fee            int64   `json:"fee"`
	NewPositionQty int64   `json:"new_position_qty"`
	NewAvgCost     float64 `json:"new_avg_cost"`
}

type InventorySnapshot struct {
	Player       Player                `json:"player"`
	Fish         []InventoryItem       `json:"fish"`
	Materials    map[string]int64      `json:"materials"`
	BlankTickets int64                 `json:"blank_tickets"`
	Rods         []EquipmentInstance   `json:"rods"`
	Positions    map[string]FXPosition `json:"positions"`
}

type FXPosition struct {
	Symbol   string  `json:"symbol"`
	Quantity int64   `json:"quantity"`
	AvgCost  float64 `json:"avg_cost"`
}

type FXMarketState struct {
	Days      map[string][]fx.DayCandle
	Today     map[string]fx.BucketState
	Positions map[string]FXPosition
}

// EconomyRepo manages guild transactions and the FX market.
type EconomyRepo struct {
	pool *pgxpool.Pool
}

func NewEconomyRepo(pool *pgxpool.Pool) *EconomyRepo {
	return &EconomyRepo{pool: pool}
}

// DeleteSession revokes the given session if it belongs to the authenticated account.
func (r *FishingRepo) DeleteSession(ctx context.Context, sessionID string, userID int64) error {
	if _, err := r.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1 AND user_id = $2`, sessionID, userID); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// GetAccountByUserID loads the user and player rows for an authenticated account.
func (r *PlayerRepo) GetAccountByUserID(ctx context.Context, userID int64) (*AccountSnapshot, error) {
	var account AccountSnapshot
	err := r.pool.QueryRow(ctx, `
		SELECT u.id, u.username, u.email, u.password_hash, u.role, u.disabled, u.created_at, u.updated_at,
		       p.user_id, p.version, p.inv_rev, p.coins, p.black_coins, p.state,
		       p.last_fishing_settle_at, p.house_last_claim_at, p.created_at, p.updated_at
		FROM users AS u
		JOIN players AS p ON p.user_id = u.id
		WHERE u.id = $1`, userID,
	).Scan(append(account.User.scanTargets(), account.Player.scanTargets()...)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get account by user ID: %w", err)
	}
	return &account, nil
}

const (
	fxSettlementLock int64 = 0x4658534554544c
	lastFXBinSlot          = 95
)

// AppendFXFlows records the daily and intraday totals in a single transaction.
func (r *EconomyRepo) AppendFXFlows(ctx context.Context, flows []FXFlow, now time.Time) error {
	if len(flows) == 0 {
		return nil
	}
	return pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		return appendFXFlows(ctx, tx, flows, now)
	})
}

func appendFXFlows(ctx context.Context, tx pgx.Tx, flows []FXFlow, now time.Time) error {
	if len(flows) == 0 {
		return nil
	}
	totals := make(map[string]FXFlow, len(fx.AllSymbols()))
	for _, flow := range flows {
		_, known := fx.GetSymbol(flow.Symbol)
		if !known || flow.Volume < 0 || math.IsNaN(flow.Volume) || math.IsNaN(flow.Net) ||
			math.IsInf(flow.Volume, 0) || math.IsInf(flow.Net, 0) {
			return fmt.Errorf("%w: invalid FX flow", ErrInvalidInput)
		}
		total := totals[flow.Symbol]
		total.Net += flow.Net
		total.Volume += flow.Volume
		totals[flow.Symbol] = total
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, fxSettlementLock); err != nil {
		return fmt.Errorf("lock FX flow: %w", err)
	}
	// Visit symbols in a common order so concurrent multi-trait writes can share the market lock.
	for _, meta := range fx.AllSymbols() {
		if total, ok := totals[meta.ID]; ok {
			total.Symbol = meta.ID
			if err := appendFXFlow(ctx, tx, total, now); err != nil {
				return fmt.Errorf("append FX flow for %s: %w", meta.ID, err)
			}
		}
	}
	return nil
}

func appendFXFlow(ctx context.Context, tx pgx.Tx, flow FXFlow, now time.Time) error {
	day, slot := fx.UTCDayIndex(now), fx.UTCBinSlot(now)
	if _, err := tx.Exec(ctx, `
		INSERT INTO fx_bucket (symbol, day_index, updated_at) VALUES ($1, $2, $3)
		ON CONFLICT (symbol) DO NOTHING`, flow.Symbol, day, now); err != nil {
		return err
	}
	var oldDay int
	var settledDay *int
	var oldNet, oldVolume float64
	if err := tx.QueryRow(ctx, `
		SELECT b.day_index, b.net, b.volume, (SELECT MAX(day_index) FROM fx_days WHERE symbol = b.symbol)
		FROM fx_bucket AS b WHERE b.symbol = $1 FOR UPDATE`, flow.Symbol,
	).Scan(&oldDay, &oldNet, &oldVolume, &settledDay); err != nil {
		return err
	}
	// A write delayed past settlement belongs to the first open day.
	if settledDay != nil && day <= *settledDay {
		day, slot = max(oldDay, *settledDay+1), 0
	}
	if day > oldDay && (settledDay == nil || oldDay > *settledDay) {
		// Carry any total missing from older bins forward to the worker before overwriting the bucket.
		if _, err := tx.Exec(ctx, `
			INSERT INTO fx_bucket_bins (symbol, day_index, bin_slot, net, volume)
			SELECT $1, $2, $3, $4 - COALESCE(SUM(net), 0), $5 - COALESCE(SUM(volume), 0)
			FROM fx_bucket_bins WHERE symbol = $1 AND day_index = $2
			HAVING $4 <> COALESCE(SUM(net), 0) OR $5 <> COALESCE(SUM(volume), 0)
			ON CONFLICT (symbol, day_index, bin_slot) DO UPDATE
			SET net = fx_bucket_bins.net + EXCLUDED.net, volume = fx_bucket_bins.volume + EXCLUDED.volume`,
			flow.Symbol, oldDay, lastFXBinSlot, oldNet, oldVolume); err != nil {
			return err
		}
	}
	if day >= oldDay {
		if _, err := tx.Exec(ctx, `
			UPDATE fx_bucket SET day_index = $2,
				net = CASE WHEN day_index = $2 THEN net + $3 ELSE $3 END,
				volume = CASE WHEN day_index = $2 THEN volume + $4 ELSE $4 END,
				updated_at = GREATEST(updated_at, $5)
			WHERE symbol = $1`, flow.Symbol, day, flow.Net, flow.Volume, now); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO fx_bucket_bins (symbol, day_index, bin_slot, net, volume)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (symbol, day_index, bin_slot) DO UPDATE
		SET net = fx_bucket_bins.net + EXCLUDED.net, volume = fx_bucket_bins.volume + EXCLUDED.volume`,
		flow.Symbol, day, slot, flow.Net, flow.Volume)
	return err
}

type fxDayKey struct {
	symbol string
	day    int
}

// SettleDueFXDays closes elapsed UTC trading days and applies the retention limits.
func (r *EconomyRepo) SettleDueFXDays(ctx context.Context, now time.Time, cfg fx.Config) ([]fx.DayCandle, error) {
	today := fx.UTCDayIndex(now)
	symbols := fx.AllSymbols()
	ids := make([]string, 0, len(symbols))
	for _, meta := range symbols {
		ids = append(ids, meta.ID)
	}
	var settled []fx.DayCandle
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, fxSettlementLock); err != nil {
			return fmt.Errorf("lock FX settlement: %w", err)
		}
		flows, firstDay, err := loadDueFXFlows(ctx, tx, ids, today)
		if err != nil || firstDay == today {
			return err
		}
		previous, err := loadFXCloses(ctx, tx, ids, firstDay)
		if err != nil {
			return err
		}
		for day := firstDay; day < today; day++ {
			for _, meta := range symbols {
				close, ok := previous[meta.ID]
				if !ok {
					close = meta.BasePrice
				}
				flow := flows[fxDayKey{symbol: meta.ID, day: day}]
				move, imbalance := fx.DayMove(flow.Net, flow.Volume, close, meta.BasePrice, meta.Sensitivity, cfg)
				bar := fx.DayBar(meta.ID, day, close, flow.Net, flow.Volume, move, cfg)
				bar.Imbalance, bar.SettledAt = imbalance, now.UTC()
				var persistedClose float64
				err := tx.QueryRow(ctx, `
					INSERT INTO fx_days (symbol, day_index, open, high, low, close, net, volume, settled_at)
					VALUES ($1, $2, $3::double precision, $4::double precision, $5::double precision,
						$6::double precision, $7, $8, $9)
					ON CONFLICT (symbol, day_index) DO NOTHING RETURNING close::double precision`,
					bar.Symbol, bar.DayIndex, bar.Open, bar.High, bar.Low, bar.Close, bar.Net, bar.Volume, bar.SettledAt,
				).Scan(&persistedClose)
				if errors.Is(err, pgx.ErrNoRows) {
					err = tx.QueryRow(ctx, `SELECT close::double precision FROM fx_days WHERE symbol = $1 AND day_index = $2`,
						meta.ID, day).Scan(&persistedClose)
				} else if err == nil {
					settled = append(settled, bar)
				}
				if err != nil {
					return fmt.Errorf("settle %s day %d: %w", meta.ID, day, err)
				}
				previous[meta.ID] = persistedClose
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE fx_bucket SET day_index = $1, net = 0, volume = 0, updated_at = $2
			WHERE day_index < $1`, today, now); err != nil {
			return fmt.Errorf("reset settled FX buckets: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM fx_days WHERE day_index <= $1`, today-fxKeepDays(cfg)); err != nil {
			return fmt.Errorf("prune FX days: %w", err)
		}
		binDays := cfg.BinKeepDays
		if binDays <= 0 {
			binDays = fx.DefaultConfig().BinKeepDays
		}
		if _, err := tx.Exec(ctx, `DELETE FROM fx_bucket_bins WHERE day_index <= $1`, today-binDays); err != nil {
			return fmt.Errorf("prune FX bins: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return settled, nil
}

func loadDueFXFlows(ctx context.Context, tx pgx.Tx, ids []string, today int) (map[fxDayKey]FXFlow, int, error) {
	// Bins preserve a day's totals when a new-day trade arrives before the settlement worker.
	rows, err := tx.Query(ctx, `
		SELECT symbol, day_index, net, volume FROM fx_bucket WHERE day_index < $1 AND symbol = ANY($2)
		UNION ALL
		SELECT b.symbol, b.day_index, SUM(b.net), SUM(b.volume)
		FROM fx_bucket_bins AS b
		WHERE b.day_index < $1 AND b.symbol = ANY($2)
			AND NOT EXISTS (SELECT 1 FROM fx_bucket c WHERE c.symbol = b.symbol AND c.day_index = b.day_index)
			AND NOT EXISTS (SELECT 1 FROM fx_days d WHERE d.symbol = b.symbol AND d.day_index >= b.day_index)
		GROUP BY b.symbol, b.day_index`, today, ids)
	if err != nil {
		return nil, 0, fmt.Errorf("load due FX flow: %w", err)
	}
	defer rows.Close()
	flows := make(map[fxDayKey]FXFlow)
	firstDay := today
	for rows.Next() {
		var flow FXFlow
		var day int
		if err := rows.Scan(&flow.Symbol, &day, &flow.Net, &flow.Volume); err != nil {
			return nil, 0, fmt.Errorf("scan due FX flow: %w", err)
		}
		flows[fxDayKey{symbol: flow.Symbol, day: day}] = flow
		firstDay = min(firstDay, day)
	}
	return flows, firstDay, rows.Err()
}

func loadFXCloses(ctx context.Context, tx pgx.Tx, ids []string, before int) (map[string]float64, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (symbol) symbol, close::double precision FROM fx_days
		WHERE symbol = ANY($1) AND day_index < $2 ORDER BY symbol, day_index DESC`, ids, before)
	if err != nil {
		return nil, fmt.Errorf("load previous FX closes: %w", err)
	}
	defer rows.Close()
	closes := make(map[string]float64, len(ids))
	for rows.Next() {
		var symbol string
		var close float64
		if err := rows.Scan(&symbol, &close); err != nil {
			return nil, fmt.Errorf("scan previous FX close: %w", err)
		}
		closes[symbol] = close
	}
	return closes, rows.Err()
}

func fxKeepDays(cfg fx.Config) int {
	if cfg.KeepDays <= 0 {
		return fx.DefaultConfig().KeepDays
	}
	return cfg.KeepDays
}

// GetFXMarketState reads candles, live totals and positions from the same snapshot.
func (r *EconomyRepo) GetFXMarketState(ctx context.Context, userID int64, now time.Time, cfg fx.Config) (*FXMarketState, error) {
	today := fx.UTCDayIndex(now)
	market := &FXMarketState{
		Days:  make(map[string][]fx.DayCandle),
		Today: make(map[string]fx.BucketState),
	}
	err := pgx.BeginTxFunc(ctx, r.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		if err := loadFXHistory(ctx, tx, market.Days, today, cfg); err != nil {
			return err
		}
		if err := loadFXBuckets(ctx, tx, market.Today, today); err != nil {
			return err
		}
		var err error
		market.Positions, err = loadFXPositions(ctx, tx, userID)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("get FX market state: %w", err)
	}
	return market, nil
}

func loadFXHistory(ctx context.Context, tx pgx.Tx, days map[string][]fx.DayCandle, today int, cfg fx.Config) error {
	rows, err := tx.Query(ctx, `
		SELECT symbol, day_index, open::double precision, high::double precision, low::double precision,
			close::double precision, net, volume, settled_at
		FROM fx_days WHERE day_index > $1 AND day_index < $2 ORDER BY symbol, day_index`, today-fxKeepDays(cfg), today)
	if err != nil {
		return fmt.Errorf("load FX history: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var bar fx.DayCandle
		if err := rows.Scan(&bar.Symbol, &bar.DayIndex, &bar.Open, &bar.High, &bar.Low, &bar.Close, &bar.Net, &bar.Volume, &bar.SettledAt); err != nil {
			return fmt.Errorf("scan FX candle: %w", err)
		}
		if meta, known := fx.GetSymbol(bar.Symbol); known {
			bar.Move, bar.Imbalance = fx.DayMove(bar.Net, bar.Volume, bar.Open, meta.BasePrice, meta.Sensitivity, cfg)
			days[bar.Symbol] = append(days[bar.Symbol], bar)
		}
	}
	return rows.Err()
}

func loadFXBuckets(ctx context.Context, tx pgx.Tx, buckets map[string]fx.BucketState, today int) error {
	rows, err := tx.Query(ctx, `
		SELECT b.symbol, b.net, b.volume, s.bin_slot, s.net, s.volume
		FROM fx_bucket b LEFT JOIN fx_bucket_bins s ON s.symbol = b.symbol AND s.day_index = b.day_index
		WHERE b.day_index = $1 ORDER BY b.symbol, s.bin_slot`, today)
	if err != nil {
		return fmt.Errorf("load FX buckets: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var symbol string
		var net, volume float64
		var binSlot *int
		var binNet, binVolume *float64
		if err := rows.Scan(&symbol, &net, &volume, &binSlot, &binNet, &binVolume); err != nil {
			return fmt.Errorf("scan FX bucket: %w", err)
		}
		bucket := buckets[symbol]
		bucket.Symbol, bucket.DayIndex, bucket.Net, bucket.Volume = symbol, today, net, volume
		if binSlot != nil && *binSlot >= 0 && *binSlot <= lastFXBinSlot {
			bucket.Bins = append(bucket.Bins, fx.BucketBin{BinSlot: *binSlot, Net: *binNet, Volume: *binVolume})
		}
		buckets[symbol] = bucket
	}
	return rows.Err()
}

func loadFXPositions(ctx context.Context, tx pgx.Tx, userID int64) (map[string]FXPosition, error) {
	rows, err := tx.Query(ctx, `
		SELECT symbol, quantity, avg_cost::double precision FROM fx_positions WHERE user_id = $1 AND quantity > 0`, userID)
	if err != nil {
		return nil, fmt.Errorf("load FX positions: %w", err)
	}
	defer rows.Close()
	positions := make(map[string]FXPosition)
	for rows.Next() {
		var position FXPosition
		if err := rows.Scan(&position.Symbol, &position.Quantity, &position.AvgCost); err != nil {
			return nil, fmt.Errorf("scan FX position: %w", err)
		}
		positions[position.Symbol] = position
	}
	return positions, rows.Err()
}

// ExecuteFXTrade exchanges coins and shares at the server's quoted price.
func (r *EconomyRepo) ExecuteFXTrade(ctx context.Context, userID int64, symbol, side string, qty, unitPrice, fee, maxPos int64, now time.Time) (*FXTradeResult, error) {
	if _, ok := fx.GetSymbol(symbol); !ok || (side != "buy" && side != "sell") ||
		qty <= 0 || unitPrice <= 0 || fee < 0 || qty > math.MaxInt64/unitPrice {
		return nil, fmt.Errorf("%w: invalid FX trade", ErrInvalidInput)
	}
	gross := qty * unitPrice
	if side == "buy" && fee > math.MaxInt64-gross {
		return nil, fmt.Errorf("%w: trade total exceeds coin range", ErrInvalidInput)
	}
	result := &FXTradeResult{Symbol: symbol, Side: side, Quantity: qty, UnitPrice: unitPrice, Fee: fee}
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		player, err := lockEconomyPlayer(ctx, tx, userID)
		if err != nil {
			return err
		}
		var oldQty int64
		var oldAvg float64
		err = tx.QueryRow(ctx, `SELECT quantity, avg_cost::double precision FROM fx_positions WHERE user_id = $1 AND symbol = $2 FOR UPDATE`,
			userID, symbol).Scan(&oldQty, &oldAvg)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock FX position: %w", err)
		}
		if oldQty < 0 {
			return fmt.Errorf("%w: negative FX position quantity", ErrInvalidInput)
		}
		var sharesDelta, coinsDelta int64
		if side == "buy" {
			if qty > maxPos || oldQty > maxPos-qty {
				return ErrPositionLimit
			}
			if player.Coins < gross+fee {
				return ErrInsufficientCoins
			}
			sharesDelta, coinsDelta = qty, -(gross + fee)
			result.NewPositionQty = oldQty + qty
			result.NewAvgCost = (float64(oldQty)*oldAvg + float64(qty)*float64(unitPrice)) / float64(result.NewPositionQty)
		} else {
			if oldQty < qty {
				return ErrInsufficientPosition
			}
			sharesDelta, coinsDelta = -qty, max(0, gross-fee)
			result.NewPositionQty = oldQty - qty
			result.NewAvgCost = oldAvg
		}
		if result.NewPositionQty == 0 {
			result.NewAvgCost = 0
			_, err = tx.Exec(ctx, `DELETE FROM fx_positions WHERE user_id = $1 AND symbol = $2`, userID, symbol)
		} else {
			err = tx.QueryRow(ctx, `
				INSERT INTO fx_positions (user_id, symbol, quantity, avg_cost, updated_at)
				VALUES ($1, $2, $3, $4::double precision, $5)
				ON CONFLICT (user_id, symbol) DO UPDATE
				SET quantity = EXCLUDED.quantity, avg_cost = EXCLUDED.avg_cost, updated_at = EXCLUDED.updated_at
				RETURNING avg_cost::double precision`, userID, symbol, result.NewPositionQty, result.NewAvgCost, now,
			).Scan(&result.NewAvgCost)
		}
		if err != nil {
			return fmt.Errorf("update FX position: %w", err)
		}
		if err := updateEconomyPlayer(ctx, tx, player, coinsDelta, player.State, &result.Player); err != nil {
			return err
		}
		if err := appendFXFlows(ctx, tx, []FXFlow{{Symbol: symbol, Net: float64(sharesDelta), Volume: float64(qty)}}, now); err != nil {
			return err
		}
		return recordFishingLedger(ctx, tx, result.Player, []LedgerEntryInput{{EventType: "fx_" + side, Delta: map[string]any{
			"coins": coinsDelta, "symbol": symbol, "quantity": sharesDelta, "unit_price": unitPrice, "fee": fee,
		}}})
	})
	if err != nil {
		return nil, fmt.Errorf("execute FX trade: %w", err)
	}
	return result, nil
}

func lockEconomyPlayer(ctx context.Context, tx pgx.Tx, userID int64) (*Player, error) {
	if err := lockFishingUser(ctx, tx, userID); err != nil {
		return nil, err
	}
	var player Player
	err := tx.QueryRow(ctx, `SELECT `+playerColumns+` FROM players WHERE user_id = $1 FOR UPDATE`, userID).
		Scan(player.scanTargets()...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("lock economy player: %w", err)
	}
	return &player, nil
}

func updateEconomyPlayer(ctx context.Context, tx pgx.Tx, player *Player, coinsDelta int64, state json.RawMessage, result *Player) error {
	return updateFishingPlayer(ctx, tx, FishingCommitInput{
		UserID: player.UserID, ExpectedVersion: player.Version, CoinsDelta: coinsDelta, NewState: state,
	}, result)
}

var guildTraitPrices = map[string]int64{
	"swift": 6, "armored": 8, "luminous": 10, "heavy": 12,
	"ancient": 14, "surge": 16, "abyssal": 18, "prismatic": 20,
}

// QuoteGuildFish applies the guild's fixed trait, combination, tier and weight prices.
func QuoteGuildFish(item InventoryItem) GuildQuoteItem {
	traits := make(map[string]bool, len(item.Traits))
	var traitPrice int64
	for _, trait := range item.Traits {
		if !traits[trait] {
			traitPrice += guildTraitPrices[trait]
			traits[trait] = true
		}
	}
	if traits["abyssal"] && traits["armored"] {
		traitPrice += 14
		if traits["luminous"] {
			traitPrice += 32
		}
	}
	if traits["luminous"] && traits["prismatic"] {
		traitPrice += 16
	}
	tierMultiplier := 1.0
	switch item.Tier {
	case "rare":
		tierMultiplier = 1.25
	case "epic":
		tierMultiplier = 1.6
	case "legendary":
		tierMultiplier = 2.2
	}
	weightFactor := max(1, float64(item.WeightG)/1000)
	unitPrice := max(1, int64(math.Round(float64(traitPrice)*tierMultiplier*weightFactor)))
	totalPrice := min(max(0, item.Quantity), math.MaxInt64/unitPrice) * unitPrice
	return GuildQuoteItem{
		ID: item.ID, ItemID: item.ItemID, Tier: item.Tier, Traits: item.Traits, WeightG: item.WeightG,
		Quantity: item.Quantity, UnitPrice: unitPrice, TotalPrice: totalPrice,
	}
}

// SellFishAtGuild sells selected fish stacks and records their market supply and rewards.
func (r *EconomyRepo) SellFishAtGuild(ctx context.Context, userID int64, fishIDs []int64, sellAll bool, now time.Time) (*GuildSellResult, error) {
	if !sellAll && len(fishIDs) == 0 {
		return nil, fmt.Errorf("%w: fish IDs or sell_all required", ErrInvalidInput)
	}
	result := &GuildSellResult{FXFlows: []FXFlow{}}
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		player, err := lockEconomyPlayer(ctx, tx, userID)
		if err != nil {
			return err
		}
		items, err := collectFish(tx.Query(ctx, `
			SELECT `+inventoryColumns+` FROM inventory_items
			WHERE user_id = $1 AND item_kind = 'fish' AND ($2 OR id = ANY($3))
			ORDER BY id FOR UPDATE`, userID, sellAll, fishIDs))
		if err != nil {
			return fmt.Errorf("lock guild fish: %w", err)
		}
		if len(items) == 0 {
			return ErrNotFound
		}
		soldIDs := make([]int64, 0, len(items))
		quantities := make(map[string]int64)
		for _, item := range items {
			quote := QuoteGuildFish(item)
			if item.Quantity <= 0 || item.Quantity > math.MaxInt64-result.SoldCount ||
				item.Quantity > (math.MaxInt64-result.CoinsEarned)/quote.UnitPrice {
				return fmt.Errorf("%w: invalid guild sale quantity or total", ErrInvalidInput)
			}
			soldIDs = append(soldIDs, item.ID)
			result.CoinsEarned += quote.TotalPrice
			result.SoldCount += item.Quantity
			seen := make(map[string]bool, len(item.Traits))
			for _, trait := range item.Traits {
				if _, known := fx.GetSymbol(trait); known && !seen[trait] {
					quantities[trait] += item.Quantity
					seen[trait] = true
				}
			}
		}
		for _, meta := range fx.AllSymbols() {
			if qty := quantities[meta.ID]; qty > 0 {
				result.FXFlows = append(result.FXFlows, FXFlow{Symbol: meta.ID, Net: -float64(qty), Volume: float64(qty)})
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM inventory_items WHERE user_id = $1 AND id = ANY($2)`, userID, soldIDs); err != nil {
			return fmt.Errorf("delete sold fish: %w", err)
		}
		if result.CoinsEarned > 0 {
			result.TicketsEarned = min(50, max(1, result.CoinsEarned/20))
			_, err := insertInventoryItem(ctx, tx, userID, NewInventoryItem{
				ItemKind: "ticket", ItemID: "blank", Quantity: result.TicketsEarned,
			})
			if err != nil {
				return err
			}
		}
		if err := updateEconomyPlayer(ctx, tx, player, result.CoinsEarned, player.State, &result.Player); err != nil {
			return err
		}
		if err := appendFXFlows(ctx, tx, result.FXFlows, now); err != nil {
			return err
		}
		return recordFishingLedger(ctx, tx, result.Player, []LedgerEntryInput{{EventType: "guild_sell", Delta: map[string]any{
			"coins": result.CoinsEarned, "fish_ids": soldIDs, "sold_count": result.SoldCount, "blank_tickets": result.TicketsEarned,
		}}})
	})
	if err != nil {
		return nil, fmt.Errorf("sell fish at guild: %w", err)
	}
	return result, nil
}

func collectFish(rows pgx.Rows, err error) ([]InventoryItem, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (InventoryItem, error) {
		var item InventoryItem
		err := row.Scan(item.scanTargets()...)
		return item, err
	})
}

// GetInventorySnapshot reads all guild inventory and equipment from one transaction snapshot.
func (r *EconomyRepo) GetInventorySnapshot(ctx context.Context, userID int64) (*InventorySnapshot, error) {
	var snapshot InventorySnapshot
	err := pgx.BeginTxFunc(ctx, r.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT `+playerColumns+` FROM players WHERE user_id = $1`, userID).
			Scan(snapshot.Player.scanTargets()...)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("load inventory player: %w", err)
		}
		snapshot.Fish, err = collectFish(tx.Query(ctx, `SELECT `+inventoryColumns+` FROM inventory_items
			WHERE user_id = $1 AND item_kind = 'fish' ORDER BY id DESC`, userID))
		if err != nil {
			return fmt.Errorf("load inventory fish: %w", err)
		}
		if err := loadInventorySupplies(ctx, tx, userID, &snapshot); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+equipmentColumns+` FROM equipment_instances
			WHERE user_id = $1 AND slot_type = 'rod' ORDER BY id`, userID)
		if err != nil {
			return fmt.Errorf("load inventory rods: %w", err)
		}
		snapshot.Rods, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (EquipmentInstance, error) {
			var rod EquipmentInstance
			err := row.Scan(rod.scanTargets()...)
			return rod, err
		})
		if err != nil {
			return fmt.Errorf("scan inventory rods: %w", err)
		}
		snapshot.Positions, err = loadFXPositions(ctx, tx, userID)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("get inventory snapshot: %w", err)
	}
	return &snapshot, nil
}

func loadInventorySupplies(ctx context.Context, tx pgx.Tx, userID int64, snapshot *InventorySnapshot) error {
	rows, err := tx.Query(ctx, `
		SELECT item_kind, item_id, SUM(quantity)::bigint FROM inventory_items
		WHERE user_id = $1 AND (item_kind = 'material' OR (item_kind = 'ticket' AND item_id = 'blank'))
		GROUP BY item_kind, item_id`, userID)
	if err != nil {
		return fmt.Errorf("load inventory supplies: %w", err)
	}
	defer rows.Close()
	snapshot.Materials = make(map[string]int64)
	for rows.Next() {
		var kind, id string
		var quantity int64
		if err := rows.Scan(&kind, &id, &quantity); err != nil {
			return fmt.Errorf("scan inventory supply: %w", err)
		}
		if kind == "material" {
			snapshot.Materials[id] = quantity
		} else {
			snapshot.BlankTickets = quantity
		}
	}
	return rows.Err()
}

// ManualRepairRod consumes materials and restores an owned rod up to its maximum durability.
func (r *EconomyRepo) ManualRepairRod(ctx context.Context, userID, rodID int64, materialID string, materialCost int64, restoreAmount int) (*EquipmentInstance, *Player, error) {
	if rodID <= 0 || materialCost < 0 || restoreAmount <= 0 || (materialCost > 0 && materialID == "") {
		return nil, nil, fmt.Errorf("%w: invalid rod repair", ErrInvalidInput)
	}
	var rod *EquipmentInstance
	var result Player
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		player, err := lockEconomyPlayer(ctx, tx, userID)
		if err != nil {
			return err
		}
		var current EquipmentInstance
		err = tx.QueryRow(ctx, `SELECT `+equipmentColumns+` FROM equipment_instances
			WHERE user_id = $1 AND id = $2 AND slot_type = 'rod' FOR UPDATE`, userID, rodID).Scan(current.scanTargets()...)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock repair rod: %w", err)
		}
		if current.Durability >= current.MaxDurability {
			rod, result = &current, *player
			return nil
		}
		if err := applyMaterialDelta(ctx, tx, userID, materialID, -materialCost); err != nil {
			return err
		}
		restored := min(int64(restoreAmount), int64(current.MaxDurability)-int64(current.Durability))
		rod, err = updateFishingRod(ctx, tx, FishingCommitInput{
			UserID: userID, RodID: rodID, NewRodDurability: current.Durability + int(restored),
		})
		if err != nil {
			return err
		}
		if err := updateEconomyPlayer(ctx, tx, player, 0, player.State, &result); err != nil {
			return err
		}
		return recordFishingLedger(ctx, tx, result, []LedgerEntryInput{{EventType: "rod_manual_repair", Delta: map[string]any{
			"rod_id": rodID, "durability": rod.Durability, "durability_restored": restored,
			"material_id": materialID, "material_quantity": -materialCost,
		}}})
	})
	if err != nil {
		return nil, nil, fmt.Errorf("repair rod: %w", err)
	}
	return rod, &result, nil
}

// UpgradeRodAutoRepair buys the next auto-repair level in the player's fishing state.
func (r *EconomyRepo) UpgradeRodAutoRepair(ctx context.Context, userID, coinCost, materialCost int64, materialID string) (*Player, int, error) {
	if coinCost < 0 || materialCost < 0 || (materialCost > 0 && materialID == "") {
		return nil, 0, fmt.Errorf("%w: invalid auto-repair upgrade costs", ErrInvalidInput)
	}
	var result Player
	var level int
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		player, err := lockEconomyPlayer(ctx, tx, userID)
		if err != nil {
			return err
		}
		if player.Coins < coinCost {
			return ErrInsufficientCoins
		}
		var state json.RawMessage
		state, level, err = incrementAutoRepairLevel(player.State)
		if err != nil {
			return err
		}
		if err := applyMaterialDelta(ctx, tx, userID, materialID, -materialCost); err != nil {
			return err
		}
		if err := updateEconomyPlayer(ctx, tx, player, -coinCost, state, &result); err != nil {
			return err
		}
		return recordFishingLedger(ctx, tx, result, []LedgerEntryInput{{EventType: "rod_auto_repair_upgrade", Delta: map[string]any{
			"coins": -coinCost, "material_id": materialID, "material_quantity": -materialCost, "auto_repair_level": level,
		}}})
	})
	if err != nil {
		return nil, 0, fmt.Errorf("upgrade rod auto-repair: %w", err)
	}
	return &result, level, nil
}

func incrementAutoRepairLevel(state json.RawMessage) (json.RawMessage, int, error) {
	var root, fishing map[string]json.RawMessage
	if err := json.Unmarshal(state, &root); err != nil {
		return nil, 0, fmt.Errorf("decode player state: %w", err)
	}
	if root == nil {
		root = make(map[string]json.RawMessage)
	}
	if nested, ok := root["fishing"]; ok {
		if err := json.Unmarshal(nested, &fishing); err != nil {
			return nil, 0, fmt.Errorf("decode fishing state: %w", err)
		}
	} else {
		fishing = legacyFishingState(root)
	}
	if fishing == nil {
		fishing = make(map[string]json.RawMessage)
	}
	const levelKey = "auto_repair_level"
	levelRaw, ok := fishing[levelKey]
	if !ok {
		for key, value := range fishing {
			if strings.EqualFold(key, "autorepairlevel") {
				levelRaw = value
				break
			}
		}
	}
	var level int
	if len(levelRaw) > 0 {
		if err := json.Unmarshal(levelRaw, &level); err != nil {
			return nil, 0, fmt.Errorf("decode auto-repair level: %w", err)
		}
	}
	if level < 0 || level == math.MaxInt {
		return nil, 0, fmt.Errorf("%w: invalid auto-repair level", ErrInvalidInput)
	}
	level++
	fishing[levelKey] = json.RawMessage(fmt.Sprint(level))
	encoded, err := json.Marshal(fishing)
	if err != nil {
		return nil, 0, err
	}
	root["fishing"] = encoded
	encoded, err = json.Marshal(root)
	return encoded, level, err
}

func legacyFishingState(root map[string]json.RawMessage) map[string]json.RawMessage {
	fields := make(map[string]json.RawMessage)
	legacy := false
	for key, value := range root {
		switch strings.ToLower(strings.ReplaceAll(key, "_", "")) {
		case "selecteddepthid", "autorepairlevel", "recoveruntilms", "recoveruntil", "lowdurability", "allowcoinfallback":
			legacy = true
			fields[key] = value
		case "phase":
			var phase string
			legacy = legacy || (json.Unmarshal(value, &phase) == nil && (phase == "charging" || phase == "reeling"))
			fields[key] = value
		case "running", "progress", "tension", "recoverfrom", "autorepairatms", "autorepairat", "autostopped",
			"manualresume", "lasttickatms", "lasttickat", "bite":
			fields[key] = value
		}
	}
	if !legacy {
		return nil
	}
	return fields
}
