package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"deepmarket/server/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInsufficientMaterial = errors.New("insufficient material")
	ErrUnauthorized         = errors.New("unauthorized session")
)

// Affix is a typed equipment bonus with a fractional value.
type Affix struct {
	Type  string  `json:"type"`
	Value float64 `json:"value"`
}

// EquipmentInstance is a persisted piece of player equipment.
type EquipmentInstance struct {
	ID            int64     `json:"id"`
	UserID        int64     `json:"user_id"`
	TemplateID    string    `json:"template_id"`
	SlotType      string    `json:"slot_type"`
	Equipped      bool      `json:"equipped"`
	Durability    int       `json:"durability"`
	MaxDurability int       `json:"max_durability"`
	EnhanceLevel  int       `json:"enhance_level"`
	Affixes       []Affix   `json:"affixes"`
	Locked        bool      `json:"locked"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// InventoryItem is a persisted stack or individual item in player inventory.
type InventoryItem struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	ItemKind  string    `json:"item_kind"`
	ItemID    string    `json:"item_id"`
	Tier      string    `json:"tier"`
	Traits    []string  `json:"traits"`
	WeightG   int       `json:"weight_g"`
	Quantity  int64     `json:"quantity"`
	CreatedAt time.Time `json:"created_at"`
}

// NewInventoryItem describes an item to insert in a fishing transition.
type NewInventoryItem struct {
	ItemKind string
	ItemID   string
	Tier     string
	Traits   []string
	WeightG  int
	Quantity int64
}

// LedgerEntryInput describes one audit entry for the transition's inventory revision.
type LedgerEntryInput struct {
	EventType  string
	Delta      map[string]any
	RequestKey *string
}

// FishingCommitInput describes all changes in a single fishing transition.
type FishingCommitInput struct {
	UserID           int64
	ExpectedVersion  int64
	CoinsDelta       int64
	NewState         json.RawMessage
	SettleAt         *time.Time
	RodID            int64
	NewRodDurability int
	AddedItems       []NewInventoryItem
	MaterialDeltas   map[string]int64
	LedgerEntries    []LedgerEntryInput
}

// FishingCommitResult contains the committed revision and any affected items.
type FishingCommitResult struct {
	Player        Player
	Rod           *EquipmentInstance
	InsertedItems []InventoryItem
}

// FishingRepo manages sessions, equipment, and fishing transitions in PostgreSQL.
type FishingRepo struct {
	pool *pgxpool.Pool
}

// NewFishingRepo creates a repository backed by pool.
func NewFishingRepo(pool *pgxpool.Pool) *FishingRepo {
	return &FishingRepo{pool: pool}
}

// CreateSession creates a session with a random ID and database-clock expiry.
func (r *FishingRepo) CreateSession(ctx context.Context, userID int64, ttl time.Duration, ip, userAgent string) (*auth.Session, error) {
	id, err := auth.GenerateSessionID()
	if err != nil {
		return nil, fmt.Errorf("generate session ID: %w", err)
	}
	var session auth.Session
	err = r.pool.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
		VALUES ($1, $2, NOW() + $3::interval, $4, $5)
		RETURNING id, user_id, expires_at, ip, user_agent, created_at`,
		id, userID, pgtype.Interval{Microseconds: ttl.Microseconds(), Valid: true}, ip, userAgent,
	).Scan(sessionTargets(&session)...)
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}
	return &session, nil
}

