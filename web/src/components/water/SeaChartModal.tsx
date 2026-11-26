import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Compass, X } from 'lucide-react';
import { SPECIES_NAMES, TRAIT_LABELS } from '../../api/presentation';
import {
  CHART_HEIGHT,
  CHART_PALETTE,
  CHART_SOUNDINGS,
  CHART_WIDTH,
  DEPTH_LIST,
  DEPTH_META,
  DEPTH_VISUALS,
  drawBlocks,
  drawLine,
  drawPolygon,
  randomFrom,
  safeContext2D,
  type DepthId,
  type Point2D,
} from './palettes';

export interface SeaChartModalProps {
  open: boolean;
  activeDepthId: DepthId;
  locked: boolean;
  onSelectDepth: (depthId: DepthId) => void;
  onClose: () => void;
}

const CHART_COAST: readonly Point2D[] = [
  [127, 0], [130, 20], [101, 41], [111, 64], [87, 71], [85, 96], [59, 117],
  [56, 142], [60, 169], [42, 195], [46, 215], [30, 237], [31, 259], [46, 280],
];

const CHART_DEEP_TRENCH: readonly Point2D[] = [
  [492, 0], [CHART_WIDTH, 0], [CHART_WIDTH, CHART_HEIGHT], [375, CHART_HEIGHT],
  [350, 246], [375, 206], [414, 171], [418, 138], [453, 99], [474, 52],
];

function drawSeaChart(
  ctx: CanvasRenderingContext2D,
  activeDepthId: DepthId,
  inspectedId: DepthId,
): void {
  const rand = randomFrom(554034);
  ctx.imageSmoothingEnabled = false;

  drawBlocks(ctx, CHART_PALETTE.water, [[0, 0, CHART_WIDTH, CHART_HEIGHT]]);
  drawPolygon(ctx, CHART_PALETTE.deep, CHART_DEEP_TRENCH);
  drawPolygon(ctx, CHART_PALETTE.land, [[0, 0], ...CHART_COAST, [0, CHART_HEIGHT]]);

  for (let i = 0; i < 1900; i += 1) {
    drawBlocks(ctx, i % 3 ? CHART_PALETTE.fleck : CHART_PALETTE.highlight, [
      [Math.floor(rand() * CHART_WIDTH), Math.floor(rand() * CHART_HEIGHT), rand() * 3 + 1, 1],
    ]);
  }

  for (let i = 1; i < 12; i += 1) {
    drawLine(ctx, CHART_PALETTE.grid, [[i * 48, 0], [i * 48, CHART_HEIGHT]], 0.75);
  }
  for (let i = 1; i < 7; i += 1) {
    drawLine(ctx, CHART_PALETTE.grid, [[0, i * 42], [CHART_WIDTH, i * 42]], 0.75);
  }

  ctx.save();
  for (let i = 1; i <= 10; i += 1) {
    const contour: Point2D[] = CHART_COAST.map(([x, y], row) => [
      x + i * 43 + Math.sin(i * 0.64 + y * 0.024) * (11 + i * 1.2),
      y + (row % 2) * 3,
    ]);
    ctx.globalAlpha = i % 3 === 0 ? 0.64 : 0.34;
    drawLine(ctx, CHART_PALETTE.contour, contour, i % 3 === 0 ? 1.1 : 0.8);
  }
  ctx.restore();

  drawLine(ctx, CHART_PALETTE.coast, CHART_COAST, 1.65);

  const waypoints = DEPTH_LIST.map((depth) => {
    const [xPct, yPct] = DEPTH_VISUALS[depth.id].chartPoint;
    return {
      id: depth.id,
      xy: [(xPct * CHART_WIDTH) / 100, (yPct * CHART_HEIGHT) / 100] as const,
    };
  });

  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 1; i < waypoints.length; i += 1) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    const [prevX, prevY] = prev.xy;
    const [x, y] = curr.xy;
    const path: readonly Point2D[] = [
      [prevX, prevY],
      [prevX * 0.38 + x * 0.62, prevY * 0.66 + y * 0.34 + 8],
      [x, y],
    ];
    const isHighlighted =
      curr.id === inspectedId
      || prev.id === inspectedId
      || curr.id === activeDepthId;

    drawLine(ctx, CHART_PALETTE.water, path, 4.5);
    drawLine(
      ctx,
      isHighlighted ? CHART_PALETTE.routeActive : CHART_PALETTE.routeOpen,
      path,
      isHighlighted ? 2.4 : 1.9,
    );
  }
  ctx.restore();

  ctx.font = '10px monospace';
  ctx.fillStyle = CHART_PALETTE.ink;
  ctx.fillText('N', 32, 25);
  drawPolygon(ctx, CHART_PALETTE.ink, [[35, 29], [41, 49], [35, 45], [29, 49]]);

  for (const [x, y, depthM] of CHART_SOUNDINGS) {
    ctx.fillText(String(depthM), x, y);
  }
}

