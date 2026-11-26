package repo

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"deepmarket/server/internal/auth"
	"deepmarket/server/internal/db"
)

func TestPhase1SchemaConnectivityAndPlayerAccount(t *testing.T) {
	dsn := os.Getenv("DEEPMARKET_DATABASE_URL")
	if dsn == "" {
		t.Fatal("DEEPMARKET_DATABASE_URL must be set for Phase 1 connectivity test")
	}

	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	pool, err := db.OpenPool(ctx, dsn)
	if err != nil {
		t.Fatalf("open PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	applied, err := db.Migrate(ctx, pool)
	if err != nil {
		t.Fatalf("rerun migrations: %v", err)
	}
	if len(applied) != 0 {
		t.Fatalf("rerun applied migrations %v, want none", applied)
	}
	t.Logf("phase=1 check=schema_connectivity status=passed migrations_reapplied=%d", len(applied))

	players := NewPlayerRepo(pool)
	// Base 36 keeps the complete Unix nanosecond timestamp within the username limit.
	username := "virtual_angler_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	const password = "phase1-angler-password"
	account, err := players.CreatePlayerAccount(ctx, username, password, nil)
	if err != nil {
		t.Fatalf("create player account: %v", err)
	}
	userID := account.User.ID
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := players.DeleteUserForTest(cleanupCtx, userID); err != nil {
			t.Errorf("delete test user %d: %v", userID, err)
		}
	})

	var passwordHash string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&passwordHash); err != nil {
		t.Fatalf("read persisted password hash: %v", err)
	}
	if !strings.HasPrefix(passwordHash, "scrypt$32768$8$1$") || strings.Contains(passwordHash, password) {
		t.Fatal("persisted password hash must use the expected scrypt format and omit the plaintext password")
	}
	verified, err := auth.VerifyPassword(password, passwordHash)
	if err != nil || !verified {
		t.Fatalf("verify correct password: matched=%t err=%v", verified, err)
	}
	verified, err = auth.VerifyPassword("incorrect-password", passwordHash)
	if err != nil || verified {
		t.Fatalf("verify incorrect password: matched=%t err=%v", verified, err)
	}
	t.Logf("phase=1 check=password_persistence status=passed user_id=%d algorithm=scrypt", userID)

	var version, invRev int64
	if err := pool.QueryRow(ctx, `SELECT version, inv_rev FROM players WHERE user_id = $1`, userID).Scan(&version, &invRev); err != nil {
		t.Fatalf("read persisted player revisions: %v", err)
	}
	if version != 1 || invRev != 1 {
		t.Fatalf("initial player version=%d inv_rev=%d, want version=1 inv_rev=1", version, invRev)
	}
	t.Logf("phase=1 check=player_defaults status=passed user_id=%d players.version=%d inv_rev=%d", userID, version, invRev)

	player, err := players.UpdatePlayerOptimistic(ctx, userID, 1, 100, map[string]any{"phase1": true})
	if err != nil {
		t.Fatalf("update player: %v", err)
	}
	if player.Version != 2 || player.InvRev != 2 || player.Coins != 100 {
		t.Fatalf("updated player version=%d inv_rev=%d coins=%d, want version=2 inv_rev=2 coins=100",
			player.Version, player.InvRev, player.Coins)
	}
	t.Logf("phase=1 check=player_update status=passed user_id=%d players.version=%d inv_rev=%d coins=%d",
		userID, player.Version, player.InvRev, player.Coins)

	if _, err := players.UpdatePlayerOptimistic(ctx, userID, 1, 100, nil); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale player update returned %v, want %v", err, ErrVersionConflict)
	}
	t.Logf("phase=1 check=optimistic_lock status=passed user_id=%d stale_version=1 rejected=true", userID)
}