// GetSession returns an unexpired session for an enabled account.
func (r *FishingRepo) GetSession(ctx context.Context, sessionID string) (*auth.Session, error) {
	var session auth.Session
	err := r.pool.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.expires_at, s.ip, s.user_agent, s.created_at
		FROM sessions AS s
		JOIN users AS u ON u.id = s.user_id
		WHERE s.id = $1 AND s.expires_at > NOW() AND NOT u.disabled`, sessionID,
	).Scan(sessionTargets(&session)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	return &session, nil
}

func sessionTargets(s *auth.Session) []any {
	return []any{&s.ID, &s.UserID, &s.ExpiresAt, &s.IP, &s.UserAgent, &s.CreatedAt}
}

const playerColumns = `user_id, version, inv_rev, coins, black_coins, state,
	last_fishing_settle_at, house_last_claim_at, created_at, updated_at`

// GetPlayerByID loads the current player state and inventory revision.
func (r *FishingRepo) GetPlayerByID(ctx context.Context, userID int64) (*Player, error) {
	var player Player
	err := r.pool.QueryRow(ctx, `SELECT `+playerColumns+` FROM players WHERE user_id = $1`, userID).
		Scan(player.scanTargets()...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get fishing player: %w", err)
	}
	return &player, nil
}

const equipmentColumns = `id, user_id, template_id, slot_type, equipped, durability,
	max_durability, enhance_level, affixes, locked, created_at, updated_at`

func (eq *EquipmentInstance) scanTargets() []any {
	return []any{&eq.ID, &eq.UserID, &eq.TemplateID, &eq.SlotType, &eq.Equipped, &eq.Durability,
		&eq.MaxDurability, &eq.EnhanceLevel, &eq.Affixes, &eq.Locked, &eq.CreatedAt, &eq.UpdatedAt}
}

// CreateEquipment inserts equipment and replaces its slot's equipped item when requested.
func (r *FishingRepo) CreateEquipment(ctx context.Context, eq EquipmentInstance) (*EquipmentInstance, error) {
	var created *EquipmentInstance
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if err := lockFishingUser(ctx, tx, eq.UserID); err != nil {
			return err
		}
		if eq.Equipped {
			if err := unequipSlot(ctx, tx, eq.UserID, eq.SlotType); err != nil {
				return err
			}
		}
		var err error
		created, err = insertEquipment(ctx, tx, eq)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("create equipment: %w", err)
	}
	return created, nil
}

func insertEquipment(ctx context.Context, tx pgx.Tx, eq EquipmentInstance) (*EquipmentInstance, error) {
	if eq.Affixes == nil {
		eq.Affixes = []Affix{}
	}
	var created EquipmentInstance
	err := tx.QueryRow(ctx, `
		INSERT INTO equipment_instances (user_id, template_id, slot_type, equipped,
			durability, max_durability, enhance_level, affixes, locked)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING `+equipmentColumns,
		eq.UserID, eq.TemplateID, eq.SlotType, eq.Equipped, eq.Durability,
		eq.MaxDurability, eq.EnhanceLevel, eq.Affixes, eq.Locked,
	).Scan(created.scanTargets()...)
	if err != nil {
		return nil, fmt.Errorf("insert equipment: %w", err)
	}
	return &created, nil
}

func unequipSlot(ctx context.Context, tx pgx.Tx, userID int64, slotType string) error {
	_, err := tx.Exec(ctx, `
		UPDATE equipment_instances SET equipped = FALSE, updated_at = NOW()
		WHERE user_id = $1 AND slot_type = $2 AND equipped`, userID, slotType)
	if err != nil {
		return fmt.Errorf("unequip equipment slot: %w", err)
	}
	return nil
}

// SetEquippedRod equips a rod owned by the player.
func (r *FishingRepo) SetEquippedRod(ctx context.Context, userID, equipID int64) error {
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if err := lockFishingUser(ctx, tx, userID); err != nil {
			return err
		}
		if err := unequipSlot(ctx, tx, userID, "rod"); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE equipment_instances SET equipped = TRUE, updated_at = NOW()
			WHERE id = $1 AND user_id = $2 AND slot_type = 'rod'`, equipID, userID)
		if err != nil {
			return fmt.Errorf("equip rod: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("set equipped rod: %w", err)
	}
	return nil
}

// GetEquippedRod returns the player's currently equipped fishing rod.
func (r *FishingRepo) GetEquippedRod(ctx context.Context, userID int64) (*EquipmentInstance, error) {
	return getEquippedRod(ctx, r.pool, userID)
}

func getEquippedRod(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, userID int64) (*EquipmentInstance, error) {
	var rod EquipmentInstance
	err := queryer.QueryRow(ctx, `
		SELECT `+equipmentColumns+` FROM equipment_instances
		WHERE user_id = $1 AND slot_type = 'rod' AND equipped
		ORDER BY id LIMIT 1`, userID,
	).Scan(rod.scanTargets()...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get equipped rod: %w", err)
	}
	return &rod, nil
}

// EnsureStarterRod returns the equipped rod or inserts a new, equipped starter rod.
func (r *FishingRepo) EnsureStarterRod(ctx context.Context, userID int64) (*EquipmentInstance, error) {
	var rod *EquipmentInstance
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if err := lockFishingUser(ctx, tx, userID); err != nil {
			return err
		}
		var err error
		rod, err = getEquippedRod(ctx, tx, userID)
		if !errors.Is(err, ErrNotFound) {
			return err
		}
		rod, err = insertEquipment(ctx, tx, EquipmentInstance{
			UserID: userID, TemplateID: "tide", SlotType: "rod", Equipped: true,
			Durability: 1000, MaxDurability: 1000,
		})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("ensure starter rod: %w", err)
	}
	return rod, nil
}

