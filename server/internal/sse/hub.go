// Package sse signs and distributes multiplexed server-sent events.
package sse

import (
	"cmp"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Envelope is the signed representation shared by history and live streams.
type Envelope struct {
	ID      string          `json:"id"`
	Event   string          `json:"event"`
	Channel string          `json:"channel"`
	UserID  int64           `json:"user_id"`
	Seq     int64           `json:"seq"`
	InvRev  int64           `json:"inv_rev"`
	Version int64           `json:"version"`
	TsMs    int64           `json:"ts_ms"`
	Payload json.RawMessage `json:"payload"`
	Sig     string          `json:"sig"`
}

// SignEnvelope returns the lowercase hexadecimal HMAC of the canonical message.
func SignEnvelope(secret []byte, env *Envelope) string {
	return hex.EncodeToString(envelopeMAC(secret, env))
}

// VerifyEnvelope checks the provided signature against the envelope's contents.
func VerifyEnvelope(secret []byte, env Envelope) bool {
	sig, err := hex.DecodeString(env.Sig)
	return err == nil && hmac.Equal(sig, envelopeMAC(secret, &env))
}

func envelopeMAC(secret []byte, env *Envelope) []byte {
	mac := hmac.New(sha256.New, secret)
	fmt.Fprintf(mac, "%s|%s|%s|%d|%d|%d|%d|%d|", env.ID, env.Event, env.Channel, env.UserID, env.Seq, env.InvRev, env.Version, env.TsMs)
	mac.Write(env.Payload)
	return mac.Sum(nil)
}

// Subscriber receives the live events for one multiplexed stream.
type Subscriber struct {
	Events <-chan Envelope
}

type subscription struct {
	userID        int64
	includeGlobal bool
	events        chan Envelope
}

type eventRing struct {
	events []Envelope
	next   int
}

func (r *eventRing) add(env Envelope, capacity int) {
	if capacity == 0 {
		return
	}
	if len(r.events) < capacity {
		r.events = append(r.events, env)
		return
	}
	r.events[r.next] = env
	r.next = (r.next + 1) % capacity
}

func (r *eventRing) appendAfter(dst []Envelope, seq int64) []Envelope {
	for _, env := range r.events {
		if env.Seq > seq {
			dst = append(dst, cloneEnvelope(env))
		}
	}
	return dst
}

// Hub owns the signed event sequence, bounded stream histories and subscriptions.
type Hub struct {
	secret       []byte
	bufferSize   int
	replaySize   int
	heartbeat    time.Duration
	clock        func() time.Time
	droppedCount atomic.Uint64

	mu          sync.Mutex
	done        chan struct{}
	seq         int64
	global      eventRing
	users       map[int64]*eventRing
	subscribers map[*Subscriber]subscription
}

// Option configures a hub before it is used.
type Option func(*Hub)

// WithBufferSize sets each subscriber's live queue capacity.
func WithBufferSize(size int) Option {
	return func(h *Hub) { h.bufferSize = max(0, size) }
}

// WithReplaySize sets the history capacity per user and for the global stream.
func WithReplaySize(size int) Option {
	return func(h *Hub) { h.replaySize = max(0, size) }
}

// WithHeartbeatInterval sets the interval between heartbeat comments.
func WithHeartbeatInterval(interval time.Duration) Option {
	return func(h *Hub) {
		if interval > 0 {
			h.heartbeat = interval
		}
	}
}

// WithClock overrides the time source used for envelope timestamps.
func WithClock(clock func() time.Time) Option {
	return func(h *Hub) {
		if clock != nil {
			h.clock = clock
		}
	}
}

// NewHub constructs a hub using a private copy of the signing secret.
func NewHub(secret []byte, opts ...Option) (*Hub, error) {
	if len(secret) == 0 {
		return nil, errors.New("SSE signing secret must be set")
	}
	h := &Hub{
		secret: slices.Clone(secret), bufferSize: 32, replaySize: 128,
		heartbeat: 15 * time.Second, clock: time.Now, done: make(chan struct{}),
		users: make(map[int64]*eventRing), subscribers: make(map[*Subscriber]subscription),
	}
	for _, opt := range opts {
		opt(h)
	}
	return h, nil
}

// Subscribe atomically takes a replay snapshot and registers for subsequent live events.
func (h *Hub) Subscribe(userID int64, includeGlobal bool, lastEventID string) (*Subscriber, []Envelope, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()

	events := make(chan Envelope, h.bufferSize)
	sub := &Subscriber{Events: events}
	select {
	case <-h.done:
		close(events)
		return sub, nil, func() {}
	default:
	}

	var replay []Envelope
	if seq, ok := replaySequence(lastEventID, userID, includeGlobal); ok && seq <= h.seq {
		if history := h.users[userID]; history != nil {
			replay = history.appendAfter(replay, seq)
		}
		if includeGlobal {
			replay = h.global.appendAfter(replay, seq)
		}
		slices.SortFunc(replay, func(a, b Envelope) int { return cmp.Compare(a.Seq, b.Seq) })
	}
	h.subscribers[sub] = subscription{userID: userID, includeGlobal: includeGlobal, events: events}
	return sub, replay, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if entry, exists := h.subscribers[sub]; exists {
			delete(h.subscribers, sub)
			close(entry.events)
		}
	}
}

