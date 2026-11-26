// Package lottery defines ticket draws and scratch card payouts.
package lottery

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"slices"
	"strconv"
	"strings"
	"time"
)

const BatchDuration = 6 * time.Hour

func BatchStart(t time.Time) time.Time {
	return t.UTC().Truncate(BatchDuration)
}

func BatchEnd(t time.Time) time.Time {
	return BatchStart(t).Add(BatchDuration)
}

func BatchIDAt(t time.Time) string {
	return BatchStart(t).Format(time.RFC3339)
}

type PrizeItem struct {
	Type  string `json:"type"`
	Name  string `json:"name,omitempty"`
	Qty   int64  `json:"qty"`
	RodID string `json:"rod_id,omitempty"`
}

type PoolDef struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Min        int           `json:"min"`
	Max        int           `json:"max"`
	Pick       int           `json:"pick"`
	TicketCost int64         `json:"ticket_cost"`
	Prizes     [][]PrizeItem `json:"prizes"`
}

var pools = [...]PoolDef{
	{
		ID: "normal", Name: "普通场", Min: 0, Max: 30, Pick: 6, TicketCost: 3,
		Prizes: [][]PrizeItem{
			{{Type: "coin", Qty: 5}},
			{{Type: "coin", Qty: 12}},
			{{Type: "material", Name: "浮木纤维", Qty: 5}},
			{{Type: "material", Name: "深蓝晶片", Qty: 1}},
			{{Type: "material", Name: "深蓝晶片", Qty: 2}},
			{{Type: "material", Name: "渊核碎片", Qty: 1}},
			{{Type: "rod", RodID: "azure", Qty: 1}},
		},
	},
	{
		ID: "advanced", Name: "高级场", Min: 31, Max: 99, Pick: 6, TicketCost: 6,
		Prizes: [][]PrizeItem{
			{{Type: "coin", Qty: 15}},
			{{Type: "coin", Qty: 35}},
			{{Type: "material", Name: "深蓝晶片", Qty: 3}},
			{{Type: "material", Name: "渊核碎片", Qty: 1}, {Type: "material", Name: "潮汐锁钥", Qty: 1}},
			{{Type: "material", Name: "渊核碎片", Qty: 2}, {Type: "material", Name: "潮汐锁钥", Qty: 2}},
			{{Type: "material", Name: "旧日合金", Qty: 1}, {Type: "material", Name: "潮汐锁钥", Qty: 3}},
			{{Type: "rod", RodID: "abyss", Qty: 1}, {Type: "material", Name: "潮汐锁钥", Qty: 4}},
		},
	},
	{
		ID: "master", Name: "大师场", Min: 100, Max: 199, Pick: 6, TicketCost: 10,
		Prizes: [][]PrizeItem{
			{{Type: "coin", Qty: 40}},
			{{Type: "coin", Qty: 90}},
			{{Type: "material", Name: "深渊锁钥", Qty: 1}},
			{{Type: "material", Name: "深渊锁钥", Qty: 2}, {Type: "material", Name: "旧日合金", Qty: 1}},
			{{Type: "material", Name: "深渊锁钥", Qty: 3}, {Type: "material", Name: "渊核碎片", Qty: 3}},
			{{Type: "material", Name: "深渊锁钥", Qty: 5}, {Type: "material", Name: "旧日合金", Qty: 2}},
			{{Type: "rod", RodID: "abyss", Qty: 1}, {Type: "material", Name: "深渊锁钥", Qty: 6}},
		},
	},
}

func AllPools() []PoolDef {
	defs := make([]PoolDef, len(pools))
	for i, pool := range pools {
		defs[i] = clonePool(pool)
	}
	return defs
}

func GetPool(id string) (PoolDef, bool) {
	for _, pool := range pools {
		if pool.ID == id {
			return clonePool(pool), true
		}
	}
	return PoolDef{}, false
}

func clonePool(pool PoolDef) PoolDef {
	pool.Prizes = slices.Clone(pool.Prizes)
	for i, prizes := range pool.Prizes {
		pool.Prizes[i] = slices.Clone(prizes)
	}
	return pool
}

