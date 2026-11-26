package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"deepmarket/server/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUsernameTaken   = errors.New("username already taken")
	ErrNotFound        = errors.New("player account not found")
	ErrVersionConflict = errors.New("player version conflict")
	ErrInvalidInput    = errors.New("invalid player account input")
)

// User holds the persisted authentication and account metadata.
type User struct {
	ID           int64
	Username     string
	Email        *string
	PasswordHash string
	Role         string
	Disabled     bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Player holds the authoritative player state and asset revision.
type Player struct {
	UserID              int64
	Version             int64
	InvRev              int64
	Coins               int64
	BlackCoins          int64
	State               json.RawMessage
	LastFishingSettleAt *time.Time
	HouseLastClaimAt    *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// AccountSnapshot combines the account and player rows from one operation.
type AccountSnapshot struct {
	User   User
	Player Player
}

// PlayerRepo reads and writes player accounts in PostgreSQL.
type PlayerRepo struct {
	pool *pgxpool.Pool
}

// NewPlayerRepo creates a repository backed by pool.
func NewPlayerRepo(pool *pgxpool.Pool) *PlayerRepo {
	return &PlayerRepo{pool: pool}
}

// CreatePlayerAccount creates the user, player, and initial audit entry atomically.
func (r *PlayerRepo) CreatePlayerAccount(ctx context.Context, username, plainPassword string, initialState map[string]any) (*AccountSnapshot, error) {
	username = strings.TrimSpace(username)
	if length := utf8.RuneCountInString(username); length < 3 || length > 32 {
		return nil, fmt.Errorf("%w: username must be 3 to 32 characters", ErrInvalidInput)
	}

	state, err := encodeState(initialState)
	if err != nil {
		return nil, err
	}
	passwordHash, err := auth.HashPassword(plainPassword)
	if err != nil {
		if utf8.RuneCountInString(plainPassword) < auth.MinPasswordLen {
			return nil, fmt.Errorf("%w: %w", ErrInvalidInput, err)
		}
		return nil, fmt.Errorf("hash password: %w", err)
	}

	var account AccountSnapshot
	err = pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			INSERT INTO users (username, password_hash)
			VALUES ($1, $2)
			RETURNING id, username, email, password_hash, role, disabled, created_at, updated_at`,
			username, passwordHash,
		).Scan(account.User.scanTargets()...)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return ErrUsernameTaken
			}
			return fmt.Errorf("insert user: %w", err)
		}

		err = tx.QueryRow(ctx, `
			INSERT INTO players (user_id, state)
			VALUES ($1, $2)
			RETURNING user_id, version, inv_rev, coins, black_coins, state,
			          last_fishing_settle_at, house_last_claim_at, created_at, updated_at`,
			account.User.ID, state,
		).Scan(account.Player.scanTargets()...)
		if err != nil {
			return fmt.Errorf("insert player: %w", err)
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO asset_ledger (user_id, inv_rev, event_type, delta)
			VALUES ($1, 1, 'account_created', '{"coins":0}')`, account.User.ID)
		if err != nil {
			return fmt.Errorf("record account creation: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("create player account: %w", err)
	}
	return &account, nil
}

// GetAccountByUsername loads the account and player in a single query.
func (r *PlayerRepo) GetAccountByUsername(ctx context.Context, username string) (*AccountSnapshot, error) {
	var account AccountSnapshot
	err := r.pool.QueryRow(ctx, `
		SELECT u.id, u.username, u.email, u.password_hash, u.role, u.disabled, u.created_at, u.updated_at,
		       p.user_id, p.version, p.inv_rev, p.coins, p.black_coins, p.state,
		       p.last_fishing_settle_at, p.house_last_claim_at, p.created_at, p.updated_at
		FROM users AS u
		JOIN players AS p ON p.user_id = u.id
		WHERE u.username = $1`, strings.TrimSpace(username),
	).Scan(append(account.User.scanTargets(), account.Player.scanTargets()...)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get player account: %w", err)
	}
	return &account, nil
}

// UpdatePlayerOptimistic replaces the player state and records the asset revision atomically.
// A nil newState replaces the state with an empty JSON object.
func (r *PlayerRepo) UpdatePlayerOptimistic(ctx context.Context, userID int64, expectedVersion int64, coinsDelta int64, newState map[string]any) (*Player, error) {
	state, err := encodeState(newState)
	if err != nil {
		return nil, err
	}

	var player Player
	err = pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			UPDATE players
			SET version = version + 1, inv_rev = inv_rev + 1,
			    coins = coins + $3, state = $4, updated_at = NOW()
			WHERE user_id = $1 AND version = $2
			RETURNING user_id, version, inv_rev, coins, black_coins, state,
			          last_fishing_settle_at, house_last_claim_at, created_at, updated_at`,
			userID, expectedVersion, coinsDelta, state,
		).Scan(player.scanTargets()...)
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM players WHERE user_id = $1)`, userID).Scan(&exists); err != nil {
				return fmt.Errorf("check player existence: %w", err)
			}
			if !exists {
				return ErrNotFound
			}
			return ErrVersionConflict
		}
		if err != nil {
			return fmt.Errorf("update player: %w", err)
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO asset_ledger (user_id, inv_rev, event_type, delta)
			VALUES ($1, $2, 'player_updated', jsonb_build_object('coins', $3::bigint, 'state_updated', true))`,
			player.UserID, player.InvRev, coinsDelta,
		)
		if err != nil {
			return fmt.Errorf("record player update: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("update player optimistically: %w", err)
	}
	return &player, nil
}

// DeleteUserForTest removes a test account and its dependent rows.
func (r *PlayerRepo) DeleteUserForTest(ctx context.Context, userID int64) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
	if err != nil {
		return fmt.Errorf("delete test user: %w", err)
	}
	return nil
}

func (u *User) scanTargets() []any {
	return []any{&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Role, &u.Disabled, &u.CreatedAt, &u.UpdatedAt}
}

func (p *Player) scanTargets() []any {
	return []any{
		&p.UserID, &p.Version, &p.InvRev, &p.Coins, &p.BlackCoins, &p.State,
		&p.LastFishingSettleAt, &p.HouseLastClaimAt, &p.CreatedAt, &p.UpdatedAt,
	}
}

func encodeState(state map[string]any) (json.RawMessage, error) {
	if state == nil {
		return json.RawMessage(`{}`), nil
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("%w: encode player state: %w", ErrInvalidInput, err)
	}
	return encoded, nil
}
