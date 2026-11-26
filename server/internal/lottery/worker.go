package lottery

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"deepmarket/server/internal/sse"
)

// Batch identifies a six-hour draw window.
type Batch struct {
	ID      string    `json:"batch_id"`
	StartAt time.Time `json:"start_at"`
	EndAt   time.Time `json:"end_at"`
}

type batchDrawer interface {
	EnsureBatch(ctx context.Context, batchID string, startAt, endAt time.Time, rules any) error
	ListDueLotteryBatches(ctx context.Context, now time.Time) ([]Batch, error)
	DrawBatchIdempotent(ctx context.Context, batchID string, startAt, endAt, drawnAt time.Time, rng func() float64) (map[string][]int, bool, error)
}

// Worker settles closed batches and publishes signed draw results.
type Worker struct {
	repo     batchDrawer
	hub      *sse.Hub
	interval time.Duration
	clock    func() time.Time

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	stopped bool
}

// NewWorker constructs a worker that begins polling on Start.
func NewWorker(repo batchDrawer, hub *sse.Hub, interval time.Duration, clock func() time.Time) *Worker {
	if interval <= 0 {
		interval = time.Minute
	}
	if clock == nil {
		clock = time.Now
	}
	return &Worker{repo: repo, hub: hub, interval: interval, clock: clock}
}

// DrawBatch commits a batch draw and publishes the result on its first settlement.
func (w *Worker) DrawBatch(ctx context.Context, batch Batch, now time.Time) (map[string][]int, bool, error) {
	draws, newlyDrawn, err := w.repo.DrawBatchIdempotent(ctx, batch.ID, batch.StartAt, batch.EndAt, now, nil)
	if err != nil {
		return nil, false, err
	}
	if newlyDrawn && w.hub != nil {
		payload := struct {
			BatchID string           `json:"batch_id"`
			Draws   map[string][]int `json:"draws"`
		}{BatchID: batch.ID, Draws: draws}
		if _, err := w.hub.PublishGlobal(0, "lottery_drawn", 0, 0, payload); err != nil {
			slog.Error("publish lottery draw", "batch_id", batch.ID, "error", err)
		}
	}
	return draws, newlyDrawn, nil
}

// DrawDueNow settles the latest closed window and any earlier pending batches.
func (w *Worker) DrawDueNow(ctx context.Context) error {
	now := w.clock()
	previous := BatchStart(now.Add(-BatchDuration))
	if err := w.repo.EnsureBatch(ctx, BatchIDAt(previous), previous, BatchEnd(previous), nil); err != nil {
		return err
	}
	batches, err := w.repo.ListDueLotteryBatches(ctx, now)
	if err != nil {
		return err
	}
	var drawErr error
	for _, batch := range batches {
		if ctx.Err() != nil {
			return errors.Join(drawErr, ctx.Err())
		}
		if _, _, err := w.DrawBatch(ctx, batch, now); err != nil {
			drawErr = errors.Join(drawErr, fmt.Errorf("draw lottery batch %s: %w", batch.ID, err))
		}
	}
	return drawErr
}

// Start launches the worker and settles the backlog before the first tick.
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
		if err := w.DrawDueNow(ctx); err != nil && ctx.Err() == nil {
			slog.Error("draw due lottery batches", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Shutdown cancels periodic settlement and waits for the worker to exit.
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
