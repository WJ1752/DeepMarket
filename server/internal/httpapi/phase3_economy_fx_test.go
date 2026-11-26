package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"deepmarket/server/internal/auth"
	"deepmarket/server/internal/db"
	"deepmarket/server/internal/fishing"
	"deepmarket/server/internal/fx"
	"deepmarket/server/internal/httpapi"
	"deepmarket/server/internal/repo"
	"deepmarket/server/internal/sse"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPhase3EconomyFX(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("DEEPMARKET_DATABASE_URL"))
	if dsn == "" {
		t.Fatal("DEEPMARKET_DATABASE_URL must be set for the Phase 3 integration test")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	pool := phase3Pool(t, ctx, dsn)
	players := repo.NewPlayerRepo(pool)
	fishingRepo := repo.NewFishingRepo(pool)
	economy := repo.NewEconomyRepo(pool)
	hub, err := sse.NewHub([]byte(phase2Secret))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	cfg := fx.DefaultConfig()
	worker := fx.NewWorker(economy, hub, cfg, time.Minute, clock)
	traits := []string{"abyssal", "armored", "luminous"}
	rolled := false
	engine := fishing.NewEngine(fishingRepo, hub, fishing.EngineConfig{
		TickInterval: 20 * time.Millisecond,
		BiteRoller: func(roll fishing.RollContext) fishing.BiteState {
			if rolled {
				return fishing.BiteState{
					StartedAtMs: roll.NowMs, ChargeRate: 0.0001,
					TensionDelayMs: float64(time.Hour.Milliseconds()),
				}
			}
			rolled = true
			return fishing.BiteState{
				StartedAtMs: roll.NowMs - 100, ChargeRequired: 40, ChargeRate: 1,
				TensionRate: 1, MaxTension: 1000, TensionDelayMs: 75,
				Fish: fishing.FishRoll{
					SpeciesID: "jelly", Name: "静海幽灵水母", Tier: "legendary",
					Traits: traits, WeightG: 2500,
				},
			}
		},
		OnCatch: func(ctx context.Context, _ int64, fish fishing.FishRoll, qty int64) {
			flows := make([]repo.FXFlow, 0, len(fish.Traits))
			for _, trait := range fish.Traits {
				flows = append(flows, repo.FXFlow{Symbol: trait, Net: float64(qty), Volume: float64(qty)})
			}
			if err := economy.AppendFXFlows(ctx, flows, clock()); err != nil {
				t.Errorf("record catch FX flows: %v", err)
			}
		},
	})
	server := httptest.NewServer(httpapi.NewFullHandler(httpapi.ServerDeps{
		PlayerRepo: players, FishingRepo: fishingRepo, EconomyRepo: economy,
		Engine: engine, Hub: hub, FXConfig: cfg, FXWorker: worker, Clock: clock,
	}))
	t.Cleanup(func() {
		hub.Close()
		server.Close()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		engine.Shutdown(cleanupCtx)
		worker.Shutdown(cleanupCtx)
	})
	f := phase2Fixture{t: t, ctx: ctx, pool: pool, fishingRepo: fishingRepo, server: server}

	const credentials = `{"username":"phase3_angler","password":"phase3-angler-password"}`
	registered := phase3Authenticate(t, &f, "/api/auth/register", credentials, http.StatusCreated, http.StatusOK)
	loggedIn := phase3Authenticate(t, &f, "/api/auth/login", credentials, http.StatusOK)
	userID, token := loggedIn.User.ID, loggedIn.Token
	if userID != registered.User.ID || token == registered.Token || loggedIn.Player.UserID != userID {
		t.Fatalf("login did not return a new session for the registered account")
	}
	if _, err := fishingRepo.GetEquippedRod(ctx, userID); err != nil {
		t.Fatalf("registered account has no equipped starter rod: %v", err)
	}

	stream := f.openStream(token, "/api/sse/stream")
	if started := f.post(token, "/api/fishing/start", `{"depth_id":"shore"}`); !started.OK || !started.Running {
		t.Fatalf("fishing failed to start: %+v", started)
	}
	catch := f.readEvent(stream, "catch", "user")
	if catch.UserID != userID {
		t.Fatalf("catch belongs to player %d, want %d", catch.UserID, userID)
	}
	f.post(token, "/api/fishing/stop", "")

	fish, err := fishingRepo.ListFishByUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(fish) != 1 || fish[0].ItemID != "jelly" || fish[0].Quantity != 1 {
		t.Fatalf("unexpected catch inventory: %+v", fish)
	}
	day, slot := fx.UTCDayIndex(now), fx.UTCBinSlot(now)
	for _, trait := range traits {
		assertPhase3Flow(t, &f, trait, day, slot, 1, 1)
	}

	before, err := fishingRepo.GetPlayerByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	saleBody, err := json.Marshal(map[string][]int64{"fish_ids": {fish[0].ID}})
	if err != nil {
		t.Fatal(err)
	}
	var sale struct {
		OK            bool  `json:"ok"`
		SoldCount     int64 `json:"sold_count"`
		CoinsEarned   int64 `json:"coins_earned"`
		TicketsEarned int64 `json:"tickets_earned"`
	}
	phase3JSON(t, &f, http.MethodPost, token, "/api/guild/sell", string(saleBody), &sale)
	after, err := fishingRepo.GetPlayerByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if !sale.OK || sale.SoldCount != 1 || sale.CoinsEarned <= 0 || after.Coins != before.Coins+sale.CoinsEarned ||
		after.Version != before.Version+1 || after.InvRev != before.InvRev+1 {
		t.Fatalf("unexpected guild sale: response=%+v before=%+v after=%+v", sale, before, after)
	}
	var inventory struct {
		OK           bool            `json:"ok"`
		Fish         json.RawMessage `json:"fish"`
		BlankTickets int64           `json:"blank_tickets"`
	}
	phase3JSON(t, &f, http.MethodGet, token, "/api/guild/inventory", "", &inventory)
	var remaining []json.RawMessage
	if err := json.Unmarshal(inventory.Fish, &remaining); err != nil {
		t.Fatal(err)
	}
	wantTickets := min(int64(50), max(int64(1), sale.CoinsEarned/20))
	var tickets int64
	if err := pool.QueryRow(ctx, `
		SELECT coalesce(sum(quantity), 0)::bigint
		FROM inventory_items WHERE user_id=$1 AND item_kind='ticket' AND item_id='blank'
	`, userID).Scan(&tickets); err != nil {
		t.Fatal(err)
	}
	if !inventory.OK || len(remaining) != 0 || tickets != wantTickets ||
		sale.TicketsEarned != tickets || inventory.BlankTickets != tickets {
		t.Fatalf("unexpected guild inventory: fish=%s ticket rows=%d response=%d want=%d",
			inventory.Fish, tickets, inventory.BlankTickets, wantTickets)
	}
	fish, err = fishingRepo.ListFishByUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(fish) != 0 {
		t.Fatalf("sold fish still in inventory: %+v", fish)
	}
	for _, trait := range traits {
		assertPhase3Flow(t, &f, trait, day, slot, 0, 2)
	}
	f.assertLedger(userID, after.InvRev, "guild_sell")

	type tradeResponse struct {
		OK          bool    `json:"ok"`
		Symbol      string  `json:"symbol"`
		Side        string  `json:"side"`
		Quantity    int64   `json:"quantity"`
		UnitPrice   int64   `json:"unit_price"`
		Fee         int64   `json:"fee"`
		PositionQty int64   `json:"new_position_qty"`
		AvgCost     float64 `json:"new_avg_cost"`
	}
	coins, rev, version := after.Coins, after.InvRev, after.Version
	for _, trade := range []struct {
		side string
		body string
		qty  int64
		want int64
	}{
		{"buy", `{"symbol":"swift","qty":2}`, 2, 2},
		{"sell", `{"symbol":"swift","qty":1}`, 1, 1},
	} {
		var result tradeResponse
		phase3JSON(t, &f, http.MethodPost, token, "/api/fx/"+trade.side, trade.body, &result)
		gross := trade.qty * result.UnitPrice
		wantFee := int64(math.Ceil(float64(gross) * cfg.FeeRate))
		if !result.OK || result.Symbol != "swift" || result.Side != trade.side ||
			result.Quantity != trade.qty || result.UnitPrice <= 0 || result.Fee != wantFee ||
			result.PositionQty != trade.want || result.AvgCost != 31 {
			t.Fatalf("unexpected %s result: %+v", trade.side, result)
		}
		if trade.side == "buy" {
			coins -= gross + wantFee
		} else {
			coins += gross - wantFee
		}
		rev++
		version++
		player, err := fishingRepo.GetPlayerByID(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		if player.Coins != coins || player.InvRev != rev || player.Version != version {
			t.Fatalf("unexpected %s player balance or revisions: %+v", trade.side, player)
		}
		var qty int64
		var avgCost float64
		if err := pool.QueryRow(ctx, `
			SELECT quantity, avg_cost::double precision
			FROM fx_positions WHERE user_id=$1 AND symbol='swift'
		`, userID).Scan(&qty, &avgCost); err != nil {
			t.Fatal(err)
		}
		if qty != trade.want || avgCost != 31 {
			t.Fatalf("%s position=(%d, %g), want (%d, 31)", trade.side, qty, avgCost, trade.want)
		}
		f.assertLedger(userID, rev, "fx_"+trade.side)
	}
	assertPhase3Flow(t, &f, "swift", day, slot, 1, 3)

	if _, err := pool.Exec(ctx, `
		INSERT INTO fx_bucket (symbol, day_index, net, volume) VALUES ('prismatic',$1,2,4)
	`, day-1); err != nil {
		t.Fatal(err)
	}
	bars, err := worker.SettleNow(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var settled fx.DayCandle
	for _, bar := range bars {
		if bar.Symbol == "prismatic" && bar.DayIndex == day-1 {
			settled = bar
		}
	}
	if settled.Symbol == "" || settled.Imbalance != 0.5 ||
		math.Abs(settled.Move-0.028) > 1e-12 || math.Abs(settled.Move) > cfg.DailyLimit {
		t.Fatalf("unexpected settled candle: %+v", settled)
	}
	var open, closePrice, net, volume float64
	if err := pool.QueryRow(ctx, `
		SELECT open::double precision, close::double precision, net, volume
		FROM fx_days WHERE symbol='prismatic' AND day_index=$1
	`, day-1).Scan(&open, &closePrice, &net, &volume); err != nil {
		t.Fatal(err)
	}
	if open != 165 || closePrice != 169.62 || net != 2 || volume != 4 {
		t.Fatalf("unexpected persisted settlement: open=%g close=%g net=%g volume=%g", open, closePrice, net, volume)
	}
	tick := f.readEvent(stream, "fx_tick", "global")
	if tick.UserID != 0 || tick.InvRev != 0 || tick.Version != 0 {
		t.Fatalf("unexpected exchange tick envelope: %+v", tick)
	}
	var payload struct {
		Candles []fx.DayCandle `json:"candles"`
	}
	decodePayload(t, tick, &payload)
	if !slices.ContainsFunc(payload.Candles, func(bar fx.DayCandle) bool {
		return bar.Symbol == settled.Symbol && bar.DayIndex == settled.DayIndex &&
			bar.Close == settled.Close && bar.Imbalance == settled.Imbalance
	}) {
		t.Fatalf("exchange tick is missing the settled candle: %s", tick.Payload)
	}
}

func phase3Pool(t *testing.T, ctx context.Context, dsn string) *pgxpool.Pool {
	t.Helper()
	admin, err := db.OpenPool(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	unique, err := auth.GenerateSessionID()
	if err != nil {
		t.Fatal(err)
	}
	// FX buckets are global to a schema, so each run uses its own set of tables.
	schema := "phase3_" + unique[:24]
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop test schema %s: %v", schema, err)
		}
	})
	config := admin.Config()
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

type phase3AuthResponse struct {
	OK    bool   `json:"ok"`
	Token string `json:"token"`
	User  struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	} `json:"user"`
	Player struct {
		UserID int64 `json:"user_id"`
	} `json:"player"`
}

