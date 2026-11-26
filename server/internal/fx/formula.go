// Package fx calculates DeepSea trait exchange prices and candles.
package fx

import (
	"cmp"
	"math"
	"slices"
	"time"
)

const (
	binMinutes    = 15
	binsPerDay    = 96
	chartDays     = 30
	secondsPerDay = 86400
)

// SymbolMeta describes one tradable fish trait.
type SymbolMeta struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	BasePrice   float64 `json:"base_price"`
	Sensitivity float64 `json:"sensitivity"`
}

var symbols = [...]SymbolMeta{
	{"swift", "迅游", 30, 0.90},
	{"armored", "重甲", 34, 0.90},
	{"luminous", "辉光", 40, 1.00},
	{"heavy", "巨型", 52, 1.05},
	{"ancient", "远古", 72, 1.10},
	{"surge", "深涌", 88, 1.15},
	{"abyssal", "渊印", 120, 1.25},
	{"prismatic", "棱彩", 165, 1.40},
}

// AllSymbols returns a copy of the exchange's symbols in display order.
func AllSymbols() []SymbolMeta {
	return slices.Clone(symbols[:])
}

// GetSymbol looks up a tradable trait by ID.
func GetSymbol(id string) (SymbolMeta, bool) {
	for _, meta := range symbols {
		if meta.ID == id {
			return meta, true
		}
	}
	return SymbolMeta{}, false
}

// Config controls price formation, trading, and retention.
type Config struct {
	Volatility  float64
	Reversion   float64
	FeeRate     float64
	Spread      float64
	DailyLimit  float64
	MaxPosition int64
	KeepDays    int
	BinKeepDays int
	BinMinutes  int
	BinsPerDay  int
}

// DefaultConfig returns the Phase 3 exchange settings.
func DefaultConfig() Config {
	return Config{
		Volatility: 0.04, Reversion: 0.05, FeeRate: 0.02, Spread: 0.02, DailyLimit: 0.10,
		MaxPosition: 200, KeepDays: 365, BinKeepDays: chartDays, BinMinutes: binMinutes, BinsPerDay: binsPerDay,
	}
}

// UTCDayIndex identifies the UTC date by its day offset from the Unix epoch.
func UTCDayIndex(t time.Time) int {
	return int(t.UTC().Unix() / secondsPerDay)
}

// UTCBinSlot returns the current fifteen-minute slot within the UTC day.
func UTCBinSlot(t time.Time) int {
	t = t.UTC()
	return min(binsPerDay-1, max(0, (t.Hour()*60+t.Minute())/binMinutes))
}

// DayMove combines order-flow imbalance with mean reversion to the base price.
func DayMove(net, volume, prevClose, base, sensitivity float64, cfg Config) (move float64, imbalance float64) {
	imbalance = flowImbalance(net, math.Abs(volume))
	shock := imbalance * cfg.Volatility * max(0.1, sensitivity)
	anchor := 0.0
	if base > 0 && prevClose > 0 {
		anchor = prevClose/base - 1
	}
	limit := cfg.DailyLimit
	if limit <= 0 {
		limit = DefaultConfig().DailyLimit
	}
	return min(limit, max(-limit, shock-cfg.Reversion*anchor)), imbalance
}

// DayCandle is the settled price and flow for a symbol on a UTC day.
type DayCandle struct {
	Symbol    string    `json:"symbol"`
	DayIndex  int       `json:"day_index"`
	Open      float64   `json:"open"`
	High      float64   `json:"high"`
	Low       float64   `json:"low"`
	Close     float64   `json:"close"`
	Net       float64   `json:"net"`
	Volume    float64   `json:"volume"`
	Move      float64   `json:"move"`
	Imbalance float64   `json:"imbalance"`
	SettledAt time.Time `json:"settled_at"`
}

// DayBar turns a day's move and activity into a candle with asymmetric wicks.
func DayBar(symbol string, dayIndex int, prevClose, net, volume, move float64, cfg Config) DayCandle {
	open := max(1, prevClose)
	closePrice := max(1, roundPrice(open*(1+move)))
	imbalance := flowImbalance(net, volume)
	high, low := barWicks(open, closePrice, volume, imbalance, cfg)
	return DayCandle{
		Symbol: symbol, DayIndex: dayIndex, Open: open, Close: closePrice, High: high, Low: low,
		Net: net, Volume: volume, Move: move, Imbalance: imbalance,
	}
}

