import { useEffect, useRef, useState } from 'react';
import { Compass, Waves } from 'lucide-react';
import { DEPTH_META, type DepthId } from '../api/presentation';
import { BobberFeedback } from './water/BobberFeedback';
import { DEPTH_VISUALS } from './water/palettes';
import type { TensionLevel, WaterVisualEvent } from './water/seaDynamicRenderer';
import { WaterScene } from './water/WaterScene';
import './water/water.css';

export type { DepthId };

export interface DeepSeaCanvasCatchEvent {
  id: string;
  event: 'catch' | 'escape';
  ts_ms: number;
  tier: string;
  name: string;
  quantity?: number;
}

export interface DeepSeaCanvasProps {
  depth: DepthId;
  running: boolean;
  reeling: boolean;
  recovering?: boolean;
  tension: number;
  biteFishName?: string;
  catchEvent?: DeepSeaCanvasCatchEvent | null;
  onOpenSeaChart?: () => void;
  still?: boolean;
}

const FRESH_EVENT_WINDOW_MS = 5000;

export default function DeepSeaCanvas({
  depth,
  running,
  reeling,
  recovering = false,
  tension,
  biteFishName,
  catchEvent = null,
  onOpenSeaChart,
  still = false,
}: DeepSeaCanvasProps) {
  const seenEventIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const [outcomeEvent, setOutcomeEvent] = useState<WaterVisualEvent | null>(null);

  const catchId = catchEvent?.id ?? null;
  const catchKind = catchEvent?.event ?? null;
  const catchTsMs = catchEvent?.ts_ms ?? null;
  const catchTier = catchEvent?.tier ?? '';
  const catchName = catchEvent?.name ?? '';
  const catchQuantity = catchEvent?.quantity;

  useEffect(() => {
    if (!catchId || !catchKind || catchTsMs === null) return;
    if (seenEventIdRef.current === catchId) return;

    seenEventIdRef.current = catchId;
    if (Math.abs(Date.now() - catchTsMs) >= FRESH_EVENT_WINDOW_MS) {
      return;
    }

    const kind = catchKind === 'escape'
      ? 'escape'
      : catchTier === 'legendary'
        ? 'legendary'
        : 'catch';

    const nextEvent: WaterVisualEvent = {
      id: catchId,
      kind,
      startedAtMs: Date.now(),
      fishName: catchName,
      tier: catchTier,
      quantity: catchQuantity,
    };
    setOutcomeEvent(nextEvent);
  }, [catchId, catchKind, catchTsMs, catchTier, catchName, catchQuantity]);

  useEffect(() => {
    if (!outcomeEvent) return undefined;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const clearAfterMs = outcomeEvent.kind === 'legendary' ? 3200 : 2200;
    const elapsed = Math.max(0, Date.now() - outcomeEvent.startedAtMs);
    const remaining = Math.max(0, clearAfterMs - elapsed);
    const activeOutcomeId = outcomeEvent.id;

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOutcomeEvent((current) => (current?.id === activeOutcomeId ? null : current));
    }, remaining);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [outcomeEvent]);

  const tensionLevel: TensionLevel = tension >= 0.75
    ? 'critical'
    : tension >= 0.45
      ? 'warning'
      : 'safe';

  const biteEvent: WaterVisualEvent | null = running && reeling && !outcomeEvent
    ? {
        id: `bite:${biteFishName ?? 'active'}`,
        kind: 'bite',
        startedAtMs: Date.now(),
        fishName: biteFishName,
      }
    : null;

  const activeEvent = outcomeEvent ?? biteEvent;
  const depthMeta = DEPTH_META[depth] ?? DEPTH_META.shore;
  const visual = DEPTH_VISUALS[depth] ?? DEPTH_VISUALS.shore;

  return (
    <div
      className="water-stage"
      role="region"
      aria-label={`${depthMeta.name}垂钓海域水面`}
    >
      <WaterScene
        depthId={depth}
        running={running}
        reeling={reeling}
        recovering={recovering}
        tension={tension}
        tensionLevel={tensionLevel}
        activeEvent={activeEvent}
        still={still}
      >
        <BobberFeedback
          activeEvent={activeEvent}
          running={running}
          reeling={reeling}
          recovering={recovering}
          tensionLevel={tensionLevel}
          biteFishName={biteFishName}
        />
      </WaterScene>

      <div className="water-location">
        <span className="water-location-eyebrow">
          <Waves size={12} aria-hidden="true" />
          T{depthMeta.tier} · 当前海域
        </span>
        <h2>{depthMeta.name}</h2>
        <p className="water-location-stats">
          {depthMeta.pressure}× 水压 · 收益 {depthMeta.value.toFixed(1)}×
        </p>
        {onOpenSeaChart && (
          <button
            type="button"
            className="water-chart-link"
            onClick={onOpenSeaChart}
            aria-haspopup="dialog"
          >
            <Compass size={13} aria-hidden="true" />
            <span>查看海图</span>
          </button>
        )}
      </div>

      <div className="water-condition" data-rough={visual.rough}>
        <span aria-hidden="true" />
        <span>
          {reeling ? '咬钩搏斗中' : recovering ? '卸力缓冲' : visual.conditionLabel}
        </span>
      </div>
    </div>
  );
}
