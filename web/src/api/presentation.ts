import type { AffixType } from './types';

export const TRAIT_LABELS: Readonly<Record<string, string>> = {
  swift: '迅游',
  armored: '重甲',
  luminous: '辉光',
  heavy: '巨型',
  ancient: '远古',
  surge: '深涌',
  abyssal: '渊印',
  prismatic: '棱彩',
};

export const TIER_LABELS: Readonly<Record<string, string>> = {
  normal: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
};

export const ROD_NAMES: Readonly<Record<string, string>> = {
  tide: '潮汐钓竿',
  azure: '蔚蓝钓竿',
  abyss: '深渊钓竿',
  shadow: '暗影钓竿',
};

// Guild inventory sends species IDs without localized names.
export const SPECIES_NAMES: Readonly<Record<string, string>> = {
  jack: '银鳞鲹',
  bream: '暮光鲷',
  tuna: '蓝脊鲔',
  marlin: '星痕旗鱼',
  grouper: '玄甲石斑',
  eel: '虹膜鳗',
  lantern: '深渊灯笼鱼',
  spear: '苍白矛吻鱼',
  ray: '渊影鳐',
  angler: '熔核鮟鱇',
  jelly: '静海幽灵水母',
};

export const AFFIX_LABELS: Readonly<Record<AffixType, string>> = {
  speed: '蓄力速度',
  technique: '控线技巧',
  rarity: '稀有加成',
  material: '材料掉率',
  size: '体型加成',
  doubleCatch: '双倍渔获',
};

export interface AffixMeta {
  id: AffixType;
  label: string;
  description: string;
}

export const AFFIX_META: Readonly<Record<AffixType, AffixMeta>> = {
  speed: {
    id: 'speed',
    label: AFFIX_LABELS.speed,
    description: '提升每秒蓄力速率，缩短上鱼时间',
  },
  technique: {
    id: 'technique',
    label: AFFIX_LABELS.technique,
    description: '提高鱼线张力上限并增强抗压减损',
  },
  rarity: {
    id: 'rarity',
    label: AFFIX_LABELS.rarity,
    description: '提高高稀有度鱼种权重与品质晋升概率',
  },
  material: {
    id: 'material',
    label: AFFIX_LABELS.material,
    description: '提高收获时额外掉落锻造材料的概率',
  },
  size: {
    id: 'size',
    label: AFFIX_LABELS.size,
    description: '放大渔获单尾重量，提升公会收购估价',
  },
  doubleCatch: {
    id: 'doubleCatch',
    label: AFFIX_LABELS.doubleCatch,
    description: '起竿时概率直接收获双倍渔获（上限 75%）',
  },
};

export function formatAffixValue(type: string, value: number): string {
  const pct = Math.round(value * 100);
  const sign = pct > 0 ? '+' : '';
  if (type === 'doubleCatch') return `${pct}% 概率`;
  return `${sign}${pct}%`;
}

export type DepthId = 'shore' | 'shelf' | 'open' | 'deep' | 'rift' | 'abyss';

export interface DepthMeta {
  id: DepthId;
  tier: number;
  name: string;
  pressure: number;
  value: number;
  traitCount: readonly [number, number];
  traits: readonly string[];
  species: readonly string[];
  description: string;
}

