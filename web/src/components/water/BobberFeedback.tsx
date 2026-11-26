import { Fish, Sparkles, Unlink, Waves } from 'lucide-react';
import type { TensionLevel, WaterEventKind, WaterVisualEvent } from './seaDynamicRenderer';

export interface BobberFeedbackProps {
  activeEvent: WaterVisualEvent | null;
  running: boolean;
  reeling: boolean;
  recovering: boolean;
  tensionLevel: TensionLevel;
  biteFishName?: string;
}

const EVENT_PRESENTATION: Record<WaterEventKind, { label: string; Icon: typeof Fish }> = {
  bite: { label: '有鱼咬钩', Icon: Waves },
  catch: { label: '起鱼入库', Icon: Fish },
  legendary: { label: '传说渔获', Icon: Sparkles },
  escape: { label: '鱼已脱钩', Icon: Unlink },
};

export function BobberFeedback({
  activeEvent,
  running,
  reeling,
  recovering,
  tensionLevel,
  biteFishName,
}: BobberFeedbackProps) {
  const showCard = running || activeEvent !== null;
  const eventMeta = activeEvent ? EVENT_PRESENTATION[activeEvent.kind] : null;
  const Icon = eventMeta?.Icon ?? Waves;

  let label = eventMeta?.label ?? '等待咬钩';
  let specimen: string | undefined;

  if (activeEvent) {
    if (activeEvent.kind === 'bite') {
      specimen = activeEvent.fishName ?? biteFishName;
    } else {
      const qtySuffix = activeEvent.kind !== 'escape' && (activeEvent.quantity ?? 1) > 1
        ? ` ×${activeEvent.quantity}`
        : '';
      specimen = activeEvent.fishName ? `${activeEvent.fishName}${qtySuffix}` : undefined;
    }
  } else if (running) {
    if (reeling) {
      label = '鱼线绷紧';
      specimen = biteFishName;
    } else if (recovering) {
      label = '卸力恢复中';
    } else {
      label = '等待咬钩';
    }
  }

  const announcement = activeEvent
    ? `${label}${specimen ? ` · ${specimen}` : ''}`
    : '';

  return (
    <>
      {showCard && (
        <div className="water-feedback" aria-hidden="true">
          <span className="water-feedback-pointer" />
          <div
            className="water-feedback-card"
            data-kind={activeEvent?.kind ?? (reeling ? 'reeling' : recovering ? 'recovering' : 'idle')}
            data-tension={tensionLevel}
            data-specimen={Boolean(specimen)}
          >
            <Icon size={14} aria-hidden="true" />
            <span>
              <span>{label}</span>
              {specimen && <strong>{specimen}</strong>}
            </span>
          </div>
        </div>
      )}
      <div className="water-sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}