func barWicks(open, closePrice, volume, imbalance float64, cfg Config) (high, low float64) {
	if open == closePrice && volume <= 0 {
		return open, open
	}
	span := math.Abs(closePrice - open)
	activity := 0.0
	if volume > 0 {
		activity = min(1, math.Log10(1+volume)/4)
	}
	upWick := span*0.35 + closePrice*cfg.Volatility*activity*(0.4+max(0, imbalance)*0.6)
	downWick := span*0.35 + closePrice*cfg.Volatility*activity*(0.4+max(0, -imbalance)*0.6)
	top, bottom := max(open, closePrice), min(open, closePrice)
	return max(top, roundPrice(top+upWick)), min(bottom, max(1, roundPrice(bottom-downWick)))
}

// BucketBin stores the flow accumulated in one fifteen-minute interval.
type BucketBin struct {
	BinSlot int     `json:"bin_slot"`
	Net     float64 `json:"net"`
	Volume  float64 `json:"volume"`
}

// BucketState stores a symbol's daily flow and available bin data.
type BucketState struct {
	Symbol   string      `json:"symbol"`
	DayIndex int         `json:"day_index"`
	Net      float64     `json:"net"`
	Volume   float64     `json:"volume"`
	Bins     []BucketBin `json:"bins"`
}

// MidPrice applies the released portion of the live day's move to the prior close.
func MidPrice(symbol string, history []DayCandle, today BucketState, now time.Time, cfg Config) float64 {
	meta, ok := GetSymbol(symbol)
	if !ok {
		return 0
	}
	dayIndex := UTCDayIndex(now)
	prevClose := meta.BasePrice
	var latestDay int
	found := false
	for _, day := range history {
		if day.DayIndex < dayIndex && (!found || day.DayIndex > latestDay) {
			prevClose, latestDay, found = day.Close, day.DayIndex, true
		}
	}
	if today.DayIndex != dayIndex {
		return max(1, prevClose)
	}
	return livePrice(meta, prevClose, today.Net, today.Volume, UTCBinSlot(now)+1, cfg)
}

func livePrice(meta SymbolMeta, prevClose, net, volume float64, slots int, cfg Config) float64 {
	if volume <= 0 {
		return max(1, prevClose)
	}
	move, _ := DayMove(net, volume, prevClose, meta.BasePrice, meta.Sensitivity, cfg)
	share := releaseShare(float64(slots) / binsPerDay)
	return max(1, roundPrice(prevClose*(1+move*share)))
}

// releaseShare mixes linear release with a U-shaped rate that is strongest at
// the start and end of the day. The cumulative share reaches one at UTC close.
func releaseShare(u float64) float64 {
	u = min(1, max(0, u))
	x := 2*u - 1
	return (3*u + x*x*x + 1) / 5
}

func flowImbalance(net, volume float64) float64 {
	if volume <= 0 {
		return 0
	}
	return min(1, max(-1, net/volume))
}

func roundPrice(price float64) float64 {
	return math.Round(price*100) / 100
}

// Quote presents a symbol's executable coin prices and the user's position.
type Quote struct {
	Symbol      string  `json:"symbol"`
	Label       string  `json:"label"`
	BasePrice   float64 `json:"base_price"`
	Mid         float64 `json:"mid"`
	Buy         int64   `json:"buy"`
	Sell        int64   `json:"sell"`
	Change      float64 `json:"change"`
	TodayNet    float64 `json:"today_net"`
	TodayVolume float64 `json:"today_volume"`
	Imbalance   float64 `json:"imbalance"`
	Position    int64   `json:"position"`
	AvgCost     float64 `json:"avg_cost"`
}

// QuoteFromMid rounds the spread outward to whole coins.
func QuoteFromMid(meta SymbolMeta, mid, prevClose, net, volume float64, cfg Config) Quote {
	sell := max(1, int64(math.Floor(mid*(1-cfg.Spread/2))))
	buy := max(sell+1, int64(math.Ceil(mid*(1+cfg.Spread/2))))
	change := 0.0
	if prevClose > 0 {
		change = (mid - prevClose) / prevClose
	}
	return Quote{
		Symbol: meta.ID, Label: meta.Label, BasePrice: meta.BasePrice, Mid: mid,
		Buy: buy, Sell: sell, Change: change, TodayNet: net, TodayVolume: volume, Imbalance: flowImbalance(net, volume),
	}
}

// Candle is one grain on the chart, timestamped at its UTC opening time.
type Candle struct {
	TsMs    int64   `json:"ts_ms"`
	Open    float64 `json:"open"`
	High    float64 `json:"high"`
	Low     float64 `json:"low"`
	Close   float64 `json:"close"`
	Volume  float64 `json:"volume"`
	Settled bool    `json:"settled"`
	Running bool    `json:"running"`
}

