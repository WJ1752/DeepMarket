import {
  DEPTH_VISUALS,
  WATER_HEIGHT,
  WATER_WIDTH,
  drawBlocks,
  drawLine,
  drawPolygon,
  randomFrom,
  safeContext2D,
  type DepthId,
  type Point2D,
} from './palettes';

const SHORE_OUTLINE: readonly Point2D[] = [
  [0, 0], [158, 0], [164, 12], [151, 21], [163, 33], [152, 41], [153, 57],
  [132, 66], [127, 81], [111, 89], [108, 104], [95, 114], [99, 129], [82, 138],
  [78, 148], [65, 155], [65, 175], [50, 186], [51, 202], [39, 217], [47, 232],
  [40, 254], [0, 254],
];

const UPLANDS_OUTLINE: readonly Point2D[] = [
  [0, 0], [123, 0], [132, 12], [114, 25], [121, 34], [108, 50], [106, 61],
  [83, 72], [85, 86], [72, 94], [74, 113], [54, 126], [52, 154], [39, 169],
  [37, 186], [28, 203], [32, 221], [24, 234], [25, 254], [0, 254],
];

const HILL_OUTLINE: readonly Point2D[] = [
  [0, 0], [91, 0], [103, 10], [76, 26], [81, 45], [65, 69],
  [46, 77], [45, 95], [31, 103], [31, 127], [21, 148], [22, 170], [0, 176],
];

const HILL_LIGHT_OUTLINE: readonly Point2D[] = [
  [31, 2], [82, 2], [68, 15], [53, 16], [47, 39], [27, 44],
  [16, 63], [12, 79], [0, 84], [0, 47], [18, 30],
];

const SPIT_OUTLINE: readonly Point2D[] = [
  [0, 140], [32, 153], [40, 160], [84, 193], [80, 198], [47, 182], [20, 174], [0, 168],
];

const NEAR_WATER_OUTLINE: readonly Point2D[] = [
  [0, 0], [232, 0], [222, 16], [232, 36], [204, 49], [211, 62], [180, 79], [183, 103],
  [148, 119], [153, 142], [135, 156], [139, 183], [114, 194], [118, 223], [107, 254], [0, 254],
];

const SHALLOW_WATER_OUTLINE: readonly Point2D[] = [
  [0, 0], [189, 0], [180, 20], [192, 36], [171, 52], [178, 70], [149, 86], [143, 102],
  [121, 119], [127, 135], [108, 157], [101, 167], [105, 186], [85, 200], [91, 223], [78, 254], [0, 254],
];

const COAST_ROCKS: readonly (readonly [number, number, number])[] = [
  [139, 4, 0.73], [150, 27, 0.76], [122, 45, 0.88], [142, 51, 0.5], [94, 69, 1.13],
  [133, 79, 0.57], [83, 99, 0.65], [103, 101, 0.45], [78, 127, 0.62], [68, 153, 0.43],
  [55, 197, 0.68], [33, 213, 0.75], [47, 233, 0.4], [21, 236, 0.6], [195, 65, 0.64],
  [210, 70, 0.34], [188, 88, 0.36], [25, 83, 0.6], [15, 109, 0.47], [113, 15, 0.47],
];

const SHORE_FOAM_SPOTS: readonly Point2D[] = [
  [169, 14], [170, 34], [159, 63], [141, 69], [125, 101], [117, 125], [104, 134],
  [85, 154], [72, 179], [65, 193], [58, 209], [59, 229], [50, 245], [208, 69],
];

const PIER_POSTS: readonly Point2D[] = [
  [10, 195], [54, 195], [94, 195], [132, 195], [172, 195], [217, 195], [245, 195],
  [224, 164], [246, 164], [213, 140], [244, 140], [285, 140], [286, 153],
];

const WATER_FLECKS = ['#66a18c43', '#7fb4a153', '#184b473f', '#b0c9a543', '#224c4538', '#81ad905e'] as const;
const LAND_TONES = ['#4552477c', '#bdb6806c', '#d1ba8260', '#43583b6b', '#384a3966'] as const;
const PLANK_TONES = ['#8d7551', '#aa8e61', '#907b54', '#b09061', '#a48558', '#917651'] as const;