// DrawPoolNumbers samples without replacement using a partial Fisher-Yates shuffle.
// A supplied rng returns values in [0, 1). A nil rng uses crypto/rand.
func DrawPoolNumbers(pool PoolDef, rng func() float64) []int {
	size := pool.Max - pool.Min + 1
	if pool.Pick < 1 || pool.Pick > size {
		return nil
	}
	if rng == nil {
		rng = secureFloat64
	}
	numbers := make([]int, size)
	for i := range numbers {
		numbers[i] = pool.Min + i
	}
	for i := 0; i < pool.Pick; i++ {
		remaining := len(numbers) - i
		offset := min(remaining-1, max(0, int(rng()*float64(remaining))))
		numbers[i], numbers[i+offset] = numbers[i+offset], numbers[i]
	}
	picked := numbers[:pool.Pick]
	slices.Sort(picked)
	return picked
}

// DrawSeedHash commits to the supplied numbers as comma-separated decimals
// and the salt as lowercase hexadecimal.
func DrawSeedHash(batchID, poolID string, nums []int, salt []byte) string {
	numbers := make([]string, len(nums))
	for i, number := range nums {
		numbers[i] = strconv.Itoa(number)
	}
	input := batchID + "|" + poolID + "|" + strings.Join(numbers, ",") + "|" + hex.EncodeToString(salt)
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

func CountHits(ticketNums, winningNums []int) int {
	winning := make(map[int]struct{}, len(winningNums))
	for _, number := range winningNums {
		winning[number] = struct{}{}
	}
	hits := 0
	for _, number := range ticketNums {
		if _, ok := winning[number]; ok {
			hits++
			delete(winning, number)
		}
	}
	return hits
}

func RewardForHits(pool PoolDef, hits int) []PrizeItem {
	if hits < 0 || hits >= len(pool.Prizes) {
		return nil
	}
	return slices.Clone(pool.Prizes[hits])
}

type Ticket struct {
	ID         string `json:"id"`
	Tier       string `json:"tier"`
	BatchID    string `json:"batch_id"`
	Numbers    []int  `json:"numbers"`
	Status     string `json:"status"`
	AssignedAt string `json:"assigned_at"`
}

type ScratchSlot struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	Qty  int64  `json:"qty"`
	Need int    `json:"need"`
}

type ScratchPrizeDef struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Qty       int64  `json:"qty"`
	Need      int    `json:"need"`
	Weight    int    `json:"weight"`
	CostCoins int64  `json:"cost_coins,omitempty"`
}

type ScratchTypeDef struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Slots     int               `json:"slots"`
	CostCoins int64             `json:"cost_coins"`
	Prizes    []ScratchPrizeDef `json:"prizes"`
}

var scratchTypes = [...]ScratchTypeDef{
	{
		ID: "scratch-tide", Name: "潮汐刮刮乐", Slots: 3, CostCoins: 30,
		Prizes: []ScratchPrizeDef{
			{ID: "浮木纤维", Kind: "material", Name: "浮木纤维", Qty: 3, Need: 2, Weight: 28},
			{ID: "潮汐树脂", Kind: "material", Name: "潮汐树脂", Qty: 3, Need: 2, Weight: 28},
			{ID: "coin", Kind: "coin", Name: "coin", Qty: 10, Need: 2, Weight: 24},
			{ID: "深蓝晶片", Kind: "material", Name: "深蓝晶片", Qty: 1, Need: 2, Weight: 20},
		},
	},
	{
		ID: "scratch-super", Name: "深渊超级刮刮乐", Slots: 9, CostCoins: 120,
		Prizes: []ScratchPrizeDef{
			{ID: "深蓝晶片", Kind: "material", Name: "深蓝晶片", Qty: 3, Need: 3, Weight: 30},
			{ID: "渊核碎片", Kind: "material", Name: "渊核碎片", Qty: 2, Need: 3, Weight: 24},
			{ID: "coin", Kind: "coin", Name: "coin", Qty: 80, Need: 3, Weight: 26},
			{ID: "潮汐锁钥", Kind: "material", Name: "潮汐锁钥", Qty: 1, Need: 3, Weight: 14},
			{ID: "深渊锁钥", Kind: "material", Name: "深渊锁钥", Qty: 1, Need: 3, Weight: 6},
		},
	},
}

