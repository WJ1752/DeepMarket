import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Anchor,
  ArrowUp,
  Compass,
  Fish,
  Layers,
  Play,
  Radio,
  ShieldAlert,
  Sparkles,
  Square,
  Unlink,
  Wrench,
} from 'lucide-react';
import { sessionApi } from '../api/client';
import {
  AFFIX_META,
  DEPTH_LIST,
  DEPTH_META,
  ROD_NAMES,
  TIER_LABELS,
  TRAIT_LABELS,
  formatAffixValue,
  type DepthId,
} from '../api/presentation';
import type {
  Affix,
  AffixType,
  EquipmentInstance,
  FishingStartResponse,
  FishingStateResponse,
  FishingStopResponse,
  GuildInventoryResponse,
  PublicPlayer,
  SSEEnvelope,
} from '../api/types';
import DeepSeaCanvas, { type DeepSeaCanvasCatchEvent } from './DeepSeaCanvas';
import { SeaChartModal } from './water/SeaChartModal';
import './fishing.css';

// Base rod parameters mirror server/internal/fishing/formula.go.
const ROD_TEMPLATES: Record<string, {
  energy: number;
  maxRate: number;
  maxTension: number;
  resistance: number;
  breakable: boolean;
}> = {
  tide: { energy: 1000, maxRate: 87.5, maxTension: 1200, resistance: 0.08, breakable: false },
  azure: { energy: 2000, maxRate: 134, maxTension: 1380, resistance: 0.18, breakable: true },
  abyss: { energy: 2000, maxRate: 82, maxTension: 1450, resistance: 0.33, breakable: true },
  shadow: { energy: 2300, maxRate: 82, maxTension: 1450, resistance: 0.36, breakable: true },
};

const REPAIR_MATERIAL = '深蓝晶片';
const RECOVERY_MS = 5000;
const BASE_CHARGE = 10000;
const AUTO_REPAIR_RESTORE = Math.round(50 * 0.9);
const UPGRADE_COIN_COST = 100;

const formatInteger = new Intl.NumberFormat('zh-CN');
const formatTimestamp = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export type FishingDeckProps = {
  fishing: FishingStateResponse | null;
  inventory: GuildInventoryResponse | null;
  events: SSEEnvelope[];
  globalLegendary: SSEEnvelope<'catch'> | null;
  lastCatchEvent: SSEEnvelope<'catch' | 'escape'> | null;
  onFishingCommand: (res: FishingStartResponse | FishingStopResponse) => void;
  onPlayerUpdate: (player: PublicPlayer, extra?: { rod?: EquipmentInstance; autoRepairLevel?: number }) => void;
};

type Result = Extract<SSEEnvelope, { event: 'catch' | 'escape' }>;
type Action = 'start' | 'stop' | 'repair' | 'upgrade';
type Feedback = { action: Action; text: string; error: boolean };
type TensionMeterLevel = 'safe' | 'warn' | 'danger';

interface AggregatedBonuses {
  speed: number;
  technique: number;
  rarity: number;
  material: number;
  size: number;
  doubleCatch: number;
}

function unitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatWeight(weightGrams: number): string {
  return weightGrams >= 1000
    ? `${(weightGrams / 1000).toFixed(2)} kg`
    : `${Math.round(weightGrams)} g`;
}

function durabilityFactor(ratio: number): number {
  if (ratio >= 0.8) return 1.2;
  if (ratio >= 0.6) return 1 + (ratio - 0.6);
  if (ratio >= 0.2) return 0.8 + (ratio - 0.2) * 0.5;
  return 0.8;
}

function aggregateRodAffixes(affixes: Affix[] | null | undefined): AggregatedBonuses {
  const bonuses: AggregatedBonuses = {
    speed: 0,
    technique: 0,
    rarity: 0,
    material: 0,
    size: 0,
    doubleCatch: 0,
  };

  for (const affix of affixes ?? []) {
    if (!Number.isFinite(affix.value)) continue;
    switch (affix.type) {
      case 'speed':
        bonuses.speed += affix.value;
        break;
      case 'technique':
        bonuses.technique += affix.value;
        break;
      case 'rarity':
        bonuses.rarity += affix.value;
        break;
      case 'material':
        bonuses.material += affix.value;
        break;
      case 'size':
        bonuses.size += affix.value;
        break;
      case 'doubleCatch':
        bonuses.doubleCatch += affix.value;
        break;
      default:
        break;
    }
  }

  bonuses.doubleCatch = Math.min(0.75, Math.max(0, bonuses.doubleCatch));
  return bonuses;
}

