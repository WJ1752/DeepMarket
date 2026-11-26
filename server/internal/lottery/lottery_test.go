package lottery

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"testing"
	"time"
)

func TestBatchAlignment(t *testing.T) {
	zone := time.FixedZone("UTC+8", 8*60*60)
	cases := []struct {
		name  string
		input time.Time
		start time.Time
		end   time.Time
		id    string
	}{
		{
			name:  "before boundary",
			input: time.Date(2026, 11, 26, 13, 59, 59, 0, zone),
			start: time.Date(2026, 11, 26, 0, 0, 0, 0, time.UTC),
			end:   time.Date(2026, 11, 26, 6, 0, 0, 0, time.UTC),
			id:    "2026-11-26T00:00:00Z",
		},
		{
			name:  "on boundary",
			input: time.Date(2026, 11, 26, 14, 0, 0, 0, zone),
			start: time.Date(2026, 11, 26, 6, 0, 0, 0, time.UTC),
			end:   time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC),
			id:    "2026-11-26T06:00:00Z",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if start, end, id := BatchStart(tc.input), BatchEnd(tc.input), BatchIDAt(tc.input); start != tc.start || end != tc.end || id != tc.id {
				t.Fatalf("batch bounds and ID = %v, %v, %q; want %v, %v, %q", start, end, id, tc.start, tc.end, tc.id)
			}
		})
	}
}

func TestDrawPoolNumbers(t *testing.T) {
	for _, pool := range AllPools() {
		t.Run(pool.ID, func(t *testing.T) {
			numbers := DrawPoolNumbers(pool, func() float64 { return 0.99 })
			if len(numbers) != pool.Pick {
				t.Fatalf("draw = %v, want %d numbers", numbers, pool.Pick)
			}
			for i, number := range numbers {
				if number < pool.Min || number > pool.Max {
					t.Fatalf("draw = %v, want numbers within [%d, %d]", numbers, pool.Min, pool.Max)
				}
				if i > 0 && numbers[i-1] >= number {
					t.Fatalf("draw = %v, want distinct sorted numbers", numbers)
				}
			}
		})
	}
}

func TestDrawSeedHash(t *testing.T) {
	want := sha256.Sum256([]byte("2026-11-26T00:00:00Z|normal|0,12,30|00ff"))
	if got := DrawSeedHash("2026-11-26T00:00:00Z", "normal", []int{0, 12, 30}, []byte{0, 255}); got != hex.EncodeToString(want[:]) {
		t.Fatalf("DrawSeedHash() = %q, want %x", got, want)
	}
}

func TestCountHitsAndReward(t *testing.T) {
	pool, ok := GetPool("advanced")
	if !ok {
		t.Fatal("advanced pool missing")
	}
	hits := CountHits([]int{31, 31, 53, 80, 99}, []int{31, 32, 53, 55, 91, 99})
	if hits != 3 {
		t.Fatalf("CountHits() = %d, want 3", hits)
	}
	want := []PrizeItem{
		{Type: "material", Name: "渊核碎片", Qty: 1},
		{Type: "material", Name: "潮汐锁钥", Qty: 1},
	}
	if got := RewardForHits(pool, hits); !slices.Equal(got, want) {
		t.Fatalf("RewardForHits() = %+v, want %+v", got, want)
	}
	if got := RewardForHits(pool, 7); got != nil {
		t.Fatalf("RewardForHits() = %+v for 7 hits, want nil", got)
	}
}

func TestDrawScratchFace(t *testing.T) {
	cardType, ok := GetScratchType("scratch-tide")
	if !ok {
		t.Fatal("scratch-tide type missing")
	}
	rolls := []float64{0, 0.29, 0.95}
	got := DrawScratchFace(cardType, func() float64 {
		roll := rolls[0]
		rolls = rolls[1:]
		return roll
	})
	want := []ScratchSlot{
		{ID: "浮木纤维", Kind: "material", Name: "浮木纤维", Qty: 3, Need: 2},
		{ID: "潮汐树脂", Kind: "material", Name: "潮汐树脂", Qty: 3, Need: 2},
		{ID: "深蓝晶片", Kind: "material", Name: "深蓝晶片", Qty: 1, Need: 2},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("DrawScratchFace() = %+v, want %+v", got, want)
	}
}

func TestSettleScratchFace(t *testing.T) {
	tideCoin := ScratchSlot{ID: "coin", Kind: "coin", Name: "coin", Qty: 10, Need: 2}
	superCoin := ScratchSlot{ID: "coin", Kind: "coin", Name: "coin", Qty: 80, Need: 3}
	fiber := ScratchSlot{ID: "浮木纤维", Kind: "material", Name: "浮木纤维", Qty: 3, Need: 2}
	cases := []struct {
		name    string
		face    []ScratchSlot
		pairs   int64
		payouts []ScratchPayout
	}{
		{
			name:  "two choose two",
			face:  []ScratchSlot{tideCoin, fiber, tideCoin},
			pairs: 1,
			payouts: []ScratchPayout{
				{Kind: "coin", Name: "coin", Qty: 10, Count: 2, Need: 2, Combos: 1},
			},
		},
		{
			name:  "three choose two",
			face:  []ScratchSlot{fiber, fiber, fiber},
			pairs: 3,
			payouts: []ScratchPayout{
				{Kind: "material", Name: "浮木纤维", Qty: 9, Count: 3, Need: 2, Combos: 3},
			},
		},
		{
			name:  "three choose three",
			face:  []ScratchSlot{superCoin, superCoin, superCoin},
			pairs: 1,
			payouts: []ScratchPayout{
				{Kind: "coin", Name: "coin", Qty: 80, Count: 3, Need: 3, Combos: 1},
			},
		},
		{
			name: "zero matches",
			face: []ScratchSlot{tideCoin, fiber},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SettleScratchFace(tc.face)
			if got.Pairs != tc.pairs || !slices.Equal(got.Payouts, tc.payouts) {
				t.Fatalf("SettleScratchFace() = %+v, want %d pairs and payouts %+v", got, tc.pairs, tc.payouts)
			}
		})
	}
}
