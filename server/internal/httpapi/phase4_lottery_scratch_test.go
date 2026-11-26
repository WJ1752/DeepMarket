package httpapi_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"deepmarket/server/internal/httpapi"
	"deepmarket/server/internal/lottery"
	"deepmarket/server/internal/repo"
	"deepmarket/server/internal/sse"
)

func TestPhase4LotteryAndScratch(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("DEEPMARKET_DATABASE_URL"))
	if dsn == "" {
		t.Fatal("DEEPMARKET_DATABASE_URL must be set for the Phase 4 integration test")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	pool := phase3Pool(t, ctx, dsn)
	players := repo.NewPlayerRepo(pool)
	fishingRepo := repo.NewFishingRepo(pool)
	lotteryRepo := repo.NewLotteryRepo(pool)
	hub, err := sse.NewHub([]byte(phase2Secret))
	if err != nil {
		t.Fatal(err)
	}
	openedAt := time.Date(2026, 11, 26, 12, 15, 0, 0, time.UTC)
	var seconds atomic.Int64
	seconds.Store(openedAt.Unix())
	clock := func() time.Time { return time.Unix(seconds.Load(), 0).UTC() }
	worker := lottery.NewWorker(lotteryRepo, hub, time.Minute, clock)
	server := httptest.NewServer(httpapi.NewFullHandler(httpapi.ServerDeps{
		PlayerRepo: players, FishingRepo: fishingRepo, LotteryRepo: lotteryRepo, LotteryWorker: worker,
		Hub: hub, Clock: clock,
	}))
	t.Cleanup(func() {
		hub.Close()
		server.Close()
	})
	f := phase2Fixture{t: t, ctx: ctx, pool: pool, fishingRepo: fishingRepo, server: server}
	var registered phase3AuthResponse
	phase4Request(&f, "", "/api/auth/register", `{"username":"phase4_angler","password":"phase4-angler-password"}`,
		http.StatusCreated, &registered)
	userID, token := registered.User.ID, registered.Token
	if !registered.OK || userID <= 0 || token == "" || registered.Player.UserID != userID {
		t.Fatalf("incomplete account registration: %+v", registered.User)
	}
	if err := lotteryRepo.AddBlankTickets(ctx, userID, 20); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE players SET coins=500, state=state || '{"phase4_marker":{"keep":true}}'::jsonb WHERE user_id=$1
	`, userID); err != nil {
		t.Fatal(err)
	}
	beforeCraft := phase4Player(&f, userID)
	stream := f.openStream(token, "/api/sse/stream")

	const craftBody = `{"tier":"normal","quantity":2,"request_key":"craft-1"}`
	var craft, replay struct {
		OK           bool             `json:"ok"`
		Tickets      []lottery.Ticket `json:"tickets"`
		BlankTickets int64            `json:"blank_tickets"`
		Replayed     bool             `json:"replayed"`
	}
	phase3JSON(t, &f, http.MethodPost, token, "/api/lottery/craft", craftBody, &craft)
	phase3JSON(t, &f, http.MethodPost, token, "/api/lottery/craft", craftBody, &replay)
	if !craft.OK || craft.Replayed || len(craft.Tickets) != 2 || craft.BlankTickets != 14 ||
		!replay.OK || !replay.Replayed || replay.BlankTickets != 14 || !reflect.DeepEqual(replay.Tickets, craft.Tickets) {
		t.Fatalf("unexpected craft results: first=%+v replay=%+v", craft, replay)
	}
	batchID := lottery.BatchIDAt(openedAt)
	for _, ticket := range craft.Tickets {
		if ticket.ID == "" || ticket.BatchID != batchID || ticket.Tier != "normal" ||
			ticket.Status != "ASSIGNED" || len(ticket.Numbers) != 6 {
			t.Fatalf("unexpected numbered ticket: %+v", ticket)
		}
	}
	if craft.Tickets[0].ID == craft.Tickets[1].ID {
		t.Fatal("crafted tickets have the same ID")
	}
	afterCraft := phase4Player(&f, userID)
	phase4AssertRevision(t, beforeCraft, afterCraft, 1)
	if afterCraft.Coins != beforeCraft.Coins || !reflect.DeepEqual(phase4Tickets(t, afterCraft), craft.Tickets) {
		t.Fatalf("unexpected player after craft: %+v", afterCraft)
	}
	var blank int64
	if err := pool.QueryRow(ctx, `
		SELECT coalesce(sum(quantity),0)::bigint FROM inventory_items
		WHERE user_id=$1 AND item_kind='ticket' AND item_id='blank'
	`, userID).Scan(&blank); err != nil || blank != 14 {
		t.Fatalf("blank tickets=%d, want 14: %v", blank, err)
	}
	var statusCode int
	var cachedTickets []lottery.Ticket
	if err := pool.QueryRow(ctx, `
		SELECT status_code, response->'tickets' FROM action_log WHERE user_id=$1 AND request_key='craft-1'
	`, userID).Scan(&statusCode, &cachedTickets); err != nil {
		t.Fatal(err)
	}
	if statusCode != http.StatusOK || !reflect.DeepEqual(cachedTickets, craft.Tickets) {
		t.Fatalf("unexpected action log response: status=%d tickets=%+v", statusCode, cachedTickets)
	}
	f.assertLedger(userID, afterCraft.InvRev, "lottery_craft")

	seconds.Store(lottery.BatchEnd(openedAt).Unix())
	drawBody := fmt.Sprintf(`{"batch_id":%q}`, batchID)
	var draw, repeatedDraw struct {
		OK         bool             `json:"ok"`
		BatchID    string           `json:"batch_id"`
		Draws      map[string][]int `json:"draws"`
		NewlyDrawn bool             `json:"newly_drawn"`
	}
	phase3JSON(t, &f, http.MethodPost, token, "/api/lottery/draw", drawBody, &draw)
	phase3JSON(t, &f, http.MethodPost, token, "/api/lottery/draw", drawBody, &repeatedDraw)
	if !draw.OK || !draw.NewlyDrawn || draw.BatchID != batchID || len(draw.Draws) != 3 ||
		!repeatedDraw.OK || repeatedDraw.NewlyDrawn || repeatedDraw.BatchID != batchID ||
		!reflect.DeepEqual(draw.Draws, repeatedDraw.Draws) {
		t.Fatalf("unexpected draw results: first=%+v repeated=%+v", draw, repeatedDraw)
	}
	var drawn bool
	if err := pool.QueryRow(ctx, `SELECT drawn FROM lottery_batches WHERE batch_id=$1`, batchID).Scan(&drawn); err != nil || !drawn {
		t.Fatalf("batch %s drawn=%t: %v", batchID, drawn, err)
	}
	for _, pool := range lottery.AllPools() {
		var winning []int
		var seedHash string
		if err := f.pool.QueryRow(ctx, `
			SELECT winning_numbers, draw_seed_hash FROM lottery_draws WHERE batch_id=$1 AND pool_id=$2
		`, batchID, pool.ID).Scan(&winning, &seedHash); err != nil {
			t.Fatal(err)
		}
		seed, err := hex.DecodeString(seedHash)
		if len(winning) != pool.Pick || !slices.Equal(winning, draw.Draws[pool.ID]) || err != nil || len(seed) != 32 {
			t.Fatalf("unexpected persisted draw for %s: winning=%v hash=%q", pool.ID, winning, seedHash)
		}
	}
	drawEvent := f.readEvent(stream, "lottery_drawn", "global")
	var drawPayload, scheduledPayload struct {
		BatchID string           `json:"batch_id"`
		Draws   map[string][]int `json:"draws"`
	}
	decodePayload(t, drawEvent, &drawPayload)
	if drawEvent.UserID != 0 || drawEvent.InvRev != 0 || drawEvent.Version != 0 ||
		drawPayload.BatchID != batchID || !reflect.DeepEqual(drawPayload.Draws, draw.Draws) {
		t.Fatalf("unexpected lottery event: %+v", drawEvent)
	}
	var status struct {
		OK bool `json:"ok"`
		repo.LotteryStatus
	}
	phase3JSON(t, &f, http.MethodGet, token, "/api/lottery/status", "", &status)
	if !status.OK || status.CurrentBatch.ID != lottery.BatchIDAt(clock()) || status.CurrentBatch.Drawn ||
		status.BlankTickets != 14 || !reflect.DeepEqual(status.Tickets, craft.Tickets) || len(status.Pools) != 3 ||
		len(status.RecentDraws) != len(draw.Draws) {
		t.Fatalf("unexpected lottery status: %+v", status)
	}
	for _, recent := range status.RecentDraws {
		if recent.BatchID != batchID || !slices.Equal(recent.WinningNumbers, draw.Draws[recent.PoolID]) {
			t.Fatalf("unexpected recent lottery draw: %+v", recent)
		}
	}

	normal, _ := lottery.GetPool("normal")
	beforeClaimAssets := phase4Items(&f, userID)
	wantClaimItems := maps.Clone(beforeClaimAssets)
	wantClaimCoins := afterCraft.Coins
	for _, ticket := range craft.Tickets {
		hits := lottery.CountHits(ticket.Numbers, draw.Draws[normal.ID])
		for _, prize := range lottery.RewardForHits(normal, hits) {
			switch prize.Type {
			case "coin":
				wantClaimCoins += prize.Qty
			case "material":
				wantClaimItems["material:"+prize.Name] += prize.Qty
			case "rod":
				wantClaimItems["rod:"+prize.RodID] += prize.Qty
			default:
				t.Fatalf("unexpected lottery prize: %+v", prize)
			}
		}
	}
	var claim, emptyClaim struct {
		OK      bool `json:"ok"`
		Claimed int  `json:"claimed"`
	}
	phase3JSON(t, &f, http.MethodPost, token, "/api/lottery/claim", `{"request_key":"claim-1"}`, &claim)
	afterClaim := phase4Player(&f, userID)
	phase4AssertRevision(t, afterCraft, afterClaim, 1)
	if !claim.OK || claim.Claimed != 2 || len(phase4Tickets(t, afterClaim)) != 0 || afterClaim.Coins != wantClaimCoins {
		t.Fatalf("unexpected claim: response=%+v coins=%d want=%d", claim, afterClaim.Coins, wantClaimCoins)
	}
	if claimItems := phase4Items(&f, userID); !maps.Equal(claimItems, wantClaimItems) {
		t.Fatalf("claimed items=%v, want %v", claimItems, wantClaimItems)
	}
	f.assertLedger(userID, afterClaim.InvRev, "lottery_claim")
	phase3JSON(t, &f, http.MethodPost, token, "/api/lottery/claim", `{"request_key":"claim-2"}`, &emptyClaim)
	afterEmptyClaim := phase4Player(&f, userID)
	phase4AssertRevision(t, afterClaim, afterEmptyClaim, 0)
	if !emptyClaim.OK || emptyClaim.Claimed != 0 || afterEmptyClaim.Coins != afterClaim.Coins ||
		!maps.Equal(phase4Items(&f, userID), wantClaimItems) {
		t.Fatalf("unexpected second claim: %+v", emptyClaim)
	}

	var buy struct {
		OK   bool            `json:"ok"`
		Card json.RawMessage `json:"card"`
	}
	phase3JSON(t, &f, http.MethodPost, token, "/api/scratch/buy", `{"card_type":"scratch-super","request_key":"buy-1"}`, &buy)
	card := phase4HiddenCard(t, buy.Card)
	if !buy.OK || card.ID <= 0 || card.CardType != "scratch-super" || card.Slots != 9 {
		t.Fatalf("unexpected scratch purchase: %+v", card)
	}
	afterBuy := phase4Player(&f, userID)
	phase4AssertRevision(t, afterEmptyClaim, afterBuy, 1)
	if afterBuy.Coins != afterEmptyClaim.Coins-120 {
		t.Fatalf("purchase coins=%d, want %d", afterBuy.Coins, afterEmptyClaim.Coins-120)
	}
	var listed struct {
		OK    bool              `json:"ok"`
		Cards []json.RawMessage `json:"cards"`
	}
	phase3JSON(t, &f, http.MethodGet, token, "/api/scratch/cards", "", &listed)
	if !listed.OK || len(listed.Cards) != 1 || phase4HiddenCard(t, listed.Cards[0]).ID != card.ID {
		t.Fatalf("unexpected scratch list: %+v", listed)
	}
	var face []lottery.ScratchSlot
	var settlement lottery.ScratchSettlement
	var revealed bool
	if err := pool.QueryRow(ctx, `
		SELECT server_face, server_payout, revealed FROM scratch_cards WHERE user_id=$1 AND id=$2
	`, userID, card.ID).Scan(&face, &settlement, &revealed); err != nil {
		t.Fatal(err)
	}
	wantSettlement := lottery.SettleScratchFace(face)
	if revealed || len(face) != card.Slots || settlement.Pairs != wantSettlement.Pairs ||
		!slices.Equal(settlement.Payouts, wantSettlement.Payouts) {
		t.Fatalf("unexpected persisted scratch face or settlement: face=%+v settlement=%+v", face, settlement)
	}
	wantScratchCoins := afterBuy.Coins
	wantScratchItems := maps.Clone(wantClaimItems)
	for _, payout := range settlement.Payouts {
		switch payout.Kind {
		case "coin":
			wantScratchCoins += payout.Qty
		case "material":
			wantScratchItems["material:"+payout.Name] += payout.Qty
		default:
			t.Fatalf("unexpected scratch payout: %+v", payout)
		}
	}
	var reveal struct {
		OK   bool                      `json:"ok"`
		Card lottery.PublicScratchCard `json:"card"`
	}
	phase3JSON(t, &f, http.MethodPost, token, "/api/scratch/reveal",
		fmt.Sprintf(`{"card_id":%d,"request_key":"reveal-1"}`, card.ID), &reveal)
	if !reveal.OK || !reveal.Card.Revealed || reveal.Card.ID != card.ID || reveal.Card.RevealedAt == nil ||
		!slices.Equal(reveal.Card.Face, face) || !slices.Equal(reveal.Card.Payouts, settlement.Payouts) {
		t.Fatalf("unexpected scratch reveal: %+v", reveal)
	}
	afterReveal := phase4Player(&f, userID)
	phase4AssertRevision(t, afterBuy, afterReveal, 1)
	if afterReveal.Coins != wantScratchCoins || !maps.Equal(phase4Items(&f, userID), wantScratchItems) {
		t.Fatalf("incorrect scratch payout: coins=%d want=%d payout=%+v", afterReveal.Coins, wantScratchCoins, settlement)
	}
	var revealedAt *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT revealed, revealed_at FROM scratch_cards WHERE user_id=$1 AND id=$2
	`, userID, card.ID).Scan(&revealed, &revealedAt); err != nil || !revealed || revealedAt == nil ||
		!revealedAt.Equal(*reveal.Card.RevealedAt) {
		t.Fatalf("unexpected database reveal state: revealed=%t at=%v err=%v", revealed, revealedAt, err)
	}
	f.assertLedger(userID, afterReveal.InvRev, "scratch_reveal")
	revealEvent := f.readEvent(stream, "scratch_revealed", "user")
	var revealPayload struct {
		Card lottery.PublicScratchCard `json:"card"`
	}
	decodePayload(t, revealEvent, &revealPayload)
	if revealEvent.UserID != userID || revealEvent.InvRev != afterReveal.InvRev || revealEvent.Version != afterReveal.Version ||
		revealPayload.Card.ID != card.ID || !revealPayload.Card.Revealed ||
		!slices.Equal(revealPayload.Card.Payouts, settlement.Payouts) {
		t.Fatalf("unexpected scratch event: %+v", revealEvent)
	}
	phase4Request(&f, token, "/api/scratch/reveal",
		fmt.Sprintf(`{"card_id":%d,"request_key":"reveal-2"}`, card.ID), http.StatusConflict, nil)
	afterConflict := phase4Player(&f, userID)
	phase4AssertRevision(t, afterReveal, afterConflict, 0)
	if afterConflict.Coins != wantScratchCoins || !maps.Equal(phase4Items(&f, userID), wantScratchItems) {
		t.Fatal("repeat reveal changed the player's assets")
	}

	previousBatchID := lottery.BatchIDAt(clock())
	var previousExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM lottery_batches WHERE batch_id=$1)`,
		previousBatchID).Scan(&previousExists); err != nil || previousExists {
		t.Fatalf("expected absent batch before scheduled draw: exists=%t err=%v", previousExists, err)
	}
	seconds.Store(lottery.BatchEnd(clock()).Unix())
	if err := worker.DrawDueNow(ctx); err != nil {
		t.Fatal(err)
	}
	workerEvent := f.readEvent(stream, "lottery_drawn", "global")
	decodePayload(t, workerEvent, &scheduledPayload)
	if scheduledPayload.BatchID != previousBatchID || len(scheduledPayload.Draws) != 3 {
		t.Fatalf("unexpected scheduled draw: %+v", workerEvent)
	}
}

func phase4Request(f *phase2Fixture, token, path, body string, wantStatus int, dst any) {
	f.t.Helper()
	req, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := f.server.Client().Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		f.t.Fatalf("%s returned %s, want %d: %s", path, resp.Status, wantStatus, message)
	}
	if dst != nil {
		if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
			f.t.Fatalf("decode %s response: %v", path, err)
		}
	}
}

func phase4Player(f *phase2Fixture, userID int64) *repo.Player {
	f.t.Helper()
	player, err := f.fishingRepo.GetPlayerByID(f.ctx, userID)
	if err != nil {
		f.t.Fatal(err)
	}
	return player
}

func phase4AssertRevision(t *testing.T, before, after *repo.Player, increment int64) {
	t.Helper()
	if after.Version != before.Version+increment || after.InvRev != before.InvRev+increment {
		t.Fatalf("player revisions=(%d,%d), want (%d,%d)",
			after.Version, after.InvRev, before.Version+increment, before.InvRev+increment)
	}
}

func phase4Tickets(t *testing.T, player *repo.Player) []lottery.Ticket {
	t.Helper()
	var state struct {
		Marker struct {
			Keep bool `json:"keep"`
		} `json:"phase4_marker"`
		Tickets []lottery.Ticket `json:"lottery_tickets"`
	}
	if err := json.Unmarshal(player.State, &state); err != nil || !state.Marker.Keep {
		t.Fatalf("lottery operation lost unrelated player state: %s (%v)", player.State, err)
	}
	return state.Tickets
}

func phase4Items(f *phase2Fixture, userID int64) map[string]int64 {
	f.t.Helper()
	rows, err := f.pool.Query(f.ctx, `
		SELECT 'material:' || item_id, sum(quantity)::bigint FROM inventory_items
		WHERE user_id=$1 AND item_kind='material' GROUP BY item_id
		UNION ALL
		SELECT 'rod:' || template_id, count(*) FROM equipment_instances
		WHERE user_id=$1 AND slot_type='rod' GROUP BY template_id
	`, userID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	items := make(map[string]int64)
	for rows.Next() {
		var item string
		var quantity int64
		if err := rows.Scan(&item, &quantity); err != nil {
			f.t.Fatal(err)
		}
		items[item] = quantity
	}
	if err := rows.Err(); err != nil {
		f.t.Fatal(err)
	}
	return items
}

func phase4HiddenCard(t *testing.T, data json.RawMessage) lottery.PublicScratchCard {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if _, hasFace := fields["face"]; hasFace {
		t.Fatal("card response leaked an unrevealed face")
	}
	if _, hasPayouts := fields["payouts"]; hasPayouts {
		t.Fatal("card response leaked unrevealed payouts")
	}
	var card lottery.PublicScratchCard
	if err := json.Unmarshal(data, &card); err != nil {
		t.Fatal(err)
	}
	if card.Revealed || card.RevealedAt != nil || card.Face != nil || card.Payouts != nil {
		t.Fatalf("unexpected unrevealed card: %+v", card)
	}
	return card
}
