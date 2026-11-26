import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react';
import type { FXCandle, FXGrain, FXQuote } from '../api/types';

export interface FxCandleChartProps {
  candles: FXCandle[];
  symbol: string;
  grain: FXGrain;
  label: string;
  quote?: FXQuote;
  loading?: boolean;
  height?: number;
  defaultZoom?: number;
}

type CandleWithOptionalMeta = FXCandle & { projected?: boolean };

const countFmt = new Intl.NumberFormat('zh-CN');
const priceFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});
const signedFmt = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero', maximumFractionDigits: 2 });
const utcFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function FxCandleChart({
  candles,
  symbol,
  grain,
  label,
  quote,
  loading = false,
  height = 240,
  defaultZoom,
}: FxCandleChartProps) {
  const resolvedDefaultZoom = defaultZoom ?? (grain === 15 ? 64 : 48);
  const wrapRef = useRef<HTMLDivElement>(null);
  const readoutId = useId();
  const prevSeriesRef = useRef<{ symbol: string; grain: FXGrain; total: number }>({
    symbol,
    grain,
    total: 0,
  });

  const [view, setView] = useState<{ start: number; count: number }>({ start: 0, count: 0 });
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ x: number; start: number } | null>(null);
  const [keyboardActive, setKeyboardActive] = useState(false);

  const total = candles.length;

  useEffect(() => {
    const prev = prevSeriesRef.current;
    const seriesChanged = prev.symbol !== symbol || prev.grain !== grain || prev.total === 0;

    if (total === 0) {
      setView({ start: 0, count: 0 });
      setHoverTs(null);
      setDrag(null);
    } else if (seriesChanged) {
      const nextCount = Math.max(1, Math.min(total, Math.round(resolvedDefaultZoom)));
      setView({ start: Math.max(0, total - nextCount), count: nextCount });
      setHoverTs(null);
      setDrag(null);
    } else {
      setView((current) => {
        const prevCount = current.count || Math.round(resolvedDefaultZoom);
        const nextCount = Math.max(1, Math.min(total, prevCount));
        const maxStart = Math.max(0, total - nextCount);
        const wasPinnedRight = current.count === 0 || current.start + prevCount >= prev.total - 1;
        const nextStart = wasPinnedRight ? maxStart : Math.round(clamp(current.start, 0, maxStart));
        return { start: nextStart, count: nextCount };
      });
    }

    prevSeriesRef.current = { symbol, grain, total };
  }, [total, symbol, grain, resolvedDefaultZoom]);

  const count = total > 0 ? Math.max(1, Math.min(total, view.count || Math.round(resolvedDefaultZoom))) : 0;
  const start = total > 0 ? Math.round(clamp(view.start, 0, Math.max(0, total - count))) : 0;
  const visible = total > 0 ? candles.slice(start, start + count) : [];
  const empty = visible.length === 0;

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || empty) return undefined;

    const onWheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      if (!rect.width || total <= 1) return;

      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const zoomingOut = event.deltaY > 0;
      const factor = zoomingOut ? 1.25 : 0.8;

      setView((current) => {
        const size = current.count || Math.min(total, Math.round(resolvedDefaultZoom));
        let nextCount = Math.round(clamp(size * factor, 1, total));
        if (zoomingOut && size < total && nextCount <= size) nextCount = Math.min(total, size + 1);
        if (!zoomingOut && size > 1 && nextCount >= size) nextCount = Math.max(1, size - 1);
        const anchor = current.start + Math.round(ratio * size);
        const nextStart = Math.round(clamp(anchor - ratio * nextCount, 0, Math.max(0, total - nextCount)));
        return { start: nextStart, count: nextCount };
      });
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [total, empty, resolvedDefaultZoom]);

  const priceH = Math.max(60, height - 46);
  const max = visible.length ? Math.max(...visible.map((bar) => bar.high)) : 0;
  const min = visible.length ? Math.min(...visible.map((bar) => bar.low)) : 0;
  const padding = max > min ? (max - min) * 0.12 : Math.max(0.02, Math.abs(max) * 0.01);
  const priceMin = Math.max(0, min - padding);
  const priceMax = max + padding;
  const span = Math.max(0.0001, priceMax - priceMin);
  const guideRatios = [1, 0.667, 0.333, 0];
  const priceGuides = guideRatios.map((ratio) => ({
    ratio,
    value: priceMin + span * ratio,
  }));
  const maxVol = Math.max(...visible.map((bar) => bar.volume), 1);
  const yOf = (price: number) => priceH - ((price - priceMin) / span) * (priceH - 10) - 5;
  const slotW = visible.length > 0 ? 100 / visible.length : 100;
  const bodyW = Math.min(8, Math.max(0.45, slotW * 0.62));

  const inspectedIndex = hoverTs != null ? visible.findIndex((bar) => bar.ts_ms === hoverTs) : -1;
  const active: CandleWithOptionalMeta | undefined =
    inspectedIndex >= 0 ? visible[inspectedIndex] : visible[visible.length - 1];
  const inspectionX = inspectedIndex >= 0 ? (inspectedIndex + 0.5) * slotW : null;

  function inspectAt(clientX: number) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect?.width || visible.length === 0) return;
    const index = Math.floor(clamp(((clientX - rect.left) / rect.width) * visible.length, 0, visible.length - 1));
    const bar = visible[index];
    if (bar) setHoverTs(bar.ts_ms);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || empty) return;
    inspectAt(event.clientX);
    setDrag({ x: event.clientX, start });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag) {
      inspectAt(event.clientX);
      return;
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect?.width || count <= 0) return;
    const moved = Math.round(((drag.x - event.clientX) / rect.width) * count);
    if (moved === 0) return;
    setHoverTs(null);
    setView({
      start: Math.round(clamp(drag.start + moved, 0, Math.max(0, total - count))),
      count,
    });
  }

  function releaseDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!direction || visible.length === 0) return;
    event.preventDefault();
    setKeyboardActive(true);
    const currentIndex = inspectedIndex >= 0 ? inspectedIndex : visible.length - 1;
    const nextIndex = Math.round(clamp(currentIndex + direction, 0, visible.length - 1));
    const nextBar = visible[nextIndex];
    if (nextBar) setHoverTs(nextBar.ts_ms);
  }

  function resetView() {
    if (total === 0) return;
    const nextCount = Math.max(1, Math.min(total, Math.round(resolvedDefaultZoom)));
    setHoverTs(null);
    setView({ start: Math.max(0, total - nextCount), count: nextCount });
  }

  function panBy(direction: -1 | 1) {
    if (total === 0) return;
    const step = Math.max(1, Math.floor(count / 4));
    setHoverTs(null);
    setView({
      start: Math.round(clamp(start + direction * step, 0, Math.max(0, total - count))),
      count,
    });
  }

  function zoomBy(factor: number) {
    if (total === 0) return;
    let nextCount = Math.round(clamp(count * factor, 1, total));
    if (factor > 1 && count < total && nextCount <= count) nextCount = Math.min(total, count + 1);
    if (factor < 1 && count > 1 && nextCount >= count) nextCount = Math.max(1, count - 1);
    setHoverTs(null);
    setView({
      count: nextCount,
      start: Math.round(clamp(start + count - nextCount, 0, Math.max(0, total - nextCount))),
    });
  }

  if (empty) {
    return (
      <div className="economy-empty fx-chart-empty" role="status">
        {loading ? '正在读取 K 线…' : '暂无 K 线数据。'}
      </div>
    );
  }

  const activeMove = active && active.open > 0 ? active.close / active.open - 1 : 0;
  const activeStatus = active?.projected
    ? '推演'
    : active?.running
      ? '进行中'
      : active?.settled
        ? '已结算'
        : '日内已收';

  return (
    <div className={cn('fx-chart-shell', loading && 'is-loading')}>
      <div className="fx-chart-toolbar">
        <div className="fx-chart-controls" role="group" aria-label="K 线图平移与缩放">
          <button
            className="fx-option fx-chart-btn"
            type="button"
            onClick={() => panBy(-1)}
            disabled={start <= 0}
            aria-label="查看更早行情"
            title="查看更早行情"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            className="fx-option fx-chart-btn"
            type="button"
            onClick={() => panBy(1)}
            disabled={start + count >= total}
            aria-label="查看较新行情"
            title="查看较新行情"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <button
            className="fx-option fx-chart-btn"
            type="button"
            onClick={() => zoomBy(0.72)}
            disabled={count <= 1}
            aria-label="放大图表"
            title="放大图表"
          >
            <Plus size={15} aria-hidden="true" />
          </button>
          <button
            className="fx-option fx-chart-btn"
            type="button"
            onClick={() => zoomBy(1.4)}
            disabled={count >= total}
            aria-label="缩小图表"
            title="缩小图表"
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <button
            className="fx-option fx-chart-btn"
            type="button"
            onClick={resetView}
            aria-label="重置视图"
            title="重置视图"
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="fx-chart-toolbar-meta">
          {loading && <span className="fx-k-loading-badge" aria-live="polite">刷新中…</span>}
          <span className="fx-chart-hint">Alt+滚轮缩放 · 拖动平移 · 双击重置</span>
        </div>
      </div>

      <div className="fx-k-plot">
        <div
          ref={wrapRef}
          className={cn('fx-k-wrap', Boolean(drag) && 'is-dragging')}
          role="group"
          tabIndex={0}
          aria-label={`${label} K 线图，使用左右方向键查看价格，Alt+滚轮缩放，拖动平移，双击重置`}
          aria-describedby={readoutId}
          onKeyDown={handleKeyDown}
          onBlur={() => setKeyboardActive(false)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={releaseDrag}
          onPointerCancel={releaseDrag}
          onPointerLeave={() => {
            if (!drag) setHoverTs(null);
          }}
          onDoubleClick={resetView}
        >
          <svg
            className="fx-k"
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {priceGuides.map((guide) => {
              const y = yOf(guide.value);
              return (
                <line
                  key={guide.ratio}
                  x1="0"
                  x2="100"
                  y1={y}
                  y2={y}
                  className="fx-k-grid"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            <line
              x1="0"
              x2="100"
              y1={height - 27}
              y2={height - 27}
              className="fx-k-grid"
              vectorEffect="non-scaling-stroke"
            />
            {inspectionX !== null && (
              <line
                x1={inspectionX}
                x2={inspectionX}
                y1="0"
                y2={height}
                className="fx-k-inspection"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {visible.map((bar: CandleWithOptionalMeta, index) => {
              const center = (index + 0.5) * slotW;
              const direction = bar.close > bar.open ? 'is-up' : bar.close < bar.open ? 'is-down' : 'is-flat';
              const bodyTop = yOf(Math.max(bar.open, bar.close));
              const bodyBottom = yOf(Math.min(bar.open, bar.close));
              const bodyH = Math.max(0.8, bodyBottom - bodyTop);
              const volH = bar.volume > 0 ? Math.max(0.8, (bar.volume / maxVol) * 23) : 0;
              const isActive = inspectedIndex === index;

              return (
                <g
                  key={bar.ts_ms}
                  className={cn(
                    'fx-k-candle',
                    direction,
                    isActive && 'is-active',
                    bar.running && 'is-running',
                    bar.projected === true && 'is-projected',
                  )}
                >
                  <line
                    x1={center}
                    x2={center}
                    y1={yOf(bar.high)}
                    y2={yOf(bar.low)}
                    className="fx-k-wick"
                    vectorEffect="non-scaling-stroke"
                  />
                  <rect
                    x={center - bodyW / 2}
                    y={bodyTop}
                    width={bodyW}
                    height={bodyH}
                    className="fx-k-body"
                    vectorEffect="non-scaling-stroke"
                  />
                  {volH > 0 && (
                    <rect
                      x={center - bodyW / 2}
                      y={height - volH}
                      width={bodyW}
                      height={volH}
                      className="fx-k-vol"
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        <div className="fx-k-ruler" aria-hidden="true">
          {priceGuides.map((guide) => (
            <span
              key={guide.ratio}
              style={{ '--fx-guide-y': `${(yOf(guide.value) / height) * 100}%` } as CSSProperties}
            >
              {priceFmt.format(guide.value)}
            </span>
          ))}
        </div>
      </div>

      <div className="fx-k-time-range" aria-hidden="true">
        <span>{utcFmt.format(visible[0].ts_ms)} UTC</span>
        {visible.length > 1 && <span>{utcFmt.format(visible[visible.length - 1].ts_ms)} UTC</span>}
      </div>

      {active && (
        <div
          className="fx-k-readout"
          id={readoutId}
          aria-live={keyboardActive ? 'polite' : 'off'}
          aria-atomic={keyboardActive || undefined}
        >
          <strong>{utcFmt.format(active.ts_ms)} UTC</strong>
          <span>开 <b>{priceFmt.format(active.open)}</b></span>
          <span>高 <b className="fx-positive">{priceFmt.format(active.high)}</b></span>
          <span>低 <b className="fx-negative">{priceFmt.format(active.low)}</b></span>
          <span>收 <b>{priceFmt.format(active.close)}</b></span>
          <span className={cn('fx-k-chg', activeMove > 0 ? 'fx-positive' : activeMove < 0 ? 'fx-negative' : 'economy-muted')}>
            {pctFmt.format(activeMove)}
          </span>
          <span>量 <b>{countFmt.format(Math.round(active.volume))}</b></span>
          <span className={cn('fx-k-status', active.running && 'is-running')}>{activeStatus}</span>
          {quote && (
            <span className="fx-k-quote-meta">
              今日净流 {signedFmt.format(quote.today_net)} · 失衡 {pctFmt.format(quote.imbalance)}
            </span>
          )}
          <span className="fx-k-zoom">{visible.length} / {total} 根</span>
        </div>
      )}
    </div>
  );
}
