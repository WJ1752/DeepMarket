package fishing

import (
	"math"
	"slices"
	"testing"

	"deepmarket/server/internal/repo"
)

func TestDurabilityTensionFactor(t *testing.T) {
	for _, tc := range []struct{ ratio, want float64 }{
		{0, 0.8}, {0.2, 0.8}, {0.4, 0.9}, {0.6, 1}, {0.7, 1.1}, {0.8, 1.2}, {1.5, 1.2},
	} {
		if got := DurabilityTensionFactor(tc.ratio); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("DurabilityTensionFactor(%g) = %g, want %g", tc.ratio, got, tc.want)
		}
	}
}

func TestSawWear(t *testing.T) {
	combo := []string{"heavy", "abyssal", "surge", "prismatic"}
	wear := SawWear(combo, 800, 1000)
	if math.Abs(wear.Threshold-0.65) > 1e-9 || wear.Multiplier != 12 || math.Abs(wear.Excess-150) > 1e-9 || wear.Loss != 18 {
		t.Fatalf("SawWear(%v) = %+v, want threshold 0.65, multiplier 12, excess 150 and loss 18", combo, wear)
	}
	if wear := SawWear(combo, 649, 1000); wear.Loss != 0 {
		t.Errorf("wear below the threshold = %+v", wear)
	}
	if wear := SawWear([]string{"swift"}, 1000, 1000); wear.Loss != 0 {
		t.Errorf("wear without a saw-loss trait = %+v", wear)
	}
	if wear := SawWear([]string{"heavy"}, 810.8, 1000); wear.Loss != 0.3 || RoundDurabilityLoss(wear.Loss) != 1 {
		t.Errorf("wear = %+v, want 0.3 raw and 1 integer durability loss", wear)
	}
	if RoundDurabilityLoss(0) != 0 || RoundDurabilityLoss(2.5) != 3 {
		t.Error("zero wear or half-point durability rounding is incorrect")
	}
}

func TestBiteTiming(t *testing.T) {
	cfg := TensionConfig{MaxTension: 150, AccelMs: 1000, MaxRate: 100, DelayMs: 100}
	bite := BiteState{ChargeAtBite: 100, TensionDelayMs: 200}
	for _, tc := range []struct {
		name       string
		required   float64
		chargeMs   float64
		resolvedMs float64
		escaped    bool
	}{
		{"catch", 2100, 2000, 2000, false},
		{"tie", 2400, 2300, 2300, true},
		{"escape", 3100, 3000, 2300, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			timing := BiteTiming(1000, tc.required, bite, cfg)
			if timing.FillMs != 2300 || timing.ChargeMs != tc.chargeMs || timing.ResolvedAtMs != tc.resolvedMs || timing.Escaped != tc.escaped {
				t.Errorf("BiteTiming = %+v, want charge %g, fill 2300, resolution %g and escaped %t", timing, tc.chargeMs, tc.resolvedMs, tc.escaped)
			}
		})
	}
	if got := TensionAt(800, 1, 150, cfg, 300); got != 12.5 {
		t.Errorf("tension during acceleration = %g, want 12.5", got)
	}
	if got := TensionFillMs(1, 12.5, cfg, 300); got != 800 {
		t.Errorf("fill during acceleration = %g, want 800ms", got)
	}
	if got := TensionAt(2300, 1, 150, cfg, 300); got != 150 {
		t.Errorf("tension at fill time = %g, want 150", got)
	}
}

func TestAggregateAffixes(t *testing.T) {
	rod := &repo.EquipmentInstance{
		TemplateID: "tide", MaxDurability: 1000, Durability: 600,
		Affixes: []repo.Affix{
			{Type: "speed", Value: 0.25}, {Type: "speed", Value: 0.125},
			{Type: "technique", Value: 0.5}, {Type: "rarity", Value: 0.25},
			{Type: "material", Value: 0.125}, {Type: "size", Value: 0.5},
			{Type: "doubleCatch", Value: 0.5}, {Type: "doubleCatch", Value: 0.5},
			{Type: "unknown", Value: 1},
		},
	}
	want := AffixBonuses{
		SpeedBonus: 0.375, TechniqueBonus: 0.5, RarityBonus: 0.25,
		MaterialBonus: 0.125, SizeBonus: 0.5, DoubleCatchChance: 0.75,
	}
	if got := AggregateAffixes(rod.Affixes); got != want {
		t.Errorf("AggregateAffixes = %+v, want %+v", got, want)
	}
	if got := EffectiveRodEnergy(rod); got != 1375 {
		t.Errorf("EffectiveRodEnergy = %g, want 1375", got)
	}
	if got := EffectiveRodTension(rod); got.MaxTension != 1800 || got.MaxRate != 87.5 || got.AccelMs != 1000 {
		t.Errorf("EffectiveRodTension = %+v, want max tension 1800 with unchanged rate and acceleration", got)
	}
	if got := EffectiveRodResistance(rod); math.Abs(got-0.18) > 1e-9 {
		t.Errorf("EffectiveRodResistance = %g, want 0.18", got)
	}
	rod.Affixes = []repo.Affix{{Type: "speed", Value: -2}, {Type: "doubleCatch", Value: -1}, {Type: "technique", Value: 5}}
	if EffectiveRodEnergy(rod) != 100 || AggregateAffixes(rod.Affixes).DoubleCatchChance != 0 || math.Abs(EffectiveRodResistance(rod)-0.33) > 1e-9 {
		t.Error("speed floor, double-catch floor, or technique resistance cap is incorrect")
	}
}

