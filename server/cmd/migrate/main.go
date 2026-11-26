package main

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"

	"deepmarket/server/internal/db"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	dsn := os.Getenv("DEEPMARKET_DATABASE_URL")
	if strings.TrimSpace(dsn) == "" {
		return errors.New("DEEPMARKET_DATABASE_URL must be set")
	}

	pool, err := db.OpenPool(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()

	applied, err := db.Migrate(ctx, pool)
	if err != nil {
		return err
	}
	if len(applied) == 0 {
		log.Print("No pending migrations")
	}
	for _, version := range applied {
		log.Printf("Applied migration %s", version)
	}
	return nil
}