// GetMaterialQty returns the total quantity across the player's material stacks.
func (r *FishingRepo) GetMaterialQty(ctx context.Context, userID int64, itemID string) (int64, error) {
	var qty int64
	err := r.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(quantity), 0)::bigint FROM inventory_items
		WHERE user_id = $1 AND item_kind = 'material' AND item_id = $2`, userID, itemID,
	).Scan(&qty)
	if err != nil {
		return 0, fmt.Errorf("get material quantity: %w", err)
	}
	return qty, nil
}

// AddMaterial increases the player's quantity of a material.
func (r *FishingRepo) AddMaterial(ctx context.Context, userID int64, itemID string, qty int64) error {
	if itemID == "" || qty <= 0 {
		return fmt.Errorf("%w: material ID and positive quantity required", ErrInvalidInput)
	}
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if err := lockFishingUser(ctx, tx, userID); err != nil {
			return err
		}
		return creditMaterial(ctx, tx, userID, itemID, qty)
	})
	if err != nil {
		return fmt.Errorf("add material: %w", err)
	}
	return nil
}

const inventoryColumns = `id, user_id, item_kind, item_id, tier, traits, weight_g, quantity, created_at`

func (item *InventoryItem) scanTargets() []any {
	return []any{&item.ID, &item.UserID, &item.ItemKind, &item.ItemID, &item.Tier,
		&item.Traits, &item.WeightG, &item.Quantity, &item.CreatedAt}
}

// ListFishByUser returns the player's fish, newest first.
func (r *FishingRepo) ListFishByUser(ctx context.Context, userID int64) ([]InventoryItem, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+inventoryColumns+` FROM inventory_items
		WHERE user_id = $1 AND item_kind = 'fish' ORDER BY id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list fish: %w", err)
	}
	defer rows.Close()
	fish := []InventoryItem{}
	for rows.Next() {
		var item InventoryItem
		if err := rows.Scan(item.scanTargets()...); err != nil {
			return nil, fmt.Errorf("scan fish: %w", err)
		}
		fish = append(fish, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list fish: %w", err)
	}
	return fish, nil
}

// CommitFishingTransition updates the player, assets and audit trail atomically.
func (r *FishingRepo) CommitFishingTransition(ctx context.Context, in FishingCommitInput) (*FishingCommitResult, error) {
	if len(in.NewState) == 0 {
		in.NewState = json.RawMessage(`{}`)
	}
	if !json.Valid(in.NewState) {
		return nil, fmt.Errorf("%w: invalid fishing state JSON", ErrInvalidInput)
	}
	var result FishingCommitResult
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		if err := lockFishingUser(ctx, tx, in.UserID); err != nil {
			return err
		}
		if err := updateFishingPlayer(ctx, tx, in, &result.Player); err != nil {
			return err
		}
		if in.RodID > 0 {
			rod, err := updateFishingRod(ctx, tx, in)
			if err != nil {
				return err
			}
			result.Rod = rod
		}
		for _, added := range in.AddedItems {
			item, err := insertInventoryItem(ctx, tx, in.UserID, added)
			if err != nil {
				return err
			}
			result.InsertedItems = append(result.InsertedItems, item)
		}
		for itemID, delta := range in.MaterialDeltas {
			if err := applyMaterialDelta(ctx, tx, in.UserID, itemID, delta); err != nil {
				return err
			}
		}
		return recordFishingLedger(ctx, tx, result.Player, in.LedgerEntries)
	})
	if err != nil {
		return nil, fmt.Errorf("commit fishing transition: %w", err)
	}
	return &result, nil
}

// Lock the owning row first to serialize equipment swaps and material upserts,
// including when a slot or stack has no rows to lock yet.
func lockFishingUser(ctx context.Context, tx pgx.Tx, userID int64) error {
	err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE`, userID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock fishing account: %w", err)
	}
	return nil
}

func updateFishingPlayer(ctx context.Context, tx pgx.Tx, in FishingCommitInput, player *Player) error {
	err := tx.QueryRow(ctx, `
		UPDATE players
		SET version = version + 1, inv_rev = inv_rev + 1, coins = coins + $3,
			state = $4, last_fishing_settle_at = COALESCE($5, last_fishing_settle_at), updated_at = NOW()
		WHERE user_id = $1 AND version = $2
		RETURNING `+playerColumns,
		in.UserID, in.ExpectedVersion, in.CoinsDelta, in.NewState, in.SettleAt,
	).Scan(player.scanTargets()...)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM players WHERE user_id = $1)`, in.UserID).Scan(&exists); err != nil {
			return fmt.Errorf("check fishing player existence: %w", err)
		}
		if !exists {
			return ErrNotFound
		}
		return ErrVersionConflict
	}
	if err != nil {
		return fmt.Errorf("update fishing player: %w", err)
	}
	return nil
}

func updateFishingRod(ctx context.Context, tx pgx.Tx, in FishingCommitInput) (*EquipmentInstance, error) {
	if in.NewRodDurability < 0 {
		return nil, fmt.Errorf("%w: rod durability must be nonnegative", ErrInvalidInput)
	}
	var rod EquipmentInstance
	err := tx.QueryRow(ctx, `
		UPDATE equipment_instances SET durability = $3, updated_at = NOW()
		WHERE id = $1 AND user_id = $2
		RETURNING `+equipmentColumns, in.RodID, in.UserID, in.NewRodDurability,
	).Scan(rod.scanTargets()...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("update fishing rod: %w", err)
	}
	return &rod, nil
}