function computeRodStats(rod: EquipmentInstance | null | undefined) {
  const template = ROD_TEMPLATES[rod?.template_id ?? 'tide'] ?? ROD_TEMPLATES.tide;
  const bonuses = aggregateRodAffixes(rod?.affixes);
  const ratio = rod ? unitInterval(rod.durability / Math.max(1, rod.max_durability)) : 1;
  const durFactor = durabilityFactor(ratio);

  const effectiveEnergy = template.energy * Math.max(0.1, 1 + bonuses.speed);
  const effectiveMaxTension = Math.max(
    1,
    Math.round(template.maxTension * durFactor) * (1 + bonuses.technique),
  );
  const effectiveResistance = Math.min(
    0.95,
    Math.max(0, template.resistance + Math.min(0.25, bonuses.technique * 0.2)),
  );

  return {
    template,
    bonuses,
    ratio,
    effectiveEnergy,
    effectiveMaxTension,
    effectiveResistance,
  };
}

function projectMeters(snapshot: FishingStateResponse | null, elapsedMs: number): {
  charge: number;
  tension: number;
  recovering: boolean;
  tensionLevel: TensionMeterLevel;
} {
  if (!snapshot) {
    return { charge: 0, tension: 0, recovering: false, tensionLevel: 'safe' };
  }

  const { fishing, rod, running } = snapshot;
  const stats = computeRodStats(rod);
  const bite = fishing.bite;
  const required = Math.max(1, bite?.charge_required || BASE_CHARGE);
  const tensionLimit = Math.max(1, bite?.max_tension || stats.effectiveMaxTension);
  const serverNow = fishing.last_tick_at_ms + elapsedMs;
  const recovering = running && fishing.recover_until_ms > serverNow;

  let charge = fishing.progress;
  let tension = fishing.tension;

  if (running && fishing.recover_until_ms > 0) {
    tension = fishing.recover_from * unitInterval((fishing.recover_until_ms - serverNow) / RECOVERY_MS);
  } else if (running && bite && rod) {
    const chargePerSecond = Math.max(1, stats.effectiveEnergy * (bite.charge_rate || 1));
    const rate = stats.template.maxRate * (bite.tension_rate || 1);
    const delay = Math.max(0, bite.tension_delay_ms) / 1000;
    const chargeSeconds = Math.max(0.001, Math.max(0, required - bite.charge_at_bite) / chargePerSecond);
    const escapeSeconds = delay + (
      tensionLimit <= 0.5 * rate
        ? Math.sqrt((2 * tensionLimit) / rate)
        : tensionLimit / rate + 0.5
    );
    const seconds = Math.min(chargeSeconds, escapeSeconds, Math.max(0, (serverNow - bite.started_at_ms) / 1000));
    const pull = Math.max(0, seconds - delay);
    const ramp = Math.min(pull, 1);

    charge = Math.max(charge, Math.min(required, bite.charge_at_bite + seconds * chargePerSecond));
    tension = Math.max(tension, Math.min(tensionLimit, rate * (0.5 * ramp * ramp + pull - ramp)));
  }

  const displayLimit = running && fishing.recover_until_ms > 0
    ? Math.max(1, fishing.recover_from)
    : tensionLimit;

  const chargeNorm = unitInterval(charge / required);
  const tensionNorm = unitInterval(tension / displayLimit);
  const tensionLevel: TensionMeterLevel = tensionNorm >= 0.75
    ? 'danger'
    : tensionNorm >= 0.45
      ? 'warn'
      : 'safe';

  return {
    charge: chargeNorm,
    tension: tensionNorm,
    recovering,
    tensionLevel,
  };
}

