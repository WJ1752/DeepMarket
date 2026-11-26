package httpapi_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
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
	"deepmarket/server/internal/httpapi"
	"deepmarket/server/internal/repo"
	"deepmarket/server/internal/sse"
	"github.com/jackc/pgx/v5/pgxpool"
)

const phase2Secret = "phase2-test-hmac-secret"

func TestPhase2FishingStartRareDropAndSignedSSE(t *testing.T) {
	f := newPhase2Fixture(t, func(ctx fishing.RollContext) fishing.BiteState {
		return fishing.BiteState{
			StartedAtMs: ctx.NowMs, ChargeRequired: 40, ChargeRate: 1,
			TensionRate: 1, MaxTension: 1000, TensionDelayMs: 75,
			Fish: fishing.FishRoll{
				SpeciesID: "jelly", Name: "静海幽灵水母", Tier: "legendary",
				Traits: []string{"abyssal", "prismatic"}, WeightG: 1200,
			},
		}
	})
	userID, token := f.newPlayer(map[string]any{"phase1": true})
	_, observerToken := f.newPlayer(nil)
	f.equipAbyss(userID, 1000)
	primary := f.openStream(token, "/api/sse/stream")
	observer := f.openStream(observerToken, "/api/events")

	started := f.post(token, "/api/fishing/start", `{"depth_id":"abyss"}`)
	if !started.OK || !started.Running || started.DepthID != "abyss" || started.InvRev <= 1 {
		t.Fatalf("unexpected start response: %+v", started)
	}
	private := f.readEvent(primary, "catch", "user")
	broadcast := f.readEvent(primary, "catch", "global")
	seenByObserver := f.readEvent(observer, "catch", "global")
	f.post(token, "/api/fishing/stop", "")
	if broadcast.ID != seenByObserver.ID || broadcast.Sig != seenByObserver.Sig ||
		broadcast.InvRev != private.InvRev || broadcast.Seq <= private.Seq || broadcast.UserID != userID {
		t.Fatalf("unexpected catch delivery: user=%+v global=%+v observer=%+v", private, broadcast, seenByObserver)
	}
	for _, env := range []sse.Envelope{private, broadcast, seenByObserver} {
		var payload struct {
			Tier      string   `json:"tier"`
			SpeciesID string   `json:"species_id"`
			Traits    []string `json:"traits"`
			InvRev    int64    `json:"inv_rev"`
		}
		decodePayload(t, env, &payload)
		if payload.Tier != "legendary" || payload.SpeciesID != "jelly" ||
			!slices.Equal(payload.Traits, []string{"abyssal", "prismatic"}) ||
			payload.InvRev != env.InvRev || payload.InvRev <= started.InvRev {
			t.Fatalf("unexpected catch payload %s", env.Payload)
		}
	}
	modified := private
	modified.Payload = json.RawMessage(`{"tier":"normal"}`)
	if sse.VerifyEnvelope([]byte(phase2Secret), modified) {
		t.Fatal("modified catch payload passed verification")
	}
	modified = private
	modified.InvRev++
	if sse.VerifyEnvelope([]byte(phase2Secret), modified) {
		t.Fatal("modified catch revision passed verification")
	}

	fish, err := f.fishingRepo.ListFishByUser(f.ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(fish) == 0 || fish[0].ItemID != "jelly" || fish[0].Tier != "legendary" ||
		!slices.Equal(fish[0].Traits, []string{"abyssal", "prismatic"}) {
		t.Fatalf("unexpected persisted fish: %+v", fish)
	}
	player, err := f.fishingRepo.GetPlayerByID(f.ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if private.InvRev <= 1 || private.Version <= started.PlayerVersion ||
		player.InvRev < private.InvRev || player.Version < private.Version {
		t.Fatalf("unexpected player revisions: player=(%d, %d) event=(%d, %d)",
			player.InvRev, player.Version, private.InvRev, private.Version)
	}
	var state struct {
		Phase1 bool `json:"phase1"`
	}
	if err := json.Unmarshal(player.State, &state); err != nil || !state.Phase1 {
		t.Fatalf("fishing transitions lost Phase 1 state: %s (%v)", player.State, err)
	}
	f.assertLedger(userID, private.InvRev, "fishing_catch")
}

func TestPhase2DurabilityDecayAndAutoRepair(t *testing.T) {
	f := newPhase2Fixture(t, func(ctx fishing.RollContext) fishing.BiteState {
		return fishing.BiteState{
			StartedAtMs: ctx.NowMs, ChargeRequired: fishing.EnergyPerCatch, ChargeRate: 1,
			TensionRate: 1000, MaxTension: 10, LossBase: 20,
			Fish: fishing.FishRoll{SpeciesID: "eel", Tier: "rare", Traits: []string{"heavy"}, WeightG: 500},
		}
	})
	userID, token := f.newPlayer(map[string]any{"fishing": map[string]any{"auto_repair_level": 1}})
	f.equipAbyss(userID, 18)
	if err := f.fishingRepo.AddMaterial(f.ctx, userID, fishing.DefaultRepairMaterial, 3); err != nil {
		t.Fatal(err)
	}
	stream := f.openStream(token, "/api/sse/stream?global=false")
	f.post(token, "/api/fishing/start", `{"depth_id":"abyss"}`)
	if env := f.readEvent(stream, "", "user"); env.Event != "fishing_started" {
		t.Fatalf("first event = %s, want fishing_started", env.Event)
	}
	escape := f.readEvent(stream, "", "user")
	repair := f.readEvent(stream, "", "user")
	if escape.Event != "escape" || repair.Event != "auto_repair" || repair.InvRev != escape.InvRev+1 {
		t.Fatalf("unexpected repair sequence: %s (%d), %s (%d)",
			escape.Event, escape.InvRev, repair.Event, repair.InvRev)
	}
	f.post(token, "/api/fishing/stop", "")

	type wearPayload struct {
		PreviousDurability int `json:"previous_durability"`
		Durability         int `json:"durability"`
	}
	var wear, restored wearPayload
	decodePayload(t, escape, &wear)
	decodePayload(t, repair, &restored)
	if wear.PreviousDurability != 18 || wear.Durability < 0 || wear.Durability >= 18 ||
		restored.PreviousDurability != wear.Durability || restored.Durability != wear.Durability+45 {
		t.Fatalf("unexpected durability changes: wear=%+v repair=%+v", wear, restored)
	}
	rod, err := f.fishingRepo.GetEquippedRod(f.ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	materials, err := f.fishingRepo.GetMaterialQty(f.ctx, userID, fishing.DefaultRepairMaterial)
	if err != nil {
		t.Fatal(err)
	}
	if rod.Durability != restored.Durability || materials != 2 {
		t.Fatalf("persisted durability = %d, want %d, material qty = %d, want 2", rod.Durability, restored.Durability, materials)
	}
	f.assertLedger(userID, escape.InvRev, "fishing_escape")
	f.assertLedger(userID, repair.InvRev, "rod_auto_repair")
}

type phase2Fixture struct {
	t           *testing.T
	ctx         context.Context
	pool        *pgxpool.Pool
	fishingRepo *repo.FishingRepo
	server      *httptest.Server
}

func newPhase2Fixture(t *testing.T, roll func(fishing.RollContext) fishing.BiteState) *phase2Fixture {
	t.Helper()
	dsn := os.Getenv("DEEPMARKET_DATABASE_URL")
	if strings.TrimSpace(dsn) == "" {
		t.Fatal("DEEPMARKET_DATABASE_URL must be set for Phase 2 integration tests")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := db.OpenPool(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	fishingRepo := repo.NewFishingRepo(pool)
	hub, err := sse.NewHub([]byte(phase2Secret))
	if err != nil {
		t.Fatal(err)
	}
	engine := fishing.NewEngine(fishingRepo, hub, fishing.EngineConfig{TickInterval: 20 * time.Millisecond, BiteRoller: roll})
	server := httptest.NewServer(httpapi.NewHandler(fishingRepo, engine, hub))
	t.Cleanup(func() {
		hub.Close()
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		engine.Shutdown(ctx)
	})
	return &phase2Fixture{t: t, ctx: ctx, pool: pool, fishingRepo: fishingRepo, server: server}
}

func (f *phase2Fixture) newPlayer(initialState map[string]any) (int64, string) {
	f.t.Helper()
	unique, err := auth.GenerateSessionID()
	if err != nil {
		f.t.Fatal(err)
	}
	players := repo.NewPlayerRepo(f.pool)
	account, err := players.CreatePlayerAccount(f.ctx, "phase2_"+unique[:24], "phase2-angler-password", initialState)
	if err != nil {
		f.t.Fatal(err)
	}
	userID := account.User.ID
	f.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := players.DeleteUserForTest(ctx, userID); err != nil {
			f.t.Errorf("delete test user %d: %v", userID, err)
		}
	})
	session, err := f.fishingRepo.CreateSession(f.ctx, userID, time.Hour, "127.0.0.1", "phase2-test")
	if err != nil {
		f.t.Fatal(err)
	}
	return userID, session.ID
}

func (f *phase2Fixture) equipAbyss(userID int64, durability int) {
	f.t.Helper()
	_, err := f.fishingRepo.CreateEquipment(f.ctx, repo.EquipmentInstance{
		UserID: userID, TemplateID: "abyss", SlotType: "rod", Equipped: true,
		Durability: durability, MaxDurability: 1000,
	})
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *phase2Fixture) request(method, token, path string, body io.Reader) *http.Response {
	f.t.Helper()
	req, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, body)
	if err != nil {
		f.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := f.server.Client().Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		f.t.Fatalf("%s %s returned %s: %s", method, path, resp.Status, message)
	}
	return resp
}

type actionResponse struct {
	OK            bool   `json:"ok"`
	Running       bool   `json:"running"`
	DepthID       string `json:"depth_id"`
	PlayerVersion int64  `json:"player_version"`
	InvRev        int64  `json:"inv_rev"`
}

func (f *phase2Fixture) post(token, path, body string) actionResponse {
	f.t.Helper()
	resp := f.request(http.MethodPost, token, path, strings.NewReader(body))
	defer resp.Body.Close()
	var result actionResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		f.t.Fatal(err)
	}
	return result
}

func (f *phase2Fixture) openStream(token, path string) *bufio.Scanner {
	f.t.Helper()
	resp := f.request(http.MethodGet, token, path, nil)
	f.t.Cleanup(func() { resp.Body.Close() })
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		f.t.Fatalf("stream content type = %q", got)
	}
	stream := bufio.NewScanner(resp.Body)
	if !stream.Scan() || stream.Text() != ": connected" {
		f.t.Fatalf("missing stream connection comment: %v", stream.Err())
	}
	return stream
}