export function SeaChartModal({
  open,
  activeDepthId,
  locked,
  onSelectDepth,
  onClose,
}: SeaChartModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const titleId = useId();
  const [inspectedId, setInspectedId] = useState<DepthId>(activeDepthId);

  useEffect(() => {
    if (open) {
      setInspectedId(activeDepthId);
    }
  }, [open, activeDepthId]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      try {
        dialog.showModal?.();
      } catch {
        // Fallback for environments without full dialog modal support.
      }
    }

    return () => {
      if (dialog.open) {
        try {
          dialog.close?.();
        } catch {
          // Ignore close errors during teardown.
        }
      }
      previousFocus?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !dialogRef.current?.open) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const ctx = safeContext2D(canvasRef.current);
    if (!ctx) return;
    drawSeaChart(ctx, activeDepthId, inspectedId);
  }, [open, activeDepthId, inspectedId]);

  if (!open) return null;

  const inspectedMeta = DEPTH_META[inspectedId] ?? DEPTH_META.shore;
  const inspectedVisual = DEPTH_VISUALS[inspectedId] ?? DEPTH_VISUALS.shore;
  const isCurrent = inspectedId === activeDepthId;
  const confirmDisabled = locked || isCurrent;

  return (
    <dialog
      ref={dialogRef}
      className="water-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="water-dialog-body">
        <header className="water-dialog-header">
          <div className="water-dialog-title">
            <Compass size={18} aria-hidden="true" />
            <div>
              <p className="eyebrow">BATHYMETRIC SEA CHART</p>
              <h2 id={titleId}>DeepMarket 深海海图与海域航线</h2>
            </div>
          </div>
          <button
            type="button"
            className="button button-quiet water-dialog-close"
            onClick={onClose}
            aria-label="关闭海图"
          >
            <X size={16} aria-hidden="true" />
            <span>关闭</span>
          </button>
        </header>

        <div className="water-atlas-layout">
          <div className="water-chart" role="group" aria-label="海图站点">
            <canvas ref={canvasRef} width={CHART_WIDTH} height={CHART_HEIGHT} aria-hidden="true" />
            {DEPTH_LIST.map((depth) => {
              const [xPct, yPct] = DEPTH_VISUALS[depth.id].chartPoint;
              const current = depth.id === activeDepthId;
              return (
                <button
                  key={depth.id}
                  type="button"
                  className="water-chart-stop"
                  style={{ '--map-x': `${xPct}%`, '--map-y': `${yPct}%` } as React.CSSProperties}
                  aria-pressed={depth.id === inspectedId}
                  aria-current={current ? 'location' : undefined}
                  data-current={current}
                  onClick={() => setInspectedId(depth.id)}
                >
                  <strong>{depth.name}</strong>
                  <small>T{depth.tier} · {depth.pressure}×</small>
                </button>
              );
            })}
            <div className="water-chart-key" aria-label="航线图例">
              <span data-route="open">全海域开放直达</span>
              <span data-route="active">当前选中航线</span>
            </div>
          </div>

          <aside className="water-atlas-sheet" aria-label="海域详情">
            <header>
              <div>
                <span className="water-atlas-tier">T{inspectedMeta.tier}</span>
                <h3>{inspectedMeta.name}</h3>
              </div>
              <span className="water-atlas-status" data-current={isCurrent}>
                {isCurrent ? '当前海域' : '全海域已开放'}
              </span>
            </header>

            <p className="water-atlas-condition">{inspectedVisual.conditionLabel}</p>
            <p className="water-atlas-desc">{inspectedMeta.description}</p>

            <dl className="water-atlas-metrics">
              <div>
                <dt>水压系数</dt>
                <dd className="mono">{inspectedMeta.pressure}×</dd>
              </div>
              <div>
                <dt>收益倍率</dt>
                <dd className="mono">{inspectedMeta.value.toFixed(1)}×</dd>
              </div>
              <div>
                <dt>词条数量</dt>
                <dd className="mono">{inspectedMeta.traitCount[0]}–{inspectedMeta.traitCount[1]} 词条</dd>
              </div>
            </dl>

            <div className="water-atlas-group">
              <h4>出现词条</h4>
              <div className="water-atlas-chips">
                {inspectedMeta.traits.map((trait) => (
                  <span key={trait} className="water-atlas-chip">
                    {TRAIT_LABELS[trait] ?? trait}
                  </span>
                ))}
              </div>
            </div>

            <div className="water-atlas-group">
              <h4>常见鱼种</h4>
              <div className="water-atlas-chips">
                {inspectedMeta.species.map((species) => (
                  <span key={species} className="water-atlas-chip water-atlas-chip--species">
                    {SPECIES_NAMES[species] ?? species}
                  </span>
                ))}
              </div>
            </div>

            <div className="water-atlas-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={confirmDisabled}
                onClick={() => {
                  onSelectDepth(inspectedId);
                  onClose();
                }}
              >
                {isCurrent ? '当前所在海域' : '切换至此海域'}
              </button>
              {locked && (
                <small className="water-atlas-hint">垂钓进行中，停竿后可切换海域</small>
              )}
            </div>
          </aside>
        </div>
      </div>
    </dialog>
  );
}