func insertInventoryItem(ctx context.Context, tx pgx.Tx, userID int64, in NewInventoryItem) (InventoryItem, error) {
	var item InventoryItem
	if in.ItemKind == "" || in.ItemID == "" || in.WeightG < 0 || in.Quantity <= 0 {
		return item, fmt.Errorf("%w: invalid inventory item", ErrInvalidInput)
	}
	if in.Tier == "" {
		in.Tier = "normal"
	}
	if len(in.Traits) == 0 {
		in.Traits = []string{}
	}
	err := tx.QueryRow(ctx, `
		INSERT INTO inventory_items (user_id, item_kind, item_id, tier, traits, weight_g, quantity)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+inventoryColumns,
		userID, in.ItemKind, in.ItemID, in.Tier, in.Traits, in.WeightG, in.Quantity,
	).Scan(item.scanTargets()...)
	if err != nil {
		return item, fmt.Errorf("insert inventory item: %w", err)
	}
	return item, nil
}

func applyMaterialDelta(ctx context.Context, tx pgx.Tx, userID int64, itemID string, delta int64) error {
	if delta == 0 {
		return nil
	}
	if itemID == "" {
		return fmt.Errorf("%w: material ID required", ErrInvalidInput)
	}
	if delta > 0 {
		return creditMaterial(ctx, tx, userID, itemID, delta)
	}
	return debitMaterial(ctx, tx, userID, itemID, delta)
}

func creditMaterial(ctx context.Context, tx pgx.Tx, userID int64, itemID string, qty int64) error {
	tag, err := tx.Exec(ctx, `
		UPDATE inventory_items SET quantity = quantity + $3
		WHERE id = (
			SELECT id FROM inventory_items
			WHERE user_id = $1 AND item_kind = 'material' AND item_id = $2
			ORDER BY id LIMIT 1
		)`, userID, itemID, qty)
	if err != nil {
		return fmt.Errorf("credit material: %w", err)
	}
	if tag.RowsAffected() == 0 {
		_, err = insertInventoryItem(ctx, tx, userID, NewInventoryItem{
			ItemKind: "material", ItemID: itemID, Quantity: qty,
		})
	}
	return err
}

func debitMaterial(ctx context.Context, tx pgx.Tx, userID int64, itemID string, delta int64) error {
	rows, err := tx.Query(ctx, `
		SELECT id, quantity FROM inventory_items
		WHERE user_id = $1 AND item_kind = 'material' AND item_id = $2
		ORDER BY id FOR UPDATE`, userID, itemID)
	if err != nil {
		return fmt.Errorf("lock material stacks: %w", err)
	}
	defer rows.Close()
	type stack struct {
		id  int64
		qty int64
	}
	var updates []stack
	// Keep the outstanding debit negative so MinInt64 is representable.
	for rows.Next() {
		var s stack
		if err := rows.Scan(&s.id, &s.qty); err != nil {
			return fmt.Errorf("scan material stack: %w", err)
		}
		if s.qty < 0 {
			return fmt.Errorf("%w: negative material stack quantity", ErrInvalidInput)
		}
		if delta < 0 && s.qty > 0 {
			remaining := s.qty + delta
			updates = append(updates, stack{id: s.id, qty: max(remaining, 0)})
			delta = min(remaining, 0)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read material stacks: %w", err)
	}
	if delta < 0 {
		return ErrInsufficientMaterial
	}
	for _, s := range updates {
		if s.qty == 0 {
			_, err = tx.Exec(ctx, `DELETE FROM inventory_items WHERE id = $1`, s.id)
		} else {
			_, err = tx.Exec(ctx, `UPDATE inventory_items SET quantity = $2 WHERE id = $1`, s.id, s.qty)
		}
		if err != nil {
			return fmt.Errorf("debit material: %w", err)
		}
	}
	return nil
}

func recordFishingLedger(ctx context.Context, tx pgx.Tx, player Player, entries []LedgerEntryInput) error {
	for _, entry := range entries {
		delta, err := encodeState(entry.Delta)
		if err != nil {
			return fmt.Errorf("encode fishing ledger delta: %w", err)
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO asset_ledger (user_id, inv_rev, event_type, delta, request_key)
			VALUES ($1, $2, $3, $4, $5)`, player.UserID, player.InvRev, entry.EventType, delta, entry.RequestKey)
		if err != nil {
			return fmt.Errorf("insert fishing ledger entry: %w", err)
		}
	}
	return nil
}
