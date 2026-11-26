package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"deepmarket/server/internal/db"
	"deepmarket/server/internal/fishing"
	"deepmarket/server/internal/fx"
	"deepmarket/server/internal/httpapi"
	"deepmarket/server/internal/lottery"
	"deepmarket/server/internal/repo"
	"deepmarket/server/internal/sse"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("API server exited", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	dsn := os.Getenv("DEEPMARKET_DATABASE_URL")
	if strings.TrimSpace(dsn) == "" {
		return errors.New("DEEPMARKET_DATABASE_URL must be set")
	}
	addr := os.Getenv("DEEPMARKET_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	secret, configured := os.LookupEnv("DEEPMARKET_HMAC_SECRET")
	if configured && strings.TrimSpace(secret) == "" {
		return errors.New("DEEPMARKET_HMAC_SECRET must be non-empty when set")
	}
	key := []byte(secret)
	if !configured {
		key = make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return fmt.Errorf("generate development HMAC secret: %w", err)
		}
		slog.Warn("using an ephemeral SSE signing secret because DEEPMARKET_HMAC_SECRET is unset")
	}

	pool, err := db.OpenPool(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if _, err := db.Migrate(ctx, pool); err != nil {
		return err
	}
	hub, err := sse.NewHub(key)
	if err != nil {
		return err
	}
	fishingRepo := repo.NewFishingRepo(pool)
	economyRepo := repo.NewEconomyRepo(pool)
	lotteryRepo := repo.NewLotteryRepo(pool)
	lotteryRepo.SetRodDurabilityLookup(func(id string) (int, bool) {
		template, ok := fishing.GetRodTemplate(id)
		return template.MaxDurability, ok
	})
	fxConfig := fx.DefaultConfig()
	fxWorker := fx.NewWorker(economyRepo, hub, fxConfig, time.Minute, time.Now)
	lotteryWorker := lottery.NewWorker(lotteryRepo, hub, time.Minute, time.Now)
	fxWorker.Start()
	lotteryWorker.Start()
	engine := fishing.NewEngine(fishingRepo, hub, fishing.EngineConfig{
		OnCatch: func(ctx context.Context, userID int64, fish fishing.FishRoll, qty int64) {
			now := time.Now()
			flows := make([]repo.FXFlow, 0, len(fish.Traits))
			for _, trait := range fish.Traits {
				if _, ok := fx.GetSymbol(trait); ok {
					flows = append(flows, repo.FXFlow{Symbol: trait, Net: float64(qty), Volume: float64(qty)})
				}
			}
			if len(flows) == 0 {
				return
			}
			// The fish has committed even if its timer was canceled during shutdown.
			flowCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			if err := economyRepo.AppendFXFlows(flowCtx, flows, now); err != nil {
				slog.Error("record catch FX flow", "user_id", userID, "error", err)
			}
		},
	})
	handler := httpapi.NewFullHandler(httpapi.ServerDeps{
		PlayerRepo: repo.NewPlayerRepo(pool), FishingRepo: fishingRepo, EconomyRepo: economyRepo,
		LotteryRepo: lotteryRepo, LotteryWorker: lotteryWorker,
		Engine: engine, Hub: hub, FXConfig: fxConfig, FXWorker: fxWorker,
	})
	server := &http.Server{
		Addr: addr, Handler: withWebDist(handler),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: time.Minute,
	}

	serveErr := make(chan error, 1)
	go func() {
		slog.Info("serving DeepMarket API", "addr", addr)
		serveErr <- server.ListenAndServe()
	}()
	select {
	case err = <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	hub.Close()
	engineDone := make(chan struct{})
	go func() {
		defer close(engineDone)
		engine.Shutdown(shutdownCtx)
	}()
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		fxWorker.Shutdown(shutdownCtx)
	}()
	lotteryDone := make(chan struct{})
	go func() {
		defer close(lotteryDone)
		lotteryWorker.Shutdown(shutdownCtx)
	}()
	shutdownErr := server.Shutdown(shutdownCtx)
	if shutdownErr != nil {
		shutdownErr = errors.Join(shutdownErr, server.Close())
	}
	<-engineDone
	<-workerDone
	<-lotteryDone
	return errors.Join(err, shutdownErr)
}

func withWebDist(api http.Handler) http.Handler {
	dirs := []string{os.Getenv("DEEPMARKET_WEB_DIST")}
	if dirs[0] == "" {
		dirs = []string{"../web/dist", "./web/dist"}
	}
	for _, dir := range dirs {
		index, err := os.Stat(filepath.Join(dir, "index.html"))
		if err != nil || !index.Mode().IsRegular() {
			continue
		}
		files := http.Dir(dir)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			name := path.Clean(r.URL.Path)
			if name == "/api" || strings.HasPrefix(name, "/api/") || name == "/healthz" ||
				(r.Method != http.MethodGet && r.Method != http.MethodHead) {
				api.ServeHTTP(w, r)
				return
			}
			if !serveWebFile(w, r, files, name) && !serveWebFile(w, r, files, "/index.html") {
				http.NotFound(w, r)
			}
		})
	}
	return api
}

func serveWebFile(w http.ResponseWriter, r *http.Request, files http.Dir, name string) bool {
	file, err := files.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if name == "/index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	return true
}
