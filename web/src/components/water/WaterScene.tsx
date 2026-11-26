import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  BOBBER_X,
  BOBBER_Y,
  DEPTH_VISUALS,
  FISHER_X,
  WATER_HEIGHT,
  WATER_WIDTH,
  safeContext2D,
  type DepthId,
} from './palettes';
import { getSeaBase } from './seaBaseRenderer';
import { drawSea, type TensionLevel, type WaterVisualEvent } from './seaDynamicRenderer';

const FRAME_INTERVAL_MS = 68;

export interface WaterSceneProps {
  depthId: DepthId;
  running: boolean;
  reeling: boolean;
  recovering?: boolean;
  tension: number;
  tensionLevel: TensionLevel;
  activeEvent?: WaterVisualEvent | null;
  still?: boolean;
  className?: string;
  children?: ReactNode;
}

export function WaterScene({
  depthId,
  running,
  reeling,
  recovering = false,
  tension,
  tensionLevel,
  activeEvent = null,
  still = false,
  className,
  children,
}: WaterSceneProps) {
  const waterRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  const latestRef = useRef({
    depthId,
    running,
    reeling,
    recovering,
    tension,
    tensionLevel,
    activeEvent,
    still,
  });
  latestRef.current = {
    depthId,
    running,
    reeling,
    recovering,
    tension,
    tensionLevel,
    activeEvent,
    still,
  };

  const repaintRef = useRef<(() => void) | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const water = waterRef.current;
    if (!water) return undefined;

    const frameScene = () => {
      const { width, height } = water.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;

      const scale = Math.max(width / WATER_WIDTH, height / WATER_HEIGHT);
      const sceneWidth = WATER_WIDTH * scale;
      const sceneHeight = WATER_HEIGHT * scale;
      const actionCenter = (FISHER_X + BOBBER_X) / 2;
      const left = Math.max(0, Math.min(sceneWidth - width, actionCenter * scale - width / 2));
      const top = Math.max(0, (sceneHeight - height) * 0.65);

      water.style.setProperty('--scene-width', `${sceneWidth}px`);
      water.style.setProperty('--scene-height', `${sceneHeight}px`);
      water.style.setProperty('--scene-left', `${-left}px`);
      water.style.setProperty('--scene-top', `${-top}px`);
      water.style.setProperty('--float-x', `${BOBBER_X * scale - left}px`);
      water.style.setProperty('--float-y', `${BOBBER_Y * scale - top}px`);
    };

    frameScene();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(frameScene) : null;
    observer?.observe(water);
    return () => observer?.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = safeContext2D(canvas);
    const base = getSeaBase(depthId);
    if (!ctx || !base) {
      setUnavailable(true);
      return undefined;
    }
    setUnavailable(false);

    const motion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

    let disposed = false;
    let visible = true;
    let frame = 0;
    let lastPaint = -Infinity;

    const reduced = () => Boolean(latestRef.current.still || motion?.matches);

    const paint = (time: number) => {
      if (disposed) return;
      lastPaint = time;
      const current = latestRef.current;
      const isReduced = reduced();
      const ev = current.activeEvent;
      const eventAgeMs = ev
        ? (isReduced ? 700 : Math.max(0, Date.now() - ev.startedAtMs))
        : 0;

      drawSea(ctx, base, isReduced ? 0 : time, {
        depthId: current.depthId,
        running: current.running,
        reeling: current.reeling,
        recovering: current.recovering,
        tension: current.tension,
        tensionLevel: current.tensionLevel,
        eventKind: ev?.kind ?? null,
        eventAgeMs,
        reducedMotion: isReduced,
      });
    };

    repaintRef.current = () => {
      if (reduced() || !latestRef.current.running) {
        paint(performance.now());
      }
    };

    const tick = (time: number) => {
      if (disposed) return;
      if (time - lastPaint >= FRAME_INTERVAL_MS) {
        paint(time);
      }
      frame = window.requestAnimationFrame(tick);
    };

    const shouldAnimate = () => {
      const current = latestRef.current;
      if (reduced()) return false;
      const hasActiveSplash = Boolean(
        current.activeEvent
        && current.activeEvent.kind !== 'bite'
        && Date.now() - current.activeEvent.startedAtMs < 2200,
      );
      return current.running || hasActiveSplash;
    };

    const refresh = () => {
      window.cancelAnimationFrame(frame);
      if (disposed || !visible || document.hidden) return;
      paint(performance.now());
      if (shouldAnimate()) {
        frame = window.requestAnimationFrame(tick);
      }
    };
    refreshRef.current = refresh;

    if (still) {
      paint(0);
      return () => {
        disposed = true;
        repaintRef.current = null;
        refreshRef.current = null;
      };
    }

    refresh();

    const observer = typeof IntersectionObserver !== 'undefined' && canvas
      ? new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
          refresh();
        })
      : null;
    if (observer && canvas) observer.observe(canvas);

    document.addEventListener('visibilitychange', refresh);
    motion?.addEventListener?.('change', refresh);

    return () => {
      disposed = true;
      repaintRef.current = null;
      refreshRef.current = null;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', refresh);
      motion?.removeEventListener?.('change', refresh);
    };
  }, [depthId, running, still]);

  useLayoutEffect(() => {
    refreshRef.current?.();
  }, [activeEvent?.id]);

  useLayoutEffect(() => {
    repaintRef.current?.();
  }, [reeling, recovering, tension, tensionLevel, activeEvent]);

  const visual = DEPTH_VISUALS[depthId] ?? DEPTH_VISUALS.shore;

  return (
    <div
      className={className ? `water-scene ${className}` : 'water-scene'}
      ref={waterRef}
      style={{ backgroundColor: visual.backdrop }}
    >
      <canvas ref={canvasRef} width={WATER_WIDTH} height={WATER_HEIGHT} aria-hidden="true" />
      {unavailable && !still && (
        <span className="water-render-note" role="status">
          海面画面暂不可用
        </span>
      )}
      {children}
    </div>
  );
}
