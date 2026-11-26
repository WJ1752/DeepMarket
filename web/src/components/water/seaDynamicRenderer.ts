import {
  BOBBER_X,
  BOBBER_Y,
  DEPTH_VISUALS,
  FISHER_X,
  FISHER_Y,
  ROD_TIP_ACTIVE_Y,
  ROD_TIP_IDLE_Y,
  ROD_TIP_X,
  drawBlocks,
  drawLine,
  drawPolygon,
  randomFrom,
  type DepthId,
  type Point2D,
} from './palettes';

export type TensionLevel = 'safe' | 'warning' | 'critical';
export type WaterEventKind = 'bite' | 'catch' | 'escape' | 'legendary';

export interface WaterVisualEvent {
  id: string;
  kind: WaterEventKind;
  startedAtMs: number;
  fishName?: string;
  tier?: string;
  quantity?: number;
}

export interface SeaVisualState {
  depthId: DepthId;
  running: boolean;
  reeling: boolean;
  recovering: boolean;
  tension: number;
  tensionLevel: TensionLevel;
  eventKind: WaterEventKind | null;
  eventAgeMs: number;
  reducedMotion: boolean;
}

export interface BobberCoords {
  x: number;
  y: number;
  dip: number;
}

const FOAM_BITS = Array.from({ length: 44 }, (_, index) => {
  const rand = randomFrom(1798 + index * 47);
  return {
    x: 103 + rand() * 450,
    y: 14 + rand() * 227,
    size: 3 + rand() * 12,
    phase: rand() * 55,
  };
});

export function computeBobberPosition(
  timeSec: number,
  visual: Pick<SeaVisualState, 'running' | 'reeling' | 'tensionLevel' | 'reducedMotion'>,
): BobberCoords {
  const dip = visual.reeling ? (visual.tensionLevel === 'critical' ? 4 : 2) : 0;
  const t = visual.reducedMotion ? 0 : timeSec;
  const x = BOBBER_X + (visual.running ? Math.round(Math.sin(t * 1.35) * 2) : 0);
  const ampY = visual.reeling ? 3 : visual.running ? 2 : 1;
  const freqY = visual.reeling ? 2.8 : 2.1;
  const y = BOBBER_Y + dip + Math.round(Math.sin(t * freqY) * ampY);
  return { x, y, dip };
}

function drawFisher(
  ctx: CanvasRenderingContext2D,
  running: boolean,
  reeling: boolean,
  tensionLevel: TensionLevel,
): Point2D {
  const x = FISHER_X;
  const y = FISHER_Y;

  drawBlocks(ctx, '#353c30a0', [[x - 5, y + 5, 18, 5], [x - 2, y + 9, 20, 3]]);
  drawBlocks(ctx, '#333f36', [[x - 3, y, 6, 8], [x + 3, y + 1, 5, 9], [x - 5, y + 7, 8, 3], [x + 4, y + 8, 7, 3]]);
  drawBlocks(ctx, '#8a633e', [[x - 5, y - 10, 11, 15], [x + 3, y - 9, 6, 11], [x + 6, y - 8, 8, 4]]);
  drawBlocks(ctx, '#cd9e58', [[x - 4, y - 9, 9, 12], [x + 2, y - 8, 4, 10], [x + 5, y - 6, 8, 3]]);
  drawBlocks(ctx, '#ead091', [[x - 4, y - 9, 4, 9], [x + 6, y - 6, 6, 1]]);
  drawBlocks(ctx, '#7e4939', [[x - 3, y - 17, 11, 8], [x - 5, y - 13, 16, 2]]);
  drawBlocks(ctx, '#d57d53', [[x - 1, y - 18, 8, 5], [x + 6, y - 14, 6, 2]]);
  drawBlocks(ctx, '#d6ae80', [[x + 5, y - 12, 4, 5], [x + 13, y - 6, 3, 3]]);

  const flexX = reeling ? (tensionLevel === 'critical' ? 3 : 2) : 0;
  const flexY = reeling ? (tensionLevel === 'critical' ? 3 : 1) : 0;
  const tipX = ROD_TIP_X + flexX;
  const tipY = (running ? ROD_TIP_ACTIVE_Y : ROD_TIP_IDLE_Y) + flexY;

  drawLine(ctx, '#643e2e', [[x + 9, y - 2], [x + 16, y - 7], [tipX, tipY]], 2);
  drawLine(ctx, '#edd099', [[x + 13, y - 6], [x + 21, y - 9], [tipX + 1, tipY + 1]]);
  return [tipX, tipY] as const;
}

