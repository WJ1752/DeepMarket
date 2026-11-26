package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"path"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

const migrationLockKey int64 = 0x444545504d4b54 // DEEPMKT

// OpenPool opens a connection pool and verifies PostgreSQL is reachable.
func OpenPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("create PostgreSQL pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping PostgreSQL: %w", err)
	}
	return pool, nil
}

// Migrate applies pending embedded SQL files in filename order and returns their names.
func Migrate(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	paths, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("list embedded migrations: %w", err)
	}

	// Read committed lets a waiting runner see migrations committed by the lock holder.
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin migration transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationLockKey); err != nil {
		return nil, fmt.Errorf("acquire schema migration lock: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`); err != nil {
		return nil, fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := make([]string, 0, len(paths))
	for _, migrationPath := range paths {
		version := path.Base(migrationPath)
		var recorded bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, version).Scan(&recorded); err != nil {
			return nil, fmt.Errorf("check migration %s: %w", version, err)
		}
		if recorded {
			continue
		}

		sql, err := migrationFiles.ReadFile(migrationPath)
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", version, err)
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return nil, fmt.Errorf("apply migration %s: %w", version, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
			return nil, fmt.Errorf("record migration %s: %w", version, err)
		}
		applied = append(applied, version)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit schema migrations: %w", err)
	}
	return applied, nil
}