func TestTraitDefinitions(t *testing.T) {
	want := map[string]struct {
		chance  float64
		effects []TraitEffect
	}{
		"swift":     {1.15, []TraitEffect{{"tensionRate", "multiply", 1.12}}},
		"armored":   {1.35, []TraitEffect{{"loss", "add", 4}, {"maxTension", "multiply", 0.94}}},
		"luminous":  {1.50, []TraitEffect{{"chargeRate", "multiply", 0.94}}},
		"heavy":     {1.60, []TraitEffect{{"loss", "add", 6}, {"sawLoss", "multiply", 3}}},
		"ancient":   {1.75, []TraitEffect{{"maxTension", "multiply", 0.90}, {"tensionDelay", "add", 180}}},
		"surge":     {1.90, []TraitEffect{{"tensionRate", "multiply", 1.08}, {"sawThreshold", "add", -0.05}}},
		"abyssal":   {2.05, []TraitEffect{{"tensionRate", "multiply", 1.12}, {"sawLoss", "multiply", 4}}},
		"prismatic": {2.30, []TraitEffect{{"maxTension", "multiply", 0.82}, {"chargeRate", "multiply", 0.90}, {"sawThreshold", "add", -0.10}}},
	}
	for _, trait := range traits {
		expected, ok := want[trait.ID]
		if !ok || trait.BiteChance != expected.chance || !slices.Equal(trait.Effects, expected.effects) {
			t.Errorf("unexpected trait definition %+v", trait)
		}
		delete(want, trait.ID)
	}
	if len(want) != 0 {
		t.Errorf("missing traits: %v", want)
	}
}

func TestRollBiteUsesDepthAndRodAffixes(t *testing.T) {
	rod := &repo.EquipmentInstance{
		TemplateID: "abyss", Durability: 2000, MaxDurability: 2000,
		Affixes: []repo.Affix{{Type: "size", Value: 0.25}},
	}
	bite := RollBite("abyss", rod, 150, 4500, func() float64 { return 0.99 })
	fish := bite.Fish
	if fish.SpeciesID != "jelly" || fish.Name != "静海幽灵水母" || fish.Tier != "legendary" || fish.WeightG != 18000 {
		t.Errorf("unexpected abyss catch: %+v", fish)
	}
	if len(fish.Traits) != 6 || !slices.Contains(fish.Traits, "abyssal") || !slices.Contains(fish.Traits, "prismatic") {
		t.Errorf("unexpected abyss traits: %v", fish.Traits)
	}
	if bite.StartedAtMs != 4500 || bite.ChargeAtBite != 150 || math.Abs(bite.ChargeRate-0.846) > 1e-9 {
		t.Errorf("unexpected bite charge: %+v", bite)
	}
}

func TestEvaluateAutoRepair(t *testing.T) {
	if AutoRepairThreshold(0) != 0 || AutoRepairThreshold(1) != 20 || AutoRepairThreshold(2) != 30 || AutoStopThreshold(0) != 10 {
		t.Fatal("repair or stop thresholds are incorrect")
	}
	base := AutoRepairInput{
		Durability: 18, MaxDurability: 20, AutoRepairLevel: 1, Running: true,
		MaterialQty: 3, Coins: 12, AllowCoinFallback: true, CoinCost: 12,
		NowMs: 18000, LastAutoRepairAtMs: 10000, CooldownMs: AutoRepairCooldownMs,
	}
	t.Run("overflow and material priority", func(t *testing.T) {
		got := EvaluateAutoRepair(base)
		if !got.Triggered || got.NewDurability != 63 || got.Restored != 45 || got.MaterialUsed != 1 || got.CoinsUsed != 0 || !got.NewRunning || got.NewAutoStopped || got.LowDurability {
			t.Errorf("unexpected repair decision: %+v", got)
		}
	})
	t.Run("at threshold", func(t *testing.T) {
		in := base
		in.Durability = AutoRepairThreshold(in.AutoRepairLevel)
		if got := EvaluateAutoRepair(in); got.Triggered || got.LowDurability {
			t.Errorf("unexpected decision at threshold: %+v", got)
		}
	})
	t.Run("cooldown", func(t *testing.T) {
		in := base
		in.NowMs--
		if got := EvaluateAutoRepair(in); got.Triggered || got.NewDurability != 18 || got.MaterialUsed != 0 {
			t.Errorf("unexpected decision during cooldown: %+v", got)
		}
	})
	t.Run("broken recovery", func(t *testing.T) {
		in := base
		in.Breakable, in.Broken, in.Running, in.Durability = true, true, false, 0
		if got := EvaluateAutoRepair(in); !got.Triggered || !got.ClearedBroken || !got.NewRunning || got.NewDurability != 45 {
			t.Errorf("unexpected broken-rod recovery: %+v", got)
		}
	})
	t.Run("auto-stops below threshold after repair", func(t *testing.T) {
		in := base
		in.AutoRepairLevel, in.AutoStopped, in.Running, in.Durability = 5, true, false, 1
		if got := EvaluateAutoRepair(in); !got.Triggered || got.NewRunning || !got.NewAutoStopped || !got.LowDurability {
			t.Errorf("unexpected low-durability decision: %+v", got)
		}
	})
	t.Run("coin fallback", func(t *testing.T) {
		in := base
		in.MaterialQty = 0
		if got := EvaluateAutoRepair(in); !got.Triggered || got.MaterialUsed != 0 || got.CoinsUsed != 12 {
			t.Errorf("unexpected fallback decision: %+v", got)
		}
		in.AllowCoinFallback = false
		if got := EvaluateAutoRepair(in); got.Triggered {
			t.Errorf("unexpected repair with fallback disabled: %+v", got)
		}
	})
}
