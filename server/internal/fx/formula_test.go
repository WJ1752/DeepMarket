package fx

import (
	"math"
	"runtime"
	"testing"
	"time"
)

func TestDayMove(t *testing.T) {
	cfg := DefaultConfig()
	for _, tt := range []struct {
		name                                string
		net, volume, prevClose, sensitivity float64
		move, imbalance                     float64
	}{
		{"ratio", 10, 40, 100, 1, 0.01, 0.25},
		{"absolute volume", -10, -40, 100, 1, -0.01, -0.25},
		{"clamped ratio", 20, 10, 100, 1, 0.04, 1},
		{"upper limit", 20, 10, 100, 10, 0.10, 1},
		{"lower limit", -20, 10, 100, 10, -0.10, -1},
		{"pull above base", 20, 0, 120, 1, -0.01, 0},
		{"pull below base", 0, 0, 80, 1, 0.01, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			move, imbalance := DayMove(tt.net, tt.volume, tt.prevClose, 100, tt.sensitivity, cfg)
			if math.Abs(move-tt.move) > 1e-12 || imbalance != tt.imbalance {
				t.Fatalf("DayMove = (%f, %f), want (%f, %f)", move, imbalance, tt.move, tt.imbalance)
			}
		})
	}
}

func TestDayBarAndQuoteInvariants(t *testing.T) {
	cfg := DefaultConfig()
	meta, _ := GetSymbol("swift")
	for _, tt := range []struct{ prevClose, net, volume, move float64 }{
		{30, 15, 30, 0.04},
		{30, -15, 30, -0.04},
		{30.001, 0, 0, 0},
		{0, -100, 100, -0.10},
	} {
		day := DayBar(meta.ID, 42, tt.prevClose, tt.net, tt.volume, tt.move, cfg)
		if day.Low < 1 || day.Low > min(day.Open, day.Close) || day.High < max(day.Open, day.Close) {
			t.Fatalf("invalid day candle: %+v", day)
		}
		quote := QuoteFromMid(meta, day.Close, day.Open, day.Net, day.Volume, cfg)
		if quote.Buy <= quote.Sell || quote.Sell < 1 || quote.Imbalance != day.Imbalance {
			t.Fatalf("invalid quote: %+v", quote)
		}
	}
}

func TestBuildCandlesAlignsSettledAndLivePrices(t *testing.T) {
	cfg := DefaultConfig()
	now := time.Date(2026, time.January, 5, 2, 17, 0, 0, time.UTC)
	dayIndex := UTCDayIndex(now)
	day := DayBar("swift", dayIndex-1, 30, -9, 27, -0.01, cfg)
	history := []DayCandle{day}
	today := BucketState{
		Symbol: "swift", DayIndex: dayIndex, Net: 2, Volume: 8,
		Bins: []BucketBin{{BinSlot: 0, Net: -3, Volume: 3}, {BinSlot: 9, Net: 5, Volume: 5}},
	}
	candles := BuildCandles("swift", history, today, 60, now, cfg)
	if len(candles) != 27 {
		t.Fatalf("got %d candles, want 24 settled and 3 live", len(candles))
	}
	var high, low, volume float64
	low = day.Open
	for i, bar := range candles {
		if bar.Low > min(bar.Open, bar.Close) || bar.High < max(bar.Open, bar.Close) || bar.Settled != (i < 24) || bar.Running != (i == 26) {
			t.Fatalf("invalid candle %d: %+v", i, bar)
		}
		if i < 24 {
			high, low, volume = max(high, bar.High), min(low, bar.Low), volume+bar.Volume
		}
	}
	if candles[0].Open != day.Open || candles[23].Close != day.Close || high != day.High || low != day.Low || math.Abs(volume-day.Volume) > 1e-12 {
		t.Fatalf("settled grains do not reconstruct %+v", day)
	}
	if candles[24].Volume != 3 || candles[25].Volume != 0 || candles[26].Volume != 5 || candles[26].Close != MidPrice("swift", history, today, now, cfg) {
		t.Fatalf("live grains do not match the bucket: %+v", candles[24:])
	}

	const preciseClose = 29.701234
	history[0].Close = preciseClose
	inactive := BucketState{DayIndex: dayIndex}
	candles = BuildCandles("swift", history, inactive, 60, now, cfg)
	last := candles[len(candles)-1]
	if mid := MidPrice("swift", history, inactive, now, cfg); mid != preciseClose || last.Low != mid || last.High != mid || last.Close != mid {
		t.Fatalf("inactive chart changed the previous close %f: mid=%f, candle=%+v", preciseClose, mid, last)
	}
}

func TestBuildCandlesBoundedWithLongHistory(t *testing.T) {
	const (
		historyDays   = 1000
		ticks         = 5000
		maxCandles    = 2880
		maxHeapGrowth = 32 * 1024 * 1024
	)
	cfg := DefaultConfig()
	meta, _ := GetSymbol("prismatic")
	now := time.Date(2026, time.January, 5, 0, 0, 0, 0, time.UTC)
	dayIndex := UTCDayIndex(now)
	history := make([]DayCandle, historyDays)
	prevClose := meta.BasePrice
	for i := range history {
		net, volume := float64(i%9-4), 12.0
		move, _ := DayMove(net, volume, prevClose, meta.BasePrice, meta.Sensitivity, cfg)
		history[i] = DayBar(meta.ID, dayIndex-historyDays+i, prevClose, net, volume, move, cfg)
		prevClose = history[i].Close
	}
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	assertHeapBound := func() {
		t.Helper()
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		if stats.HeapAlloc >= before.HeapAlloc+maxHeapGrowth {
			t.Fatalf("heap grew by %d bytes, want less than %d", stats.HeapAlloc-before.HeapAlloc, maxHeapGrowth)
		}
	}

	var candles []Candle
	for i := range ticks {
		net, volume := float64(i%11-5), float64(i+1)
		move, imbalance := DayMove(net, volume, prevClose, meta.BasePrice, meta.Sensitivity, cfg)
		if math.Abs(move) > cfg.DailyLimit || math.Abs(imbalance) > 1 {
			t.Fatalf("tick %d produced move %f and imbalance %f", i, move, imbalance)
		}
		slotTime := now.Add(time.Duration(i%binsPerDay*binMinutes) * time.Minute)
		today := BucketState{Symbol: meta.ID, DayIndex: dayIndex, Net: net, Volume: volume}
		candles = BuildCandles(meta.ID, history, today, 15, slotTime, cfg)
		if len(candles) == 0 || len(candles) > maxCandles || cap(candles) > maxCandles {
			t.Fatalf("tick %d: candles length %d and capacity %d exceed chart bounds", i, len(candles), cap(candles))
		}
		if i%100 == 0 {
			assertHeapBound()
		}
	}

	runtime.GC()
	assertHeapBound()
	runtime.KeepAlive(history)
	runtime.KeepAlive(candles)
}