function useFishingMeters(snapshot: FishingStateResponse | null) {
  const [clock, setClock] = useState(0);
  const anchor = useRef({ snapshot, receivedAt: 0 });

  useEffect(() => {
    const receivedAt = performance.now();
    anchor.current = { snapshot, receivedAt };
    setClock(receivedAt);
    if (!snapshot?.running) return undefined;

    const timer = window.setInterval(() => setClock(performance.now()), 50);
    return () => window.clearInterval(timer);
  }, [snapshot]);

  const elapsedMs = anchor.current.snapshot === snapshot
    ? Math.max(0, clock - anchor.current.receivedAt)
    : 0;
  return projectMeters(snapshot, elapsedMs);
}

function Meter({
  label,
  value,
  tone,
  level,
  display,
  threshold,
}: {
  label: string;
  value: number;
  tone: 'charge' | 'tension' | 'durability';
  level?: TensionMeterLevel;
  display?: string;
  threshold?: number;
}) {
  const clamped = unitInterval(value);
  const percent = Math.round(clamped * 100);

  return (
    <div
      className={`fishing-meter fishing-meter--${tone}`}
      data-level={level}
    >
      <div className="fishing-meter-label">
        <span>{label}</span>
        <strong>{display ?? `${percent}%`}</strong>
      </div>
      <div
        className="fishing-meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={display}
      >
        <span className="fishing-meter-fill" style={{ width: `${clamped * 100}%` }} />
        {threshold !== undefined && (
          <span
            className="fishing-meter-threshold"
            style={{ left: `${unitInterval(threshold) * 100}%` }}
            title={`自动修理阈值 ${Math.round(unitInterval(threshold) * 100)}%`}
          />
        )}
      </div>
    </div>
  );
}

function ResultRow({ result }: { result: Result }) {
  const fish = result.payload;
  const escaped = result.event === 'escape';
  const traits = (fish.traits ?? []).map((trait) => TRAIT_LABELS[trait] ?? trait);
  const materialDrops = !escaped && result.event === 'catch'
    ? Object.entries(result.payload.materials ?? {}).filter(([, qty]) => qty > 0)
    : [];

  return (
    <li className="fishing-feed-row">
      <span className={`fishing-feed-icon ${escaped ? 'fishing-feed-icon--escaped' : ''}`}>
        {escaped ? <Unlink size={15} aria-hidden="true" /> : <Fish size={15} aria-hidden="true" />}
      </span>
      <div className="fishing-feed-fish">
        <div className="fishing-feed-title">
          <strong>{fish.name}</strong>
          <span className="fishing-feed-outcome" data-escaped={escaped}>
            {escaped ? '脱钩' : `捕获 ×${result.payload.quantity}`}
          </span>
          <span className="fishing-feed-weight mono">{formatWeight(fish.weight_g)}</span>
        </div>
        {traits.length > 0 && (
          <div className="fishing-feed-traits">
            {traits.slice(0, 4).map((trait) => (
              <span key={trait} className="fishing-trait-pill">{trait}</span>
            ))}
            {traits.length > 4 && (
              <span className="fishing-trait-pill">+{traits.length - 4}</span>
            )}
          </div>
        )}
        {(materialDrops.length > 0 || fish.durability_loss > 0) && (
          <div className="fishing-feed-extras">
            {materialDrops.map(([matName, qty]) => (
              <span key={matName} className="fishing-drop-badge">
                +{qty} {matName}
              </span>
            ))}
            {fish.durability_loss > 0 && (
              <span className="fishing-durability-loss mono">-{fish.durability_loss} 耐久</span>
            )}
          </div>
        )}
      </div>
      <div className="fishing-feed-meta">
        <span className={`fishing-tier fishing-tier--${fish.tier}`}>
          {TIER_LABELS[fish.tier] ?? fish.tier}
        </span>
        <time className="mono" dateTime={new Date(result.ts_ms).toISOString()}>
          {formatTimestamp.format(result.ts_ms)}
        </time>
      </div>
    </li>
  );
}

function ActionFeedback({ feedback }: { feedback: Feedback | undefined }) {
  if (!feedback?.text) return null;
  return (
    <p
      className={feedback.error ? 'inline-error fishing-action-msg' : 'fishing-feedback fishing-action-msg'}
      role={feedback.error ? 'alert' : 'status'}
    >
      {feedback.text}
    </p>
  );
}