func (f *phase2Fixture) readEvent(stream *bufio.Scanner, event, channel string) sse.Envelope {
	f.t.Helper()
	var id, eventName string
	for stream.Scan() {
		key, field, ok := strings.Cut(stream.Text(), ": ")
		if !ok {
			continue
		}
		switch key {
		case "id":
			id = field
		case "event":
			eventName = field
		case "data":
			var env sse.Envelope
			if err := json.Unmarshal([]byte(field), &env); err != nil {
				f.t.Fatalf("decode SSE envelope: %v", err)
			}
			if id == "" || env.ID != id || env.Event != eventName || env.Sig == "" || !sse.VerifyEnvelope([]byte(phase2Secret), env) {
				f.t.Fatalf("invalid signed SSE frame: id=%s event=%s data=%s", id, eventName, field)
			}
			if (event == "" || env.Event == event) && env.Channel == channel {
				return env
			}
		}
	}
	f.t.Fatalf("stream ended before %s %s: %v", channel, event, stream.Err())
	return sse.Envelope{}
}

func decodePayload(t *testing.T, env sse.Envelope, dst any) {
	t.Helper()
	if err := json.Unmarshal(env.Payload, dst); err != nil {
		t.Fatalf("decode %s payload: %v", env.Event, err)
	}
}

func (f *phase2Fixture) assertLedger(userID, invRev int64, eventType string) {
	f.t.Helper()
	var exists bool
	if err := f.pool.QueryRow(f.ctx, `SELECT EXISTS (
		SELECT 1 FROM asset_ledger WHERE user_id=$1 AND inv_rev=$2 AND event_type=$3
	)`, userID, invRev, eventType).Scan(&exists); err != nil {
		f.t.Fatal(err)
	}
	if !exists {
		f.t.Fatalf("ledger is missing %s at revision %d", eventType, invRev)
	}
}