function drawOutcomeSplash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: 'catch' | 'escape' | 'legendary',
  progress: number,
): void {
  if (progress >= 1) return;

  const isLegendary = kind === 'legendary';
  const isEscape = kind === 'escape';
  const colors = isLegendary
    ? (['#ffe6a1', '#efcb80', '#b89af5', '#62dcc1'] as const)
    : isEscape
      ? (['#ff958e', '#efcb80', '#e5eac2'] as const)
      : (['#b8fff0', '#62dcc1', '#70cce1'] as const);

  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - progress);

  for (let i = 0; i < 3; i += 1) {
    ctx.strokeStyle = colors[i % colors.length];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(
      x,
      y + 2,
      4 + (i + 1) * (isLegendary ? 15 : 12) * progress,
      1 + (i + 1) * 2.4 * progress,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }

  const count = isLegendary ? 22 : isEscape ? 14 : 12;
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * i) / (count - 1);
    const dx = Math.cos(angle) * progress * (isLegendary ? 66 : 44);
    const dy = Math.sin(angle) * Math.sin(Math.PI * progress) * (isLegendary ? 46 : 30);
    drawBlocks(ctx, colors[i % colors.length], [[Math.round(x + dx), Math.round(y - dy), i % 3 === 0 ? 2 : 1, i % 5 === 0 ? 3 : 1]]);
  }

  if (!isEscape) {
    const fy = Math.round(y - 12 - 38 * progress);
    drawPolygon(ctx, colors[0], [
      [x - 11, fy - 4],
      [x - 7, fy - 2],
      [x - 3, fy - 5],
      [x + 4, fy - 5],
      [x + 8, fy - 2],
      [x + 10, fy],
      [x + 7, fy + 2],
      [x - 3, fy + 3],
      [x - 7, fy + 1],
      [x - 11, fy + 4],
    ]);
    drawBlocks(ctx, '#1b3035', [[x + 5, fy - 2, 1, 1]]);
  }

  ctx.restore();
}

export function drawSea(
  ctx: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  timeMs: number,
  visual: SeaVisualState,
): BobberCoords {
  const depthVisual = DEPTH_VISUALS[visual.depthId] ?? DEPTH_VISUALS.shore;
  const [flow, slope] = depthVisual.wave;
  const t = visual.reducedMotion ? 0 : timeMs / 1000;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0);

  for (const bit of FOAM_BITS) {
    if (bit.y > 132 && bit.y < 201 && bit.x < 297) continue;
    if (bit.y > 120 && bit.y < 190 && bit.x > 247 && bit.x < 394) continue;
    const x = Math.round(bit.x + Math.sin(t / 1.8 - bit.phase) * 4 * flow);
    const y = Math.round(bit.y);
    const alpha = 0.13 + (0.5 + Math.sin(t * 0.66 + bit.phase) / 2) * 0.28;
    const drift = Math.round(bit.size * slope);
    const color = `rgba(172, 194, 161, ${alpha.toFixed(3)})`;
    drawLine(ctx, color, [[x, y], [x + bit.size, y + drift]], 0.8);
    if (bit.size > 11) {
      drawBlocks(ctx, color, [[flow > 0 ? x + Math.round(bit.size) + 3 : x - 5, y + (flow > 0 ? drift : 0) + 1, 3, 1]]);
    }
  }

  const lineStart = drawFisher(ctx, visual.running, visual.reeling, visual.tensionLevel);
  const bob = computeBobberPosition(t, visual);

  const snapped = visual.eventKind === 'escape' && visual.eventAgeMs < 1400;
  const lineEnd: Point2D = snapped ? [bob.x - 12, bob.y - 6] : [bob.x, bob.y];
  const linePath: readonly Point2D[] = visual.reeling && !snapped
    ? [lineStart, lineEnd]
    : [lineStart, [308, 144], [325, 151], [346, 160], lineEnd];

  const lineCoreColor = visual.tensionLevel === 'critical'
    ? '#ff958e'
    : visual.tensionLevel === 'warning'
      ? '#efcb80'
      : visual.reeling
        ? '#f6e1a9'
        : '#e4e3bd';

  drawLine(ctx, '#1b3035bd', linePath, 2.5);
  drawLine(ctx, lineCoreColor, linePath, visual.reeling ? 1.35 : 1.1);

  const outcomeKind = visual.eventKind === 'catch' || visual.eventKind === 'escape' || visual.eventKind === 'legendary'
    ? visual.eventKind
    : null;
  const hasOutcome = outcomeKind !== null;
  ctx.strokeStyle = visual.tensionLevel === 'critical'
    ? '#ff958ecc'
    : visual.eventKind === 'legendary'
      ? '#efcb80d9'
      : visual.reeling
        ? '#70cce1b8'
        : '#d6e4b9ae';
  ctx.lineWidth = 0.9;

  const rings = hasOutcome || visual.eventKind === 'bite' ? [7, 14, 22] : visual.running ? [6, 12] : [7];
  for (let i = 0; i < rings.length; i += 1) {
    const ring = rings[i];
    const shift = Math.sin(t * 2 + i) * (hasOutcome ? 4 : 2);
    ctx.beginPath();
    ctx.ellipse(bob.x, bob.y + 2, Math.max(2, ring + shift), Math.max(1, ring * 0.32), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawBlocks(ctx, '#19332f', [
    [bob.x - 4, bob.y + 2, 9, 2],
    [bob.x - 3, bob.y - 5 + bob.dip, 6, 8 - bob.dip],
  ]);
  drawBlocks(ctx, visual.tensionLevel === 'critical' ? '#ff7b72' : '#c7634a', [
    [bob.x - 2, bob.y - 5 + bob.dip, 4, 7 - bob.dip],
  ]);
  drawBlocks(ctx, '#fce5ab', [
    [bob.x - 2, bob.y - 5 + bob.dip, 4, 2],
    [bob.x + 1, bob.y, 1, 2],
  ]);

  if (outcomeKind && visual.eventAgeMs < 2100) {
    const progress = visual.reducedMotion ? 0.35 : Math.min(1, Math.max(0, visual.eventAgeMs / 2100));
    drawOutcomeSplash(ctx, bob.x, bob.y, outcomeKind, progress);
  }

  return bob;
}