export default function FishingDeck({
  fishing,
  inventory,
  events,
  globalLegendary,
  lastCatchEvent,
  onFishingCommand,
  onPlayerUpdate,
}: FishingDeckProps) {
  const state = fishing;
  const coins = fishing?.coins ?? inventory?.player.coins ?? 0;
  const materials = inventory?.materials ?? {};

  const [selectedDepth, setSelectedDepth] = useState<DepthId>();
  const [chartOpen, setChartOpen] = useState(false);
  const [pending, setPending] = useState<Action>();
  const [feedback, setFeedback] = useState<Feedback>();
  const maintenanceFeedback = feedback?.action === 'repair' || feedback?.action === 'upgrade';

  const meters = useFishingMeters(state);
  const rod = state?.rod ?? null;
  const rodStats = useMemo(() => computeRodStats(rod), [rod]);
  const running = state?.running ?? false;
  const reeling = running && state?.fishing.phase === 'reeling';

  const rawDepth = state?.depth_id;
  const serverDepth: DepthId = rawDepth && rawDepth in DEPTH_META ? (rawDepth as DepthId) : 'shore';
  const depth: DepthId = running ? serverDepth : (selectedDepth ?? serverDepth);
  const depthMeta = DEPTH_META[depth];

  const level = state?.fishing.auto_repair_level ?? 0;
  const threshold = level > 0 ? 10 + level * 10 : 10;
  const materialCount = materials[REPAIR_MATERIAL] ?? 0;

  const safeEvents = Array.isArray(events) ? events : [];
  const userResults = useMemo(() => (
    safeEvents
      .filter((event): event is Result => (
        event.channel === 'user' && (event.event === 'catch' || event.event === 'escape')
      ))
      .sort((a, b) => b.ts_ms - a.ts_ms || b.seq - a.seq)
  ), [safeEvents]);

  const latestOutcome = lastCatchEvent ?? userResults[0] ?? null;
  const outcomeId = latestOutcome?.id;
  const outcomeEvent = latestOutcome?.event;
  const outcomeTs = latestOutcome?.ts_ms;
  const outcomeTier = latestOutcome?.payload.tier;
  const outcomeName = latestOutcome?.payload.name;
  const outcomeQuantity = latestOutcome?.event === 'catch' ? latestOutcome.payload.quantity : undefined;

  const canvasCatchEvent = useMemo<DeepSeaCanvasCatchEvent | null>(() => {
    if (!outcomeId || !outcomeEvent || outcomeTs === undefined) return null;
    return {
      id: outcomeId,
      event: outcomeEvent,
      ts_ms: outcomeTs,
      tier: outcomeTier ?? '',
      name: outcomeName ?? '',
      quantity: outcomeQuantity,
    };
  }, [outcomeId, outcomeEvent, outcomeTs, outcomeTier, outcomeName, outcomeQuantity]);

  const legendary = useMemo(() => (
    globalLegendary
    ?? safeEvents
      .filter((event): event is SSEEnvelope<'catch'> => (
        event.channel === 'global'
        && event.event === 'catch'
        && event.payload.tier === 'legendary'
      ))
      .sort((a, b) => b.ts_ms - a.ts_ms || b.seq - a.seq)[0]
    ?? null
  ), [safeEvents, globalLegendary]);

  const status = !state
    ? '读取钓鱼状态'
    : reeling
      ? '收线搏斗中'
      : meters.recovering
        ? '卸力恢复中'
        : running
          ? '等待咬钩'
          : state.fishing.auto_stopped
            ? '鱼竿保护暂停'
            : '码头待命';

  const start = async (depthId: DepthId) => onFishingCommand(await sessionApi.startFishing(depthId));
  const stop = async () => onFishingCommand(await sessionApi.stopFishing());
  const repair = async (rodId: number) => {
    const res = await sessionApi.repairRod(rodId);
    onPlayerUpdate(res.player, { rod: res.rod });
  };
  const upgrade = async () => {
    const res = await sessionApi.upgradeAutoRepair();
    onPlayerUpdate(res.player, { autoRepairLevel: res.auto_repair_level });
  };

  async function act(action: Action, operation: () => Promise<unknown>, message = '') {
    setPending(action);
    setFeedback(undefined);
    try {
      await operation();
      if (message) setFeedback({ action, text: message, error: false });
    } catch (cause) {
      setFeedback({
        action,
        text: cause instanceof Error ? cause.message : '操作失败，请重试。',
        error: true,
      });
    } finally {
      setPending(undefined);
    }
  }

  const latestTraits = (latestOutcome?.payload.traits ?? []).map((t) => TRAIT_LABELS[t] ?? t);
  const biteTraits = (state?.fishing.bite?.fish.traits ?? []).map((t) => TRAIT_LABELS[t] ?? t);
  const rodAffixes = rod?.affixes ?? [];
  const rodBroken = rod !== null && rod.durability <= 0;
  const rodLowStopped = Boolean(state?.fishing.auto_stopped || state?.fishing.low_durability);

  return (
    <section className="fishing-deck" aria-labelledby="fishing-title">
      <div className="fishing-deck-heading">
        <div>
          <p className="eyebrow">FISHING DECK</p>
          <h1 id="fishing-title">深海垂钓</h1>
        </div>
        <span
          className={`fishing-status ${running ? 'fishing-status--running' : ''}`}
          data-recovering={meters.recovering}
        >
          <span aria-hidden="true" />
          {status}
        </span>
      </div>

      {legendary && (
        <aside className="fishing-legendary" aria-label="全海域传说播报">
          <Radio size={17} aria-hidden="true" />
          <span className="fishing-legendary-copy">
            全海域传说渔获
            <strong>{legendary.payload.name}</strong>
            <small className="mono">{formatWeight(legendary.payload.weight_g)}</small>
          </span>
          <span
            className="fishing-signature"
            title={`HMAC-SHA256 服务端签名 ${legendary.sig ?? ''}`}
          >
            HMAC {(legendary.sig ?? '').slice(0, 8)}
          </span>
        </aside>
      )}

      <article className="panel fishing-stage-card">
        <DeepSeaCanvas
          depth={depth}
          running={running}
          reeling={reeling}
          recovering={meters.recovering}
          tension={meters.tension}
          biteFishName={reeling ? state?.fishing.bite?.fish.name : undefined}
          catchEvent={canvasCatchEvent}
          onOpenSeaChart={() => setChartOpen(true)}
        />

        <div className="fishing-console">
          <div className="fishing-console-recent">
            <span className="fishing-console-label">最近回传</span>
            {latestOutcome ? (
              <div className="fishing-recent-body">
                <div className="fishing-recent-head">
                  <strong>{latestOutcome.payload.name}</strong>
                  <span className={`fishing-tier fishing-tier--${latestOutcome.payload.tier}`}>
                    {TIER_LABELS[latestOutcome.payload.tier] ?? latestOutcome.payload.tier}
                  </span>
                </div>
                <div className="fishing-recent-sub">
                  <span data-escaped={latestOutcome.event === 'escape'}>
                    {latestOutcome.event === 'escape'
                      ? '脱钩'
                      : `捕获 ×${latestOutcome.payload.quantity}`}
                  </span>
                  <span className="mono">{formatWeight(latestOutcome.payload.weight_g)}</span>
                </div>
                {latestTraits.length > 0 && (
                  <div className="fishing-recent-traits">
                    {latestTraits.slice(0, 3).map((trait) => (
                      <span key={trait} className="fishing-trait-pill">{trait}</span>
                    ))}
                    {latestTraits.length > 3 && (
                      <span className="fishing-trait-pill">+{latestTraits.length - 3}</span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="fishing-recent-empty">暂无本次航行记录 · 抛竿后实时回传</p>
            )}
          </div>

          <div className="fishing-console-meters">
            <div className="fishing-console-phase">
              <span>
                {reeling && state?.fishing.bite
                  ? `咬钩目标 · ${state.fishing.bite.fish.name}`
                  : meters.recovering
                    ? '张力卸力恢复中（5s）'
                    : running
                      ? `蓄力巡航中 · ${depthMeta.name}`
                      : '甲板就绪 · 选择海域后抛竿'}
              </span>
              {reeling && biteTraits.length > 0 && (
                <small className="fishing-bite-traits">{biteTraits.slice(0, 3).join(' · ')}</small>
              )}
            </div>
            <div className="fishing-meters">
              <Meter label="蓄力进度" tone="charge" value={meters.charge} />
              <Meter
                label="鱼线张力"
                tone="tension"
                value={meters.tension}
                level={meters.tensionLevel}
              />
            </div>
            {!maintenanceFeedback && <ActionFeedback feedback={feedback} />}
          </div>

          <div className="fishing-console-controls">
            <button
              className={`button ${running ? 'button-quiet fishing-stop-btn' : 'button-primary'} fishing-start`}
              type="button"
              disabled={!state || pending !== undefined}
              onClick={() => void (running ? act('stop', stop) : act('start', () => start(depth)))}
            >
              {running ? <Square size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
              {pending === 'start' || pending === 'stop' ? '处理中…' : running ? '停止钓鱼' : '开始钓鱼'}
            </button>
            <button
              type="button"
              className="button button-quiet fishing-chart-btn"
              onClick={() => setChartOpen(true)}
              aria-haspopup="dialog"
            >
              <Compass size={15} aria-hidden="true" />
              <span>海图航线</span>
            </button>
            {running && (
              <small className="fishing-lock-note">航行中锁定当前海域</small>
            )}
          </div>
        </div>
      </article>

      <div className="fishing-layout">
        <div className="fishing-main">
          <article className="panel fishing-depths">
            <div className="fishing-section-head">
              <div className="fishing-section-title">
                <Layers size={16} aria-hidden="true" />
                <h2>海域切换</h2>
              </div>
              <button
                type="button"
                className="button button-quiet fishing-inline-chart-btn"
                onClick={() => setChartOpen(true)}
                aria-haspopup="dialog"
              >
                <Compass size={14} aria-hidden="true" />
                <span>海图总览</span>
              </button>
            </div>
            <fieldset className="fishing-depth-fieldset" disabled={running || pending !== undefined}>
              <legend className="fishing-sr-only">选择海域</legend>
              <div className="fishing-depth-options">
                {DEPTH_LIST.map((option) => {
                  const traitPreview = option.traits
                    .slice(0, 3)
                    .map((trait) => TRAIT_LABELS[trait] ?? trait)
                    .join(' · ');
                  return (
                    <button
                      key={option.id}
                      className="fishing-depth"
                      type="button"
                      aria-pressed={depth === option.id}
                      onClick={() => setSelectedDepth(option.id)}
                    >
                      <span className="fishing-depth-top">
                        <strong>
                          <span className="fishing-depth-tier mono">T{option.tier}</span>
                          {option.name}
                        </strong>
                        <small className="mono">{option.pressure}×</small>
                      </span>
                      <span className="fishing-depth-meta">
                        <small>{option.value.toFixed(1)}× 价值</small>
                        <small>{option.traitCount[0]}–{option.traitCount[1]} 词条</small>
                      </span>
                      <small className="fishing-depth-traits">{traitPreview}</small>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </article>

          <article className="panel fishing-feed">
            <div className="fishing-section-head">
              <div className="fishing-section-title">
                <Fish size={16} aria-hidden="true" />
                <h2>实时渔获</h2>
              </div>
              <span className="fishing-count-badge mono">{userResults.length} 条</span>
            </div>
            {userResults.length > 0 ? (
              <ol className="fishing-feed-list" role="list" aria-live="polite">
                {userResults.slice(0, 12).map((result) => (
                  <ResultRow key={result.id} result={result} />
                ))}
              </ol>
            ) : (
              <p className="empty-state">
                <Fish size={19} aria-hidden="true" />
                渔获与脱钩记录会实时同步到这里。
              </p>
            )}
          </article>
        </div>

        <div className="fishing-side">
          <article className="panel fishing-equipment">
            <div className="fishing-section-head">
              <div className="fishing-section-title">
                <Anchor size={16} aria-hidden="true" />
                <h2>鱼竿与维护</h2>
              </div>
              <span
                className="fishing-rod-badge"
                data-alert={rodBroken || rodLowStopped}
              >
                {rodBroken
                  ? '断线损坏'
                  : rodLowStopped
                    ? '低耐久停竿'
                    : rod
                      ? `强化 +${rod.enhance_level}`
                      : '待配发'}
              </span>
            </div>

            <div className="fishing-rod-identity">
              <strong>
                {rod ? (ROD_NAMES[rod.template_id] ?? rod.template_id) : '首次下竿自动配发潮汐钓竿'}
              </strong>
              {rod && (
                <small className="mono">
                  {rodStats.template.breakable ? '高阶可损毁装备' : '基础不毁钓竿'}
                </small>
              )}
            </div>

            <Meter
              label="当前耐久"
              tone="durability"
              value={rod ? rodStats.ratio : 0}
              display={rod
                ? `${formatInteger.format(rod.durability)} / ${formatInteger.format(rod.max_durability)}`
                : '—'}
              threshold={rod ? threshold / Math.max(1, rod.max_durability) : undefined}
            />
            <p className="fishing-muted">
              {level > 0
                ? `自动修理 Lv.${level} · 阈值 ${threshold} · 每次自动恢复 ${AUTO_REPAIR_RESTORE}`
                : `自动修理未解锁 · 保护停竿阈值 ${threshold}`}
            </p>

            <div className="fishing-rod-stats" aria-label="鱼竿实战加成">
              <div>
                <span>蓄力速率</span>
                <strong className="mono">{Math.round(rodStats.effectiveEnergy)}/s</strong>
              </div>
              <div>
                <span>张力上限</span>
                <strong className="mono">{Math.round(rodStats.effectiveMaxTension)}</strong>
              </div>
              <div>
                <span>抗损减免</span>
                <strong className="mono">{Math.round(rodStats.effectiveResistance * 100)}%</strong>
              </div>
              <div>
                <span>双倍渔获</span>
                <strong className="mono">{Math.round(rodStats.bonuses.doubleCatch * 100)}%</strong>
              </div>
            </div>

            <div className="fishing-affixes">
              <h3>装备词条</h3>
              {rodAffixes.length > 0 ? (
                <div className="fishing-affix-list">
                  {rodAffixes.map((affix, index) => {
                    const meta = AFFIX_META[affix.type as AffixType];
                    return (
                      <span
                        key={`${affix.type}-${index}`}
                        className="fishing-affix-chip"
                        title={meta?.description}
                      >
                        <Sparkles size={12} aria-hidden="true" />
                        <span>{meta?.label ?? affix.type}</span>
                        <strong className="mono">{formatAffixValue(affix.type, affix.value)}</strong>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="fishing-muted">当前鱼竿暂无附加词条</p>
              )}
            </div>

            <div className="fishing-materials">
              <div>
                <span>{REPAIR_MATERIAL}</span>
                <strong className="mono">×{formatInteger.format(materialCount)}</strong>
              </div>
              <div>
                <span>可用金币</span>
                <strong className="mono">{formatInteger.format(coins)}</strong>
              </div>
            </div>

            {rodLowStopped && (
              <p className="fishing-alert-note" role="status">
                <ShieldAlert size={14} aria-hidden="true" />
                <span>耐久低于阈值已触发保护停竿，请修理后再下竿。</span>
              </p>
            )}

            <div className="fishing-service">
              <button
                className="button button-quiet"
                type="button"
                disabled={!rod || rod.durability >= rod.max_durability || materialCount < 1 || pending !== undefined}
                onClick={() => rod && void act('repair', () => repair(rod.id), '手动修理完成。')}
              >
                <Wrench size={15} aria-hidden="true" />
                {pending === 'repair' ? '修理中…' : '手动修理'}
              </button>
              <small>消耗 1 {REPAIR_MATERIAL} · 恢复最多 50 点耐久</small>

              <button
                className="button button-quiet"
                type="button"
                disabled={!state || coins < UPGRADE_COIN_COST || materialCount < 1 || pending !== undefined}
                onClick={() => void act('upgrade', upgrade, '自动修理已升级。')}
              >
                <ArrowUp size={15} aria-hidden="true" />
                {pending === 'upgrade' ? '升级中…' : level > 0 ? '升级自动修理' : '解锁自动修理'}
              </button>
              <small>消耗 {UPGRADE_COIN_COST} 金币 + 1 {REPAIR_MATERIAL} · 阈值 +10</small>
            </div>
            {maintenanceFeedback && <ActionFeedback feedback={feedback} />}
          </article>
        </div>
      </div>

      <SeaChartModal
        open={chartOpen}
        activeDepthId={depth}
        locked={running || pending !== undefined}
        onSelectDepth={(nextDepth) => {
          setSelectedDepth(nextDepth);
          setChartOpen(false);
        }}
        onClose={() => setChartOpen(false)}
      />
    </section>
  );
}