// BuildCandles synthesizes at most thirty UTC days of grains, including today.
// History is expected to contain one symbol with the newest rows last.
func BuildCandles(symbol string, history []DayCandle, today BucketState, grainMinutes int, now time.Time, cfg Config) []Candle {
	meta, ok := GetSymbol(symbol)
	if !ok {
		return nil
	}
	switch grainMinutes {
	case 15, 30, 60, 120:
	default:
		grainMinutes = 60
	}
	dayIndex := UTCDayIndex(now)
	grainSlots := grainMinutes / binMinutes
	currentSlot := UTCBinSlot(now)
	var recent [chartDays]DayCandle
	days := recent[:0]
	for _, day := range history[max(0, len(history)-chartDays):] {
		if day.DayIndex < dayIndex {
			days = append(days, day)
		}
	}
	slices.SortFunc(days, func(a, b DayCandle) int { return cmp.Compare(a.DayIndex, b.DayIndex) })
	days = days[max(0, len(days)-(chartDays-1)):]
	candles := make([]Candle, 0, len(days)*binsPerDay/grainSlots+currentSlot/grainSlots+1)
	prevClose := meta.BasePrice
	for _, day := range days {
		candles = appendSettledCandles(candles, day, grainSlots)
		prevClose = day.Close
	}
	if today.DayIndex != dayIndex {
		today = BucketState{DayIndex: dayIndex}
	}
	return appendLiveCandles(candles, meta, today, prevClose, grainSlots, currentSlot, cfg)
}

func appendSettledCandles(dst []Candle, day DayCandle, grainSlots int) []Candle {
	// The path reaches both daily extremes, visiting the counter-trend extreme first.
	// Its pivots fall on grain boundaries at every supported resolution.
	first, second := day.Low, day.High
	if day.Close < day.Open {
		first, second = day.High, day.Low
	}
	points := [4]float64{day.Open, first, second, day.Close}
	priceAt := func(slot int) float64 {
		segment := min(2, slot/(binsPerDay/3))
		progress := float64(slot-segment*(binsPerDay/3)) / (binsPerDay / 3)
		return points[segment] + (points[segment+1]-points[segment])*progress
	}
	open := day.Open
	for start := 0; start < binsPerDay; start += grainSlots {
		end := start + grainSlots
		closePrice := priceAt(end)
		if end == binsPerDay {
			closePrice = day.Close
		}
		share := releaseShare(float64(end)/binsPerDay) - releaseShare(float64(start)/binsPerDay)
		dst = append(dst, Candle{
			TsMs: candleTime(day.DayIndex, start), Open: open, High: max(open, closePrice), Low: min(open, closePrice), Close: closePrice,
			Volume: day.Volume * share, Settled: true,
		})
		open = closePrice
	}
	return dst
}

func appendLiveCandles(dst []Candle, meta SymbolMeta, today BucketState, prevClose float64, grainSlots, currentSlot int, cfg Config) []Candle {
	var bins [binsPerDay]BucketBin
	for _, bin := range today.Bins {
		if bin.BinSlot >= 0 && bin.BinSlot <= currentSlot {
			bins[bin.BinSlot].Net += bin.Net
			bins[bin.BinSlot].Volume += bin.Volume
		}
	}
	open := max(1, prevClose)
	var totalNet, totalVolume float64
	for start := 0; start <= currentSlot; start += grainSlots {
		end := min(start+grainSlots, currentSlot+1)
		var net, volume float64
		for _, bin := range bins[start:end] {
			net += bin.Net
			volume += bin.Volume
		}
		if len(today.Bins) == 0 {
			fraction := float64(end-start) / float64(currentSlot+1)
			net, volume = today.Net*fraction, today.Volume*fraction
		}
		totalNet, totalVolume = totalNet+net, totalVolume+volume
		running := end == currentSlot+1
		if running {
			// Use the bucket totals for the live close even if some bins are missing.
			totalNet, totalVolume = today.Net, today.Volume
		}
		closePrice := livePrice(meta, prevClose, totalNet, totalVolume, end, cfg)
		high, low := barWicks(open, closePrice, volume, flowImbalance(net, volume), cfg)
		dst = append(dst, Candle{
			TsMs: candleTime(today.DayIndex, start), Open: open, High: high, Low: low, Close: closePrice,
			Volume: volume, Running: running,
		})
		open = closePrice
	}
	return dst
}

func candleTime(dayIndex, slot int) int64 {
	return int64(dayIndex)*secondsPerDay*1000 + int64(slot)*binMinutes*60*1000
}
