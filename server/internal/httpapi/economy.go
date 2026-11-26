package httpapi

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"deepmarket/server/internal/fishing"
	"deepmarket/server/internal/fx"
	"deepmarket/server/internal/repo"
)

const (
	autoRepairUpgradeCoins     int64 = 100
	autoRepairUpgradeMaterials int64 = 1
)

func (a api) registerEconomyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/guild/inventory", a.authenticated(false, a.inventory))
	mux.HandleFunc("POST /api/guild/sell", a.authenticated(false, a.guildSell))
	mux.HandleFunc("POST /api/fishing/repair", a.authenticated(false, a.repairRod))
	mux.HandleFunc("POST /api/fishing/upgrade", a.authenticated(false, a.upgradeRod))
	mux.HandleFunc("GET /api/fx/quotes", a.authenticated(false, a.fxQuotes))
	mux.HandleFunc("GET /api/fx/candles", a.authenticated(false, a.fxCandles))
	mux.HandleFunc("POST /api/fx/buy", a.authenticated(false, a.fxTrade("buy")))
	mux.HandleFunc("POST /api/fx/sell", a.authenticated(false, a.fxTrade("sell")))
}

func (a api) inventory(w http.ResponseWriter, r *http.Request, userID int64) {
	snapshot, err := a.economy.GetInventorySnapshot(r.Context(), userID)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	quotes := make([]repo.GuildQuoteItem, 0, len(snapshot.Fish))
	for _, fish := range snapshot.Fish {
		quotes = append(quotes, repo.QuoteGuildFish(fish))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "player": publicPlayer(snapshot.Player), "fish": snapshot.Fish,
		"guild_quotes": quotes, "materials": snapshot.Materials, "blank_tickets": snapshot.BlankTickets,
		"rods": snapshot.Rods, "positions": snapshot.Positions,
	})
}

func (a api) guildSell(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		FishIDs []int64 `json:"fish_ids"`
		SellAll bool    `json:"sell_all"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	result, err := a.economy.SellFishAtGuild(r.Context(), userID, body.FishIDs, body.SellAll, a.clock())
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "player": publicPlayer(result.Player), "sold_count": result.SoldCount,
		"coins_earned": result.CoinsEarned, "tickets_earned": result.TicketsEarned, "fx_flows": result.FXFlows,
	})
}

func (a api) repairRod(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		RodID int64 `json:"rod_id"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	rod, player, err := a.economy.ManualRepairRod(r.Context(), userID, body.RodID,
		fishing.DefaultRepairMaterial, fishing.DefaultRepairCost, fishing.DefaultRepairAmount)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "player": publicPlayer(*player), "rod": rod})
}

func (a api) upgradeRod(w http.ResponseWriter, r *http.Request, userID int64) {
	var body struct {
		UpgradeID string `json:"upgrade_id"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.UpgradeID != "autoRepair" {
		writeAPIError(w, http.StatusBadRequest, "unknown fishing upgrade")
		return
	}
	player, level, err := a.economy.UpgradeRodAutoRepair(r.Context(), userID,
		autoRepairUpgradeCoins, autoRepairUpgradeMaterials, fishing.DefaultRepairMaterial)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "player": publicPlayer(*player), "auto_repair_level": level,
	})
}

func (a api) fxQuotes(w http.ResponseWriter, r *http.Request, userID int64) {
	now := a.clock()
	state, err := a.economy.GetFXMarketState(r.Context(), userID, now, a.fxConfig)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	symbols := fx.AllSymbols()
	quotes := make([]fx.Quote, 0, len(symbols))
	for _, meta := range symbols {
		quotes = append(quotes, a.marketQuote(meta, state, now))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "quotes": quotes})
}

func (a api) fxCandles(w http.ResponseWriter, r *http.Request, userID int64) {
	query := r.URL.Query()
	meta, ok := fx.GetSymbol(query.Get("symbol"))
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "unknown FX symbol")
		return
	}
	grain := 60
	if value := query.Get("grain"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || (parsed != 15 && parsed != 30 && parsed != 60 && parsed != 120) {
			writeAPIError(w, http.StatusBadRequest, "grain must be 15, 30, 60, or 120 minutes")
			return
		}
		grain = parsed
	}
	now := a.clock()
	state, err := a.economy.GetFXMarketState(r.Context(), userID, now, a.fxConfig)
	if err != nil {
		writeFishingError(w, r, err)
		return
	}
	candles := fx.BuildCandles(meta.ID, state.Days[meta.ID], state.Today[meta.ID], grain, now, a.fxConfig)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "symbol": meta.ID, "grain": grain, "candles": candles})
}

func (a api) fxTrade(side string) func(http.ResponseWriter, *http.Request, int64) {
	return func(w http.ResponseWriter, r *http.Request, userID int64) {
		var body struct {
			Symbol string `json:"symbol"`
			Qty    int64  `json:"qty"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		meta, ok := fx.GetSymbol(body.Symbol)
		if !ok || body.Qty <= 0 {
			writeAPIError(w, http.StatusBadRequest, "invalid FX symbol or quantity")
			return
		}
		now := a.clock()
		state, err := a.economy.GetFXMarketState(r.Context(), userID, now, a.fxConfig)
		if err != nil {
			writeFishingError(w, r, err)
			return
		}
		quote := a.marketQuote(meta, state, now)
		unitPrice := quote.Sell
		if side == "buy" {
			unitPrice = quote.Buy
		}
		if body.Qty > math.MaxInt64/unitPrice {
			writeAPIError(w, http.StatusBadRequest, "FX trade value is too large")
			return
		}
		fee := int64(math.Ceil(float64(body.Qty*unitPrice) * a.fxConfig.FeeRate))
		result, err := a.economy.ExecuteFXTrade(r.Context(), userID, meta.ID, side, body.Qty,
			unitPrice, fee, a.fxConfig.MaxPosition, now)
		if err != nil {
			writeFishingError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "player": publicPlayer(result.Player), "symbol": result.Symbol,
			"side": result.Side, "quantity": result.Quantity, "unit_price": result.UnitPrice, "fee": result.Fee,
			"new_position_qty": result.NewPositionQty, "new_avg_cost": result.NewAvgCost,
		})
	}
}

func (a api) marketQuote(meta fx.SymbolMeta, state *repo.FXMarketState, now time.Time) fx.Quote {
	history, bucket := state.Days[meta.ID], state.Today[meta.ID]
	prevClose := fx.MidPrice(meta.ID, history, fx.BucketState{}, now, a.fxConfig)
	mid := fx.MidPrice(meta.ID, history, bucket, now, a.fxConfig)
	quote := fx.QuoteFromMid(meta, mid, prevClose, bucket.Net, bucket.Volume, a.fxConfig)
	position := state.Positions[meta.ID]
	quote.Position, quote.AvgCost = position.Quantity, position.AvgCost
	return quote
}