export const DEPTH_LIST: readonly DepthMeta[] = [
  {
    id: 'shore',
    tier: 1,
    name: '近岸',
    pressure: 1.22,
    value: 1.0,
    traitCount: [1, 2],
    traits: ['swift', 'armored', 'luminous'],
    species: ['jack', 'bream', 'tuna', 'marlin'],
    description: '水流平稳的近海浅滩，适合热身与积累基础渔获（全海域无解锁限制）。',
  },
  {
    id: 'shelf',
    tier: 2,
    name: '陆架',
    pressure: 1.45,
    value: 1.4,
    traitCount: [2, 3],
    traits: ['swift', 'armored', 'luminous', 'heavy'],
    species: ['bream', 'tuna', 'grouper', 'eel'],
    description: '大陆架边缘海流交汇区，开始出现巨型词条鱼群。',
  },
  {
    id: 'open',
    tier: 3,
    name: '外海',
    pressure: 1.79,
    value: 2.1,
    traitCount: [3, 4],
    traits: ['swift', 'armored', 'luminous', 'heavy', 'ancient', 'surge'],
    species: ['tuna', 'grouper', 'eel', 'marlin', 'lantern'],
    description: '开阔深水航道，水压明显增强，远古与深涌词条开始现身。',
  },
  {
    id: 'deep',
    tier: 4,
    name: '深海',
    pressure: 2.29,
    value: 3.3,
    traitCount: [4, 5],
    traits: ['swift', 'armored', 'luminous', 'heavy', 'ancient', 'surge', 'abyssal'],
    species: ['grouper', 'eel', 'marlin', 'lantern', 'spear'],
    description: '日光难以穿透的深水带，高词条密度伴随着渊印生物出没。',
  },
  {
    id: 'rift',
    tier: 5,
    name: '裂谷',
    pressure: 2.32,
    value: 4.2,
    traitCount: [5, 6],
    traits: ['swift', 'armored', 'luminous', 'heavy', 'ancient', 'surge', 'abyssal', 'prismatic'],
    species: ['eel', 'marlin', 'lantern', 'ray', 'angler'],
    description: '海沟地壳裂隙，全 8 种词条皆可出现，包含稀有的棱彩词条。',
  },
  {
    id: 'abyss',
    tier: 6,
    name: '深渊',
    pressure: 2.96,
    value: 5.2,
    traitCount: [5, 6],
    traits: ['swift', 'armored', 'luminous', 'heavy', 'ancient', 'surge', 'abyssal', 'prismatic'],
    species: ['lantern', 'ray', 'spear', 'angler', 'jelly'],
    description: '极端高压的渊底秘境，渊印与棱彩权重最高，静海幽灵水母仅栖息于此。',
  },
];

export const DEPTH_META: Readonly<Record<DepthId, DepthMeta>> = {
  shore: DEPTH_LIST[0],
  shelf: DEPTH_LIST[1],
  open: DEPTH_LIST[2],
  deep: DEPTH_LIST[3],
  rift: DEPTH_LIST[4],
  abyss: DEPTH_LIST[5],
};

export interface MaterialMeta {
  id: string;
  name: string;
  tier: 'common' | 'rare' | 'epic' | 'legendary';
  description: string;
}

export const MATERIAL_LIST: readonly MaterialMeta[] = [
  { id: '浮木纤维', name: '浮木纤维', tier: 'common', description: '海潮冲刷的韧性纤维，用于常规垂钓掉落与基础修补。' },
  { id: '潮汐树脂', name: '潮汐树脂', tier: 'common', description: '沿海贝类分泌的防水胶质，常用于渔具涂层维护。' },
  { id: '深蓝晶片', name: '深蓝晶片', tier: 'rare', description: '维护与升级自动修理系统的核心耗材（每次修补消耗 1 个）。' },
  { id: '渊核碎片', name: '渊核碎片', tier: 'epic', description: '深海热泉凝结的高能结晶，蕴含高压海域矿脉精华。' },
  { id: '旧日合金', name: '旧日合金', tier: 'epic', description: '沉船遗迹打捞的耐蚀金属，高阶海港工艺的珍稀原料。' },
  { id: '潮汐锁钥', name: '潮汐锁钥', tier: 'rare', description: '海域奖厅流通的潮汐信物，可用于高阶海市物资兑换。' },
  { id: '深渊锁钥', name: '深渊锁钥', tier: 'legendary', description: '稀有的深渊密钥，象征海渊探索者的最高通行凭证。' },
];

export const MATERIAL_META: Readonly<Record<string, MaterialMeta>> = Object.fromEntries(
  MATERIAL_LIST.map((item) => [item.id, item]),
);