function drawRock(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, bright = false): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  drawPolygon(ctx, '#274f49', [[-1, 5], [5, 1], [16, 1], [27, 8], [30, 16], [18, 22], [3, 20], [-4, 16]]);
  drawPolygon(ctx, bright ? '#806e58' : '#596555', [[-1, 7], [5, 3], [9, -2], [17, -3], [25, 3], [27, 10], [19, 16], [4, 16], [-3, 12]]);
  drawPolygon(ctx, bright ? '#a28a69' : '#7b8065', [[3, 5], [10, -2], [17, -3], [24, 3], [20, 8], [10, 9], [6, 12], [-1, 10]]);
  drawPolygon(ctx, '#404f45', [[21, 8], [27, 9], [25, 14], [19, 17], [8, 16], [11, 12], [15, 12]]);
  drawLine(ctx, bright ? '#baa27f' : '#9a9877', [[5, 4], [10, 0], [16, 0], [19, 2]], 0.9);
  drawBlocks(ctx, '#626752', [[5, 12, 4, 1], [13, 3, 2, 1], [18, 5, 3, 1]]);
  ctx.restore();
}

function drawTuft(ctx: CanvasRenderingContext2D, x: number, y: number, variant: boolean): void {
  drawBlocks(ctx, '#364739', [[x - 2, y, 8, 3], [x, y - 4, 4, 6], [x + 5, y - 2, 2, 4]]);
  drawBlocks(ctx, variant ? '#75845a' : '#606c4b', [[x, y - 3, 2, 3], [x + 4, y - 2, 2, 3], [x - 1, y, 4, 1]]);
}

function drawPost(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  drawPolygon(ctx, '#152f2b80', [[x - 1, y], [x + 4, y - 2], [x + 11, y + 5], [x + 5, y + 8], [x, y + 6]]);
  drawBlocks(ctx, '#3b3b2d', [[x - 1, y - 6, 5, 10]]);
  drawBlocks(ctx, '#a78d62', [[x - 2, y - 8, 6, 3], [x - 2, y - 4, 1, 5]]);
  drawBlocks(ctx, '#ccab71', [[x - 1, y - 7, 4, 1]]);
}

function drawBox(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  drawBlocks(ctx, '#3b3a2d90', [[x + 3, y + 5, 17, 12]]);
  drawBlocks(ctx, '#67513a', [[x, y + 2, 16, 12]]);
  drawBlocks(ctx, '#ad8a55', [[x, y, 15, 9]]);
  drawBlocks(ctx, '#857049', [[x + 1, y + 2, 13, 1], [x + 1, y + 6, 13, 1]]);
  drawBlocks(ctx, '#d7ad69', [[x + 1, y + 1, 13, 1], [x + 1, y + 7, 13, 1]]);
}

function drawDeckSegment(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  vertical: boolean,
  salt: number,
): void {
  const rand = randomFrom(salt);
  drawBlocks(ctx, '#163a34a0', [[left + 6, top + 7, width, height + 4]]);
  drawBlocks(ctx, '#544835', [[left, top + 1, width, height + 4]]);
  const count = vertical ? height : width;
  for (let i = 1; i < count - 1; i += 6) {
    const tone = PLANK_TONES[Math.floor(rand() * PLANK_TONES.length)];
    const length = Math.min(5, count - i - 1);
    if (vertical) {
      drawBlocks(ctx, tone, [[left + 1, top + i, width - 2, length]]);
      drawBlocks(ctx, '#cfb18565', [[left + 2, top + i, width - 4, 1]]);
      drawBlocks(ctx, '#584c365a', [[left + 3 + Math.floor(rand() * (width - 13)), top + i + 2, 6, 1]]);
    } else {
      drawBlocks(ctx, tone, [[left + i, top + 1, length, height - 2]]);
      drawBlocks(ctx, '#e8c78b4f', [[left + i, top + 3, 1, height - 6]]);
      drawBlocks(ctx, '#513f325a', [[left + i + 2, top + 4 + Math.floor(rand() * (height - 11)), 1, 5]]);
    }
  }
  if (vertical) {
    drawBlocks(ctx, '#bc9a65', [[left, top + 1, 2, height - 2], [left + width - 2, top + 1, 2, height - 2]]);
  } else {
    drawBlocks(ctx, '#bc9a65', [[left + 1, top, width - 2, 2], [left + 1, top + height - 3, width - 2, 2]]);
  }
}

