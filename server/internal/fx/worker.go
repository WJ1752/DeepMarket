package fx

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"deepmarket/server/internal/sse"
)

// daySettler is implemented by the economy repository, which stores FX candles.
type daySettler interface {
	SettleDueFXDays(ctx context.Context, now time.Time, cfg Config) ([]DayCandle, error)
}

// Worker periodically settles previous UTC days and publishes signed FX updates.
type Worker struct {
	repo     daySettler
	hub      *sse.Hub
	cfg      Config
	interval time.Duration
	clock    func() time.Time

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	stopped bool
}

// NewWorker initializes the periodic settler. The worker starts on Start.
func NewWorker(economyRepo daySettler, hub *sse.Hub, cfg Config, interval time.Duration, clock func() time.Time) *Worker {
	if interval <= 0 {
		interval = time.Minute
	}
	if clock == nil {
		clock = time.Now
	}
	return &Worker{repo: economyRepo, hub: hub, cfg: cfg, interval: interval, clock: clock}
}

// SettleNow commits all due days and broadcasts the newly settled candles.
func (w *Worker) SettleNow(ctx context.Context) ([]DayCandle, error) {
	candles, err := w.repo.SettleDueFXDays(ctx, w.clock(), w.cfg)
	if err != nil {
		return nil, err
	}
	if len(candles) > 0 && w.hub != nil {
		payload := struct {
			Candles []DayCandle `json:"candles"`
		}{Candles: candles}
		if _, err := w.hub.PublishGlobal(0, "fx_tick", 0, 0, payload); err != nil {
			return candles, fmt.Errorf("publish settled FX candles: %w", err)
		}
	}
	return candles, nil
}

// Start launches the worker and settles any backlog before waiting for the first tick.
func (w *Worker) Start() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.done != nil || w.stopped {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	w.done = make(chan struct{})
	go w.run(ctx, w.done)
}

func (w *Worker) run(ctx context.Context, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if _, err := w.SettleNow(ctx); err != nil && ctx.Err() == nil {
			slog.Error("settle FX days", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Shutdown stops periodic settlement and waits for the worker to exit.
func (w *Worker) Shutdown(ctx context.Context) {
	w.mu.Lock()
	w.stopped = true
	done := w.done
	if w.cancel != nil {
		w.cancel()
	}
	w.mu.Unlock()
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-ctx.Done():
	}
}