func replaySequence(id string, userID int64, includeGlobal bool) (int64, bool) {
	channel, rest, ok := strings.Cut(id, "-")
	if !ok || (channel != "user" && (channel != "global" || !includeGlobal)) {
		return 0, false
	}
	separator := strings.LastIndexByte(rest, '-')
	if separator < 0 {
		return 0, false
	}
	publisher, err := strconv.ParseInt(rest[:separator], 10, 64)
	if err != nil || (channel == "user" && publisher != userID) {
		return 0, false
	}
	seq, err := strconv.ParseInt(rest[separator+1:], 10, 64)
	return seq, err == nil && seq > 0 && id == eventID(channel, publisher, seq)
}

// PublishUser signs and publishes an event visible to the given user.
func (h *Hub) PublishUser(userID int64, event string, invRev, version int64, payload any) (Envelope, error) {
	return h.publish("user", userID, event, invRev, version, payload)
}

// PublishGlobal signs and publishes an event visible on the global stream.
func (h *Hub) PublishGlobal(userID int64, event string, invRev, version int64, payload any) (Envelope, error) {
	return h.publish("global", userID, event, invRev, version, payload)
}

func (h *Hub) publish(channel string, userID int64, event string, invRev, version int64, payload any) (Envelope, error) {
	if event == "" || strings.ContainsAny(event, "\r\n\x00|") {
		return Envelope{}, errors.New("invalid SSE event name")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, fmt.Errorf("encode SSE payload: %w", err)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case <-h.done:
		return Envelope{}, errors.New("SSE hub closed")
	default:
	}
	h.seq++
	env := Envelope{
		ID: eventID(channel, userID, h.seq), Event: event, Channel: channel, UserID: userID,
		Seq: h.seq, InvRev: invRev, Version: version, TsMs: h.clock().UnixMilli(), Payload: data,
	}
	env.Sig = SignEnvelope(h.secret, &env)
	global := channel == "global"
	if global {
		h.global.add(env, h.replaySize)
	} else if h.replaySize > 0 {
		history := h.users[userID]
		if history == nil {
			history = &eventRing{}
			h.users[userID] = history
		}
		history.add(env, h.replaySize)
	}
	for _, sub := range h.subscribers {
		if (global && sub.includeGlobal) || (!global && sub.userID == userID) {
			select {
			case sub.events <- cloneEnvelope(env):
			default:
				h.droppedCount.Add(1)
			}
		}
	}
	return cloneEnvelope(env), nil
}

func eventID(channel string, userID, seq int64) string {
	return fmt.Sprintf("%s-%d-%d", channel, userID, seq)
}

func cloneEnvelope(env Envelope) Envelope {
	env.Payload = slices.Clone(env.Payload)
	return env
}

// DroppedCount returns the number of live deliveries rejected by full queues.
func (h *Hub) DroppedCount() uint64 { return h.droppedCount.Load() }

// Close terminates streams and rejects future publications.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case <-h.done:
		return
	default:
		close(h.done)
	}
	for sub, entry := range h.subscribers {
		close(entry.events)
		delete(h.subscribers, sub)
	}
}

// ServeHTTP streams events for an authenticated user until disconnection or shutdown.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request, userID int64, includeGlobal bool) {
	if _, ok := w.(http.Flusher); !ok {
		http.Error(w, "streaming unavailable", http.StatusInternalServerError)
		return
	}
	lastEventID := r.Header.Get("Last-Event-ID")
	if lastEventID == "" {
		lastEventID = r.URL.Query().Get("last_event_id")
	}
	sub, replay, cancel := h.Subscribe(userID, includeGlobal, lastEventID)
	defer cancel()

	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	send := func(frame []byte) error {
		// Bound each write while allowing idle streams to stay connected.
		if controller.SetWriteDeadline(time.Now().Add(5*time.Second)) == nil {
			defer controller.SetWriteDeadline(time.Time{})
		}
		if _, err := w.Write(frame); err != nil {
			return err
		}
		return controller.Flush()
	}
	sendEnvelope := func(env Envelope) error {
		data, err := json.Marshal(env)
		if err != nil {
			return err
		}
		return send(fmt.Appendf(nil, "id: %s\nevent: %s\ndata: %s\n\n", env.ID, env.Event, data))
	}
	if err := send([]byte(": connected\n\n")); err != nil {
		return
	}
	for _, env := range replay {
		select {
		case <-r.Context().Done():
			return
		case <-h.done:
			return
		default:
		}
		if err := sendEnvelope(env); err != nil {
			return
		}
	}

	ticker := time.NewTicker(h.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-h.done:
			return
		case env, open := <-sub.Events:
			if !open || sendEnvelope(env) != nil {
				return
			}
		case <-ticker.C:
			if err := send([]byte(": keepalive\n\n")); err != nil {
				return
			}
		}
	}
}