function drawShed(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  drawPolygon(ctx, '#243e2e85', [[0, 6], [47, 6], [54, 46], [40, 53], [-5, 53], [-5, 32]]);
  drawBlocks(ctx, '#544b37', [[4, 21, 40, 27]]);
  drawBlocks(ctx, '#b0895b', [[7, 23, 35, 22]]);
  for (let i = 0; i < 5; i += 1) {
    drawBlocks(ctx, '#896c4c', [[8, 25 + i * 4, 33, 1]]);
  }
  drawBlocks(ctx, '#594935', [[12, 29, 12, 16], [31, 27, 8, 9]]);
  drawBlocks(ctx, '#dac27c', [[32, 28, 6, 7]]);
  drawBlocks(ctx, '#f2d994', [[33, 29, 2, 3]]);
  drawPolygon(ctx, '#4b4432', [[-1, 25], [13, -3], [40, -3], [53, 25], [51, 28], [-1, 28]]);
  drawPolygon(ctx, '#934d3f', [[1, 23], [14, -4], [40, -4], [51, 23], [46, 25], [1, 25]]);
  drawPolygon(ctx, '#b4684d', [[15, -5], [37, -5], [28, 23], [2, 23]]);
  for (let i = 0; i < 6; i += 1) {
    drawLine(ctx, '#713f3680', [[13 - i * 2, i * 4], [41 + i * 2, i * 4]]);
  }
  drawLine(ctx, '#d38a63', [[0, 24], [48, 24], [51, 22]]);
  drawBlocks(ctx, '#756455', [[30, -12, 7, 13], [29, -13, 9, 3]]);
  drawBlocks(ctx, '#4d4c43', [[31, -13, 6, 2]]);
  drawBlocks(ctx, '#be9c64', [[9, 45, 19, 3], [7, 48, 23, 2]]);
  ctx.restore();
}

function drawMooredBoat(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  drawPolygon(ctx, '#326d63', [[-7, 11], [9, 3], [46, 1], [68, 8], [52, 22], [15, 23], [0, 17]]);
  drawPolygon(ctx, '#234d43', [[-1, 7], [10, -1], [46, -1], [63, 8], [49, 19], [13, 20], [1, 16]]);
  drawPolygon(ctx, '#bfac73', [[0, 5], [10, -4], [45, -4], [60, 5], [47, 16], [12, 17], [1, 12]]);
  drawPolygon(ctx, '#987a50', [[5, 5], [13, -1], [43, -1], [55, 5], [45, 13], [13, 14], [5, 10]]);
  drawPolygon(ctx, '#d7c38d', [[14, -1], [18, 1], [17, 13], [13, 14]]);
  drawPolygon(ctx, '#b25e46', [[36, -1], [44, 0], [47, 12], [40, 14], [34, 12]]);
  drawBlocks(ctx, '#5a5741', [[24, 4, 8, 7], [10, 4, 4, 4]]);
  drawLine(ctx, '#e4cc92', [[2, 10], [11, 15], [47, 14], [58, 6]]);
  drawLine(ctx, '#2d4940', [[8, 6], [0, 15], [-11, 22]]);
  drawBlocks(ctx, '#7f7352', [[-11, 20, 3, 5]]);
  ctx.restore();
}

