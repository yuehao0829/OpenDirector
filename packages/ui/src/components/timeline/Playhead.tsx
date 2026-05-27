import { useRef, useEffect, useLayoutEffect } from 'react';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { timeToPixel } from '@opendirector/core/utils/timeline';

/**
 * Drives playhead DOM position: writes el.style.left directly via rAF during
 * playback (60fps, no React re-renders), or from the x prop when paused.
 * Returns a ref that must be attached to the positioned element.
 */
function usePlayheadPosition(x: number) {
  const ref = useRef<HTMLDivElement>(null);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const zoom = useTimelineStore((s) => s.zoom);

  // When paused: position is derived from the x prop (already in pixels).
  // When playing: the rAF loop below handles positioning, so this
  // useLayoutEffect only needs to run on pause transitions.
  useLayoutEffect(() => {
    if (isPlaying) return;
    const el = ref.current;
    if (el) el.style.left = `${x}px`;
  }, [isPlaying, x]);

  useEffect(() => {
    if (!isPlaying) return;

    let raf: number;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const playheadMs = useTimelineStore.getState().getPlayheadRef();
        el.style.left = `${timeToPixel(playheadMs, zoom)}px`;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, zoom]);

  return ref;
}

interface PlayheadHandleProps {
  x: number;
}

/** Small red circle at the top of the ruler area. */
export function PlayheadHandle({ x }: PlayheadHandleProps) {
  const ref = usePlayheadPosition(x);

  return (
    <div
      ref={ref}
      className="absolute top-0 w-3 h-3 bg-red-500 rounded-full z-30 pointer-events-none -translate-x-1/2"
      data-testid="playhead-ruler"
    />
  );
}

interface PlayheadLineProps {
  x: number;
  contentHeight?: number;
}

/** Red vertical line spanning the track content area. */
export function PlayheadLine({ x, contentHeight }: PlayheadLineProps) {
  const ref = usePlayheadPosition(x);

  return (
    <div
      ref={ref}
      className="absolute top-0 w-0.5 bg-red-500 z-30 pointer-events-none"
      style={{
        height: contentHeight ?? 200,
      }}
      data-testid="playhead"
    />
  );
}