func GetScratchType(id string) (ScratchTypeDef, bool) {
	for _, cardType := range scratchTypes {
		if cardType.ID == id {
			cardType.Prizes = slices.Clone(cardType.Prizes)
			return cardType, true
		}
	}
	return ScratchTypeDef{}, false
}

func AllScratchTypes() []ScratchTypeDef {
	types := slices.Clone(scratchTypes[:])
	for i := range types {
		types[i].Prizes = slices.Clone(types[i].Prizes)
	}
	return types
}

// DrawScratchFace independently rolls a weighted prize for each slot.
// A supplied rng returns values in [0, 1). A nil rng uses crypto/rand.
func DrawScratchFace(cardType ScratchTypeDef, rng func() float64) []ScratchSlot {
	totalWeight := 0
	for _, prize := range cardType.Prizes {
		totalWeight += max(0, prize.Weight)
	}
	if cardType.Slots < 1 || totalWeight == 0 {
		return nil
	}
	if rng == nil {
		rng = secureFloat64
	}
	face := make([]ScratchSlot, cardType.Slots)
	for i := range face {
		roll := rng() * float64(totalWeight)
		for _, prize := range cardType.Prizes {
			if prize.Weight <= 0 {
				continue
			}
			face[i] = ScratchSlot{ID: prize.ID, Kind: prize.Kind, Name: prize.Name, Qty: prize.Qty, Need: prize.Need}
			roll -= float64(prize.Weight)
			if roll < 0 {
				break
			}
		}
	}
	return face
}

type ScratchPayout struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Qty    int64  `json:"qty"`
	Count  int    `json:"count"`
	Need   int    `json:"need"`
	Combos int64  `json:"combos"`
}

type ScratchSettlement struct {
	Pairs   int64           `json:"pairs"`
	Payouts []ScratchPayout `json:"payouts"`
}

// SettleScratchFace awards the slot quantity once per matching combination.
func SettleScratchFace(face []ScratchSlot) ScratchSettlement {
	counts := make(map[ScratchSlot]int, len(face))
	for _, slot := range face {
		counts[slot]++
	}
	settlement := ScratchSettlement{Payouts: make([]ScratchPayout, 0)}
	for _, slot := range face {
		count := counts[slot]
		delete(counts, slot)
		if slot.Need < 1 || count < slot.Need {
			continue
		}
		combos := combinations(count, slot.Need)
		settlement.Pairs += combos
		settlement.Payouts = append(settlement.Payouts, ScratchPayout{
			Kind: slot.Kind, Name: slot.Name, Qty: slot.Qty * combos,
			Count: count, Need: slot.Need, Combos: combos,
		})
	}
	return settlement
}

func combinations(count, need int) int64 {
	terms := min(need, count-need)
	result := int64(1)
	for i := 1; i <= terms; i++ {
		result = result * int64(count-terms+i) / int64(i)
	}
	return result
}

type PublicScratchCard struct {
	ID         int64           `json:"id"`
	CardType   string          `json:"card_type"`
	Slots      int             `json:"slots"`
	Revealed   bool            `json:"revealed"`
	CreatedAt  time.Time       `json:"created_at"`
	RevealedAt *time.Time      `json:"revealed_at"`
	Face       []ScratchSlot   `json:"face,omitempty"`
	Payouts    []ScratchPayout `json:"payouts,omitempty"`
}

func secureFloat64() float64 {
	var bytes [8]byte
	rand.Read(bytes[:])
	return float64(binary.LittleEndian.Uint64(bytes[:])>>11) / (1 << 53)
}
