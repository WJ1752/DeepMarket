// Package httpapi exposes the DeepMarket API and event stream.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"deepmarket/server/internal/fishing"
	"deepmarket/server/internal/fx"
	"deepmarket/server/internal/lottery"
	"deepmarket/server/internal/repo"
	"deepmarket/server/internal/sse"
)

type api struct {
	repo          *repo.FishingRepo
	players       *repo.PlayerRepo
	economy       *repo.EconomyRepo
	lottery       *repo.LotteryRepo
	lotteryWorker *lottery.Worker
	engine        *fishing.Engine
	hub           *sse.Hub
	fxConfig      fx.Config
	clock         func() time.Time
}

// ServerDeps contains the repositories, services, and clock for the full API.
type ServerDeps struct {
	PlayerRepo    *repo.PlayerRepo
	FishingRepo   *repo.FishingRepo
	EconomyRepo   *repo.EconomyRepo
	LotteryRepo   *repo.LotteryRepo
	Engine        *fishing.Engine
	Hub           *sse.Hub
	FXConfig      fx.Config
	FXWorker      *fx.Worker
	LotteryWorker *lottery.Worker
	Clock         func() time.Time
}

// NewHandler routes the fishing, streaming, and health endpoints.
func NewHandler(fishingRepo *repo.FishingRepo, engine *fishing.Engine, hub *sse.Hub) http.Handler {
	return NewFullHandler(ServerDeps{FishingRepo: fishingRepo, Engine: engine, Hub: hub})
}

// NewFullHandler adds routes for the configured repositories.
func NewFullHandler(deps ServerDeps) http.Handler {
	if deps.Clock == nil {
		deps.Clock = time.Now
	}
	if deps.FXConfig == (fx.Config{}) {
		deps.FXConfig = fx.DefaultConfig()
	}
	if deps.LotteryRepo != nil && deps.LotteryWorker == nil {
		deps.LotteryWorker = lottery.NewWorker(deps.LotteryRepo, deps.Hub, 0, deps.Clock)
	}
	a := api{
		repo: deps.FishingRepo, players: deps.PlayerRepo, economy: deps.EconomyRepo,
		lottery: deps.LotteryRepo, lotteryWorker: deps.LotteryWorker,
		engine: deps.Engine, hub: deps.Hub, fxConfig: deps.FXConfig, clock: deps.Clock,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/fishing/start", a.authenticated(false, a.start))
	mux.HandleFunc("POST /api/fishing/stop", a.authenticated(false, a.stop))
	mux.HandleFunc("GET /api/fishing/state", a.authenticated(false, a.state))
	mux.HandleFunc("GET /api/sse/stream", a.authenticated(true, a.stream))
	mux.HandleFunc("GET /api/events", a.authenticated(true, a.stream))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	if a.players != nil {
		a.registerAuthRoutes(mux)
	}
	if a.economy != nil {
		a.registerEconomyRoutes(mux)
	}
	if a.lottery != nil {
		a.registerLotteryRoutes(mux)
	}
	return mux
}

func (a api) authenticated(eventSource bool, next func(http.ResponseWriter, *http.Request, int64)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := sessionToken(r, eventSource)
		if token == "" {
			writeAPIError(w, http.StatusUnauthorized, "unauthorized session")
			return
		}
		session, err := a.repo.GetSession(r.Context(), token)
		if errors.Is(err, repo.ErrUnauthorized) {
			writeAPIError(w, http.StatusUnauthorized, "unauthorized session")
			return
		}
		if err != nil {
			writeFishingError(w, r, err)
			return
		}
		next(w, r, session.UserID)
	}
}

func sessionToken(r *http.Request, eventSource bool) string {
	if header := r.Header.Get("Authorization"); header != "" {
		parts := strings.Fields(header)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			return parts[1]
		}
		return ""
	}
	if cookie, err := r.Cookie("deepmarket_session"); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	if eventSource {
		return r.URL.Query().Get("token")
	}
	return ""
}

func (a api) start(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		DepthID string `json:"depth_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if err := decoder.Decode(&body); !errors.Is(err, io.EOF) {
		if err != nil || !errors.Is(decoder.Decode(new(json.RawMessage)), io.EOF) {
			writeAPIError(w, http.StatusBadRequest, "invalid fishing start body")
			return
		}
	}
	result, err := a.engine.Start(r.Context(), userID, body.DepthID)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "running": result.State.Running, "depth_id": result.State.SelectedDepthID,
		"player_version": result.Player.Version, "inv_rev": result.Player.InvRev, "rod": result.Rod,
	})
}

func (a api) stop(w http.ResponseWriter, r *http.Request, userID int64) {
	result, err := a.engine.Stop(r.Context(), userID)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "running": result.State.Running,
		"player_version": result.Player.Version, "inv_rev": result.Player.InvRev, "rod": result.Rod,
	})
}

func (a api) state(w http.ResponseWriter, r *http.Request, userID int64) {
	result, err := a.engine.GetState(r.Context(), userID)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "running": result.State.Running, "depth_id": result.State.SelectedDepthID,
		"player_version": result.Player.Version, "inv_rev": result.Player.InvRev, "coins": result.Player.Coins,
		"rod": result.Rod, "fishing": result.State,
	})
}

func (a api) stream(w http.ResponseWriter, r *http.Request, userID int64) {
	a.hub.ServeHTTP(w, r, userID, r.URL.Query().Get("global") != "false")
}

func writeFishingError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, repo.ErrInvalidInput):
		writeAPIError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, repo.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, repo.ErrVersionConflict), errors.Is(err, repo.ErrInsufficientMaterial),
		errors.Is(err, repo.ErrUsernameTaken), errors.Is(err, repo.ErrInsufficientCoins),
		errors.Is(err, repo.ErrPositionLimit), errors.Is(err, repo.ErrInsufficientPosition),
		errors.Is(err, repo.ErrAlreadyRevealed), errors.Is(err, repo.ErrBatchAlreadyDrawn), errors.Is(err, repo.ErrInsufficientTickets),
		errors.Is(err, fishing.ErrLowDurability), errors.Is(err, fishing.ErrRodBroken):
		writeAPIError(w, http.StatusConflict, err.Error())
	default:
		slog.Error("API request failed", "method", r.Method, "path", r.URL.Path, "error", err)
		writeAPIError(w, http.StatusInternalServerError, "internal server error")
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if err := decoder.Decode(dst); err != nil || !errors.Is(decoder.Decode(new(json.RawMessage)), io.EOF) {
		writeAPIError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

func writeAPIError(w http.ResponseWriter, status int, message string) {
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", "Bearer")
	}
	writeJSON(w, status, map[string]any{"ok": false, "error": message})
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