func phase3Authenticate(t *testing.T, f *phase2Fixture, path, body string, wantStatuses ...int) phase3AuthResponse {
	t.Helper()
	req, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	for _, status := range wantStatuses {
		if resp.StatusCode == status {
			var result phase3AuthResponse
			if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			if !result.OK || result.Token == "" || result.User.ID <= 0 || result.User.Username != "phase3_angler" ||
				result.Player.UserID != result.User.ID {
				t.Fatalf("%s returned incomplete account or session data", path)
			}
			return result
		}
	}
	message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	t.Fatalf("%s returned %s: %s", path, resp.Status, message)
	return phase3AuthResponse{}
}

func phase3JSON(t *testing.T, f *phase2Fixture, method, token, path, body string, dst any) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	resp := f.request(method, token, path, reader)
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		t.Fatalf("decode %s response: %v", path, err)
	}
}

func assertPhase3Flow(t *testing.T, f *phase2Fixture, symbol string, day, slot int, wantNet, wantVolume float64) {
	t.Helper()
	var bucketNet, bucketVolume, binNet, binVolume float64
	if err := f.pool.QueryRow(f.ctx, `
		SELECT bucket.net, bucket.volume, bin.net, bin.volume
		FROM fx_bucket AS bucket
		JOIN fx_bucket_bins AS bin USING (symbol, day_index)
		WHERE symbol=$1 AND day_index=$2 AND bin_slot=$3
	`, symbol, day, slot).Scan(&bucketNet, &bucketVolume, &binNet, &binVolume); err != nil {
		t.Fatal(err)
	}
	if bucketNet != wantNet || bucketVolume != wantVolume || binNet != wantNet || binVolume != wantVolume {
		t.Fatalf("%s bucket=(%g, %g) bin=(%g, %g), want (%g, %g) in both",
			symbol, bucketNet, bucketVolume, binNet, binVolume, wantNet, wantVolume)
	}
}
