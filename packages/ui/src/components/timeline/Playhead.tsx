import { useRef, useEffect, useLayoutEffect } from 'react';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { timeToPixel } from '@opendirector/core/utils/timeline';
import { TRACK_HEADER_WIDTH, TRACKS_AREA_OFFSET, TRACK_HEIGHT, TRACK_DIVIDER_HEIGHT } from './constants';

interface PlayheadProps {
  /** Position in content coordinates (pixels from content origin) */
  x: number;
  /** Total height of the timeline content (for proper playhead height) */
  contentHeight?: number;
}

/**
 * Playhead line — renders at the current playback position.
 *
 * During playback, drives its own rAF loop reading getPlayheadRef() for
 * 60fps DOM updates without React re-renders. When paused, position comes
 * from the parent's `x` prop via React.
 */
export function Playhead({ x, contentHeight }: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const zoom = useTimelineStore((s) => s.zoom);

  const defaultHeight = TRACKS_AREA_OFFSET + TRACK_HEIGHT * 2 + TRACK_DIVIDER_HEIGHT;
  const height = contentHeight ?? defaultHeight;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const playheadMs = isPlaying ? useTimelineStore.getState().getPlayheadRef() : x / zoom * 1000;
    const px = timeToPixel(playheadMs, zoom) + TRACK_HEADER_WIDTH;
    el.style.left = `${px}px`;
  }, [isPlaying, x, zoom]);

  // rAF loop: update DOM at 60fps during playback (bypasses ~10fps Zustand re-render jitter)
  useEffect(() => {
    if (!isPlaying) return;

    let raf: number;

    const tick = () => {
      const el = ref.current;
      if (el) {
        const playheadMs = useTimelineStore.getState().getPlayheadRef();
        const px = timeToPixel(playheadMs, zoom) + TRACK_HEADER_WIDTH;
        el.style.left = `${px}px`;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, zoom]);

  return (
    <div
      ref={ref}
      className="absolute top-0 w-0.5 bg-red-500 z-30 pointer-events-none"
      style={{
        height,
      }}
      data-testid="playhead"
    >
      {/* Playhead handle */}
      <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full" />
    </div>
  );
}