function drawBeacon(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  drawBlocks(ctx, '#17323c', [[x - 5, y + 5, 14, 3], [x - 2, y - 11, 6, 15]]);
  drawBlocks(ctx, '#d39068', [[x - 2, y - 8, 5, 8]]);
  drawBlocks(ctx, '#a54538', [[x - 4, y - 12, 9, 3], [x - 5, y + 1, 11, 4]]);
  drawBlocks(ctx, '#f2d8a0', [[x - 1, y - 9, 3, 3]]);
  drawLine(ctx, '#a6c1a270', [[x - 12, y + 8], [x - 5, y + 10], [x + 8, y + 10], [x + 13, y + 8]]);
}

function drawReeds(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  drawBlocks(ctx, '#345b46', [[x - 3, y, 11, 2], [x, y - 7, 1, 8], [x + 4, y - 10, 1, 11], [x + 7, y - 6, 1, 7]]);
  drawBlocks(ctx, '#b4aa74', [[x, y - 9, 2, 4], [x + 4, y - 11, 2, 4], [x + 7, y - 7, 2, 3]]);
}

function drawHabitat(ctx: CanvasRenderingContext2D, depthId: DepthId, rand: () => number): void {
  if (depthId === 'shore') {
    drawPolygon(ctx, '#759378', [[252, 101], [275, 81], [299, 84], [316, 72], [349, 80], [363, 96], [337, 107], [300, 103], [275, 112]]);
    drawPolygon(ctx, '#999e73', [[267, 99], [282, 89], [301, 92], [317, 80], [344, 88], [349, 96], [330, 101], [303, 98], [280, 105]]);
    for (const [x, y] of [[276, 97], [288, 89], [317, 85], [330, 93], [344, 98]] as const) {
      drawReeds(ctx, x, y);
    }
    drawPolygon(ctx, '#87936d', [[285, 207], [306, 192], [324, 195], [338, 185], [359, 194], [356, 208], [396, 220], [434, 254], [282, 254], [298, 236]]);
    drawPolygon(ctx, '#a7a47a', [[290, 254], [305, 233], [294, 216], [313, 202], [332, 204], [345, 196], [350, 209], [378, 217], [401, 236], [427, 254]]);
    for (const [x, y] of [[303, 230], [309, 218], [326, 203], [345, 200], [370, 225], [398, 242], [317, 248], [305, 245]] as const) {
      drawReeds(ctx, x, y);
    }
    drawMooredBoat(ctx, 418, 74);
  } else if (depthId === 'shelf') {
    drawMooredBoat(ctx, 338, 68);
    drawMooredBoat(ctx, 154, 217);
  } else if (depthId === 'open') {
    const openRocks: readonly (readonly [number, number, number])[] = [
      [293, 84, 0.9], [308, 65, 1.45], [348, 72, 0.9], [336, 91, 0.6], [319, 101, 0.75],
      [390, 67, 1.1], [413, 77, 0.75], [459, 206, 1.35], [480, 195, 0.8], [436, 224, 0.93],
    ];
    for (const [x, y, size] of openRocks) {
      drawRock(ctx, x, y, size, true);
    }
    drawBeacon(ctx, 344, 69);
    drawLine(ctx, '#c1cfb38c', [[279, 105], [309, 118], [347, 111], [384, 90], [420, 94]]);
  } else if (depthId === 'deep') {
    drawPolygon(ctx, '#516a71', [[405, 0], [432, 21], [414, 53], [420, 82], [397, 109], [405, 137], [384, 186], [380, 254], [568, 254], [568, 0]]);
    drawPolygon(ctx, '#263c51', [[426, 0], [450, 26], [433, 57], [438, 84], [419, 114], [424, 141], [404, 191], [404, 254], [568, 254], [568, 0]]);
    drawLine(ctx, '#78918b', [[405, 0], [432, 21], [414, 53], [420, 82], [397, 109], [405, 137], [384, 186], [380, 254]]);
    drawBeacon(ctx, 393, 205);
    drawMooredBoat(ctx, 303, 71);
  } else if (depthId === 'rift') {
    const fracture: readonly Point2D[] = [
      [299, 0], [321, 32], [286, 63], [316, 80], [369, 85], [382, 111],
      [428, 121], [441, 153], [487, 172], [458, 207], [500, 254],
    ];
    drawLine(ctx, '#687485', fracture, 19);
    drawLine(ctx, '#272b3d', fracture, 13);
    drawLine(ctx, '#9293a785', fracture.map(([x, y]) => [x - 7, y + 1] as const), 1.4);
    drawBeacon(ctx, 346, 102);
  } else if (depthId === 'abyss') {
    drawPolygon(ctx, '#42625d', [[260, 36], [302, 6], [380, 16], [420, 57], [407, 111], [351, 140], [291, 115], [267, 92]]);
    drawPolygon(ctx, '#152c34', [[270, 39], [308, 15], [374, 26], [407, 61], [394, 105], [349, 129], [296, 107], [276, 83]]);
    drawPolygon(ctx, '#101e2b', [[287, 47], [314, 29], [368, 40], [391, 63], [381, 95], [344, 114], [308, 98], [289, 80]]);
    for (let i = 0; i < 36; i += 1) {
      const x = Math.floor(287 + rand() * 149);
      const y = Math.floor(30 + rand() * 99);
      drawBlocks(ctx, i % 3 ? '#6b9b9480' : '#a3cbb5', [[x, y, 2, 1]]);
    }
    drawBeacon(ctx, 308, 217);
    drawBeacon(ctx, 424, 103);
  }
}

