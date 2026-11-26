package sse

import (
	"encoding/json"
	"testing"
	"time"
)

func TestEnvelopeSignature(t *testing.T) {
	secret := []byte("phase2-test-hmac-secret")
	env := Envelope{
		ID: "user-7-1", Event: "catch", Channel: "user", UserID: 7,
		Seq: 1, InvRev: 2, Version: 3, TsMs: 1700000000000, Payload: json.RawMessage(`{"fish":"jelly"}`),
	}
	env.Sig = SignEnvelope(secret, &env)
	const want = "8f956fe863f4edbb75be4680a25440e6c8f125669a2846b46cc7bdb79b50a139"
	if env.Sig != want || !VerifyEnvelope(secret, env) {
		t.Fatalf("signature = %q, want %q", env.Sig, want)
	}
	for name, tamper := range map[string]func(*Envelope){
		"payload":  func(e *Envelope) { e.Payload = json.RawMessage(`{"fish":"eel"}`) },
		"revision": func(e *Envelope) { e.InvRev++ },
		"bad hex":  func(e *Envelope) { e.Sig = "invalid" },
	} {
		t.Run(name, func(t *testing.T) {
			modified := env
			tamper(&modified)
			if VerifyEnvelope(secret, modified) {
				t.Fatal("tampered envelope passed verification")
			}
		})
	}
}

func TestHubMultiplexesWithoutLeakingUserEvents(t *testing.T) {
	clock := time.UnixMilli(1234)
	hub := testHub(t, WithClock(func() time.Time { return clock }))
	primary, _, cancel := hub.Subscribe(7, true, "")
	defer cancel()
	peer, _, cancel := hub.Subscribe(7, false, "")
	defer cancel()
	observer, _, cancel := hub.Subscribe(8, true, "")
	defer cancel()
	private, err := hub.PublishUser(7, "catch", 2, 2, map[string]string{"name": "<jelly>"})
	if err != nil {
		t.Fatal(err)
	}
	public, err := hub.PublishGlobal(7, "catch", 2, 2, map[string]string{"name": "<jelly>"})
	if err != nil {
		t.Fatal(err)
	}
	if public.Seq != private.Seq+1 || public.ID == private.ID || public.TsMs != clock.UnixMilli() {
		t.Fatalf("unexpected event metadata: private=%+v public=%+v", private, public)
	}
	assertNextEvent(t, primary, private.ID)
	assertNextEvent(t, primary, public.ID)
	assertNextEvent(t, peer, private.ID)
	assertNextEvent(t, observer, public.ID)
	for _, sub := range []*Subscriber{primary, peer, observer} {
		select {
		case env := <-sub.Events:
			t.Fatalf("unexpected event %s", env.ID)
		default:
		}
	}
}

func TestHubDropsWhenSubscriberQueueIsFull(t *testing.T) {
	hub := testHub(t, WithBufferSize(1))
	slow, _, cancel := hub.Subscribe(7, false, "")
	defer cancel()
	fast, _, cancel := hub.Subscribe(7, false, "")
	defer cancel()
	first, err := hub.PublishUser(7, "tick", 1, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertNextEvent(t, fast, first.ID)
	second, err := hub.PublishUser(7, "tick", 2, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertNextEvent(t, fast, second.ID)
	assertNextEvent(t, slow, first.ID)
	if count := hub.DroppedCount(); count != 1 {
		t.Fatalf("dropped deliveries = %d, want 1", count)
	}
}

func TestHubReplaysNewestVisibleEventsAfterCursor(t *testing.T) {
	hub := testHub(t, WithReplaySize(2))
	userEvent := func(userID int64) Envelope {
		t.Helper()
		env, err := hub.PublishUser(userID, "tick", 1, 1, map[string]bool{"ok": true})
		if err != nil {
			t.Fatal(err)
		}
		return env
	}
	cursor := userEvent(7)
	public, err := hub.PublishGlobal(8, "catch", 1, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	userEvent(8)
	userEvent(7)
	first, last := userEvent(7), userEvent(7)
	last.Payload[0] = '['
	sub, replay, cancel := hub.Subscribe(7, true, cursor.ID)
	defer cancel()
	want := []string{public.ID, first.ID, last.ID}
	if len(replay) != len(want) {
		t.Fatalf("replay count = %d, want %d", len(replay), len(want))
	}
	for i, env := range replay {
		if env.ID != want[i] || !VerifyEnvelope([]byte("test-key"), env) {
			t.Fatalf("replay[%d] = %+v, want signed event %s", i, env, want[i])
		}
	}
	assertNextEvent(t, sub, userEvent(7).ID)
}

func testHub(t *testing.T, opts ...Option) *Hub {
	t.Helper()
	hub, err := NewHub([]byte("test-key"), opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(hub.Close)
	return hub
}

func assertNextEvent(t *testing.T, sub *Subscriber, wantID string) {
	t.Helper()
	select {
	case env := <-sub.Events:
		if env.ID != wantID || !VerifyEnvelope([]byte("test-key"), env) {
			t.Fatalf("received %+v, want signed event %s", env, wantID)
		}
	default:
		t.Fatalf("missing live event %s", wantID)
	}
}
