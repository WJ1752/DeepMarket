package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"deepmarket/server/internal/lottery"
)

func (a api) registerLotteryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/lottery/status", a.authenticated(false, a.lotteryStatus))
	mux.HandleFunc("POST /api/lottery/craft", a.authenticated(false, a.lotteryCraft))
	mux.HandleFunc("POST /api/lottery/draw", a.authenticated(false, a.lotteryDraw))
	mux.HandleFunc("POST /api/lottery/claim", a.authenticated(false, a.lotteryClaim))
	mux.HandleFunc("GET /api/scratch/cards", a.authenticated(false, a.scratchList))
	mux.HandleFunc("POST /api/scratch/buy", a.authenticated(false, a.scratchBuy))
	mux.HandleFunc("POST /api/scratch/reveal", a.authenticated(false, a.scratchReveal))
}

func (a api) lotteryStatus(w http.ResponseWriter, r *http.Request, userID int64) {
	status, err := a.lottery.GetLotteryStatus(r.Context(), userID, a.clock())
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "current_batch": status.CurrentBatch, "recent_draws": status.RecentDraws,
		"blank_tickets": status.BlankTickets, "tickets": status.Tickets, "pools": status.Pools,
	})
}

func (a api) lotteryCraft(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		Tier       string `json:"tier"`
		Quantity   int    `json:"quantity"`
		RequestKey string `json:"request_key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	now := a.clock()
	result, err := a.lottery.CraftLotteryTickets(r.Context(), userID, body.Tier, body.Quantity,
		lottery.BatchIDAt(now), lottery.BatchStart(now), lottery.BatchEnd(now), body.RequestKey, nil, now)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "tickets": result.Tickets, "blank_tickets": result.BlankTickets,
		"player": publicPlayer(result.Player), "replayed": result.Replayed,
	})
}

func (a api) lotteryDraw(w http.ResponseWriter, r *http.Request, _ int64) {
	var body struct {
		BatchID string `json:"batch_id"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	start, err := time.Parse(time.RFC3339, body.BatchID)
	if err != nil || body.BatchID != lottery.BatchIDAt(start) {
		writeAPIError(w, http.StatusBadRequest, "invalid lottery batch ID")
		return
	}
	batch := lottery.Batch{ID: body.BatchID, StartAt: start, EndAt: lottery.BatchEnd(start)}
	draws, newlyDrawn, err := a.lotteryWorker.DrawBatch(r.Context(), batch, a.clock())
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "batch_id": body.BatchID, "draws": draws, "newly_drawn": newlyDrawn,
	})
}

func (a api) lotteryClaim(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		RequestKey string `json:"request_key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	result, err := a.lottery.ClaimLotteryTickets(r.Context(), userID, body.RequestKey, a.clock())
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "claimed": result.Claimed, "tickets": result.Tickets,
		"player": publicPlayer(result.Player), "replayed": result.Replayed,
	})
}

func (a api) scratchList(w http.ResponseWriter, r *http.Request, userID int64) {
	cards, err := a.lottery.ListScratchCards(r.Context(), userID)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cards": cards})
}

func (a api) scratchBuy(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		CardType   string `json:"card_type"`
		RequestKey string `json:"request_key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	cardType, ok := lottery.GetScratchType(body.CardType)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "unknown scratch card type")
		return
	}
	result, err := a.lottery.BuyScratchCard(r.Context(), userID, cardType, body.RequestKey, nil)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "card": result.Card, "player": publicPlayer(result.Player), "replayed": result.Replayed,
	})
}

func (a api) scratchReveal(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		CardID     int64  `json:"card_id"`
		RequestKey string `json:"request_key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	result, err := a.lottery.RevealScratchCard(r.Context(), userID, body.CardID, body.RequestKey)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	if !result.Replayed && a.hub != nil {
		payload := struct {
			Card lottery.PublicScratchCard `json:"card"`
		}{Card: result.Card}
		if _, err := a.hub.PublishUser(userID, "scratch_revealed", result.Player.InvRev, result.Player.Version, payload); err != nil {
			slog.Error("publish scratch reveal", "user_id", userID, "card_id", body.CardID, "error", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "card": result.Card, "player": publicPlayer(result.Player), "replayed": result.Replayed,
	})
}