export function createSeaBase(depthId: DepthId): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = WATER_WIDTH;
  canvas.height = WATER_HEIGHT;
  const ctx = safeContext2D(canvas);
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = false;

  const visual = DEPTH_VISUALS[depthId] ?? DEPTH_VISUALS.shore;
  const [sea, deepWater, farWater, nearWater, shallowWater] = visual.water;
  const { reach, shore } = visual.coast;
  const [surfColor, sandColor, coastColor, uplandColor, hillColor, hillLight] = shore;
  const [flow, slope] = visual.wave;
  const rand = randomFrom(47323 + Math.round(reach * 1000));

  const coastPath = (points: readonly Point2D[], offset = 0): Point2D[] =>
    points.map(([x, y]) => [x === 0 ? 0 : Math.round(x * reach) + offset, y] as const);

  drawBlocks(ctx, sea, [[0, 0, WATER_WIDTH, WATER_HEIGHT]]);
  drawPolygon(ctx, deepWater, [[271, 0], [568, 0], [568, 254], [351, 254], [347, 238], [310, 216], [314, 185], [282, 175], [291, 152], [259, 121], [269, 95], [236, 71], [243, 45], [229, 30]]);
  drawPolygon(ctx, farWater, [[480, 0], [568, 0], [568, 254], [410, 254], [428, 235], [438, 211], [421, 194], [439, 175], [435, 145], [458, 113], [446, 94], [482, 73], [469, 44]]);
  drawPolygon(ctx, nearWater, coastPath(NEAR_WATER_OUTLINE, 8));
  drawPolygon(ctx, shallowWater, coastPath(SHALLOW_WATER_OUTLINE, 4));

  for (let i = 0; i < 1240; i += 1) {
    const y = Math.floor(rand() * WATER_HEIGHT);
    const x = Math.floor(rand() * WATER_WIDTH);
    const width = rand() < 0.14 ? Math.floor(8 + rand() * 11) : Math.floor(1 + rand() * 4);
    drawBlocks(ctx, WATER_FLECKS[Math.floor(rand() * WATER_FLECKS.length)], [[x, y, width, 1]]);
  }

  for (let i = 0; i < 98; i += 1) {
    const x = Math.floor(rand() * WATER_WIDTH);
    const y = Math.floor(5 + rand() * (WATER_HEIGHT - 8));
    const width = Math.floor(7 + rand() * 23);
    const pale = x < 240 ? '#a7b99971' : '#8cb2a168';
    const drift = Math.round(slope * width);
    const end = flow > 0 ? x + width + 2 : x - 5;
    if (x > 248 && x < 392 && y > 120 && y < 190) continue;
    drawLine(ctx, pale, [[x, y], [x + width, y + drift]], 0.8);
    drawBlocks(ctx, pale, [[end, y + (flow > 0 ? drift : 0) + 1, Math.ceil(width / 4), 1]]);
    if (i % 4 === 0) {
      drawLine(ctx, '#143f3b65', [[x - 2, y + 3], [x + width + 1, y + drift + 3]]);
    }
  }

  drawPolygon(ctx, surfColor, coastPath(SHORE_OUTLINE, 11));
  drawPolygon(ctx, sandColor, coastPath(SHORE_OUTLINE, 4));
  drawPolygon(ctx, coastColor, coastPath(SHORE_OUTLINE));
  drawPolygon(ctx, uplandColor, coastPath(UPLANDS_OUTLINE));
  drawPolygon(ctx, hillColor, coastPath(HILL_OUTLINE));
  drawPolygon(ctx, hillLight, coastPath(HILL_LIGHT_OUTLINE));
  drawPolygon(ctx, coastColor, coastPath(SPIT_OUTLINE));

  for (let i = 0; i < 480; i += 1) {
    const y = Math.floor(rand() * WATER_HEIGHT);
    const x = Math.floor(rand() * Math.max(28, 117 - y * 0.41) * reach);
    drawBlocks(ctx, LAND_TONES[i % LAND_TONES.length], [[x, y, i % 6 ? 1 : 4, i % 7 ? 1 : 2]]);
  }

  for (let i = 0; i < 65; i += 1) {
    const y = Math.floor(rand() * WATER_HEIGHT);
    drawTuft(ctx, Math.floor(rand() * Math.max(22, 90 - y * 0.32) * reach), y, i % 3 === 0);
  }

  for (const [x, y, size] of COAST_ROCKS) {
    drawRock(ctx, Math.round(x * reach), y, size, x < 157 && y % 2 === 1);
  }

  for (const [x, y] of SHORE_FOAM_SPOTS) {
    const shoreX = Math.round(x * reach);
    drawBlocks(ctx, '#aec3a371', [[shoreX, y, 7, 1], [shoreX + 5, y + 2, 6, 1], [shoreX - 5, y + 4, 4, 1]]);
  }

  drawHabitat(ctx, depthId, rand);

  drawDeckSegment(ctx, 0, 173, 245, 26, false, 892);
  drawDeckSegment(ctx, 221, 139, 27, 61, true, 7908);
  drawDeckSegment(ctx, 210, 137, 79, 19, false, 77548);
  drawDeckSegment(ctx, 56, 144, 34, 44, true, 795);

  drawShed(ctx, 42, 111);
  drawBox(ctx, 101, 169);
  drawBox(ctx, 124, 172);
  drawBox(ctx, 192, 175);
  drawBox(ctx, 214, 158);

  for (const [x, y] of PIER_POSTS) {
    drawPost(ctx, x, y);
  }

  drawLine(ctx, '#c1a774a0', [[10, 191], [30, 195], [54, 191], [74, 195], [94, 191], [112, 194], [132, 191]]);
  drawLine(ctx, '#cfb583ad', [[172, 192], [194, 196], [217, 192]]);
  drawBlocks(ctx, '#b78452', [[154, 174, 8, 11], [148, 175, 5, 8]]);
  drawBlocks(ctx, '#5b694f', [[154, 177, 8, 2], [155, 181, 7, 1], [148, 177, 5, 2]]);
  drawBlocks(ctx, '#dac485', [[155, 174, 6, 2], [149, 175, 3, 1]]);

  return canvas;
}

const baseCache = new Map<DepthId, HTMLCanvasElement>();

export function getSeaBase(depthId: DepthId): HTMLCanvasElement | null {
  const cached = baseCache.get(depthId);
  if (cached) return cached;
  const created = createSeaBase(depthId);
  if (created) {
    baseCache.set(depthId, created);
  }
  return created;
}
