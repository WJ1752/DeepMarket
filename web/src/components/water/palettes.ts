import { DEPTH_LIST, DEPTH_META, type DepthId } from '../../api/presentation';

export { DEPTH_LIST, DEPTH_META, type DepthId };

export const WATER_WIDTH = 568;
export const WATER_HEIGHT = 254;
export const CHART_WIDTH = 568;
export const CHART_HEIGHT = 280;

export const FISHER_X = 259;
export const FISHER_Y = 147;
export const BOBBER_X = 369;
export const BOBBER_Y = 169;
export const ROD_TIP_X = 286;
export const ROD_TIP_IDLE_Y = 141;
export const ROD_TIP_ACTIVE_Y = 136;

export type Point2D = readonly [number, number];
export type RectTuple = readonly [number, number, number, number];

export interface DepthVisualConfig {
  id: DepthId;
  water: readonly [sea: string, deepWater: string, farWater: string, nearWater: string, shallowWater: string];
  coast: {
    reach: number;
    shore: readonly [surf: string, sand: string, coast: string, upland: string, hill: string, hillLight: string];
  };
  wave: readonly [flow: 1 | -1, slope: number];
  chartPoint: readonly [xPct: number, yPct: number];
  conditionLabel: string;
  rough: boolean;
  backdrop: string;
}

export const DEPTH_VISUALS: Readonly<Record<DepthId, DepthVisualConfig>> = {
  shore: {
    id: 'shore',
    water: ['#547b66', '#456e5a', '#3a6353', '#6f8a6e', '#839678'],
    coast: {
      reach: 1.12,
      shore: ['#75a18a', '#889374', '#b1a378', '#6e7c56', '#536247', '#82865c'],
    },
    wave: [1, 0],
    chartPoint: [15, 58],
    conditionLabel: '近岸浅滩 · 平稳',
    rough: false,
    backdrop: '#29635c',
  },
  shelf: {
    id: 'shelf',
    water: ['#30675f', '#265950', '#214d48', '#3c7468', '#50836f'],
    coast: {
      reach: 1,
      shore: ['#549180', '#71816a', '#ad9d72', '#6c7654', '#505f42', '#7f8057'],
    },
    wave: [1, -0.04],
    chartPoint: [29, 32],
    conditionLabel: '陆架海流 · 轻浪',
    rough: false,
    backdrop: '#214d48',
  },
  open: {
    id: 'open',
    water: ['#426a6a', '#355a60', '#2b4c57', '#4b7775', '#608582'],
    coast: {
      reach: 0.92,
      shore: ['#729b91', '#738a7f', '#a59d7e', '#676d58', '#4d594d', '#7d7e65'],
    },
    wave: [1, 0.16],
    chartPoint: [43, 67],
    conditionLabel: '开阔航道 · 有风浪',
    rough: true,
    backdrop: '#2b4c57',
  },
  deep: {
    id: 'deep',
    water: ['#375965', '#284350', '#203443', '#3f666d', '#527979'],
    coast: {
      reach: 0.72,
      shore: ['#698889', '#6f7c72', '#9a967d', '#606553', '#48574e', '#73775e'],
    },
    wave: [-1, 0.14],
    chartPoint: [56, 41],
    conditionLabel: '深水高压 · 涌浪',
    rough: true,
    backdrop: '#203443',
  },
  rift: {
    id: 'rift',
    water: ['#49566a', '#373f54', '#2a2f42', '#525e70', '#636d78'],
    coast: {
      reach: 0.63,
      shore: ['#737f94', '#727a80', '#89857c', '#64665d', '#4f5351', '#747569'],
    },
    wave: [1, -0.2],
    chartPoint: [70, 72],
    conditionLabel: '裂谷海沟 · 险浪',
    rough: true,
    backdrop: '#2a2f42',
  },
  abyss: {
    id: 'abyss',
    water: ['#293e43', '#1e3036', '#16252d', '#354d50', '#465c5a'],
    coast: {
      reach: 0.55,
      shore: ['#536d6a', '#64766d', '#797f6a', '#555e51', '#3c4e47', '#656e5a'],
    },
    wave: [-1, -0.12],
    chartPoint: [85, 42],
    conditionLabel: '渊底秘境 · 极端高压',
    rough: true,
    backdrop: '#16252d',
  },
};

export const CHART_PALETTE = {
  water: '#0c1f27',
  deep: '#07141b',
  land: '#182c32',
  coast: '#55878a',
  grid: '#21404c66',
  ink: '#9ab1bc',
  contour: '#305e6a',
  fleck: '#4d8c9630',
  highlight: '#62dcc126',
  routeOpen: '#62dcc1',
  routeActive: '#efcb80',
} as const;

export const CHART_SOUNDINGS: readonly (readonly [number, number, number])[] = [
  [65, 91, 3],
  [94, 210, 5],
  [176, 126, 12],
  [218, 219, 18],
  [252, 61, 23],
  [343, 159, 31],
  [446, 159, 41],
  [496, 216, 48],
  [337, 239, 37],
  [531, 77, 65],
];

export function randomFrom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

export function safeContext2D(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  if (!canvas) return null;
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

export function drawPolygon(ctx: CanvasRenderingContext2D, fill: string, points: readonly Point2D[]): void {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

export function drawLine(ctx: CanvasRenderingContext2D, color: string, points: readonly Point2D[], width = 1): void {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

export function drawBlocks(ctx: CanvasRenderingContext2D, color: string, rectangles: readonly RectTuple[]): void {
  ctx.fillStyle = color;
  for (const [x, y, w, h] of rectangles) {
    ctx.fillRect(x, y, w, h);
  }
}
