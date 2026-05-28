import { formatTime, formatTimecode, getEffectiveFps } from '@opendirector/core/utils/time';
import { TIME_RULER_HEIGHT } from './constants';

/** Minimum pixel spacing between frame sub-ticks */
const MIN_PIXELS_PER_FRAME = 4;

interface TimeRulerProps {
  width: number;
  zoom: number;
  scrollX: number;
  viewportWidth?: number;
  fps?: number;
}

/**
 * Calculate appropriate time interval for ruler marks based on zoom level.
 * Uses logarithmic scaling for smooth transitions across zoom range.
 */
function calculateInterval(zoom: number): number {
  if (zoom >= 100) return 1000;       // 1 second intervals
  if (zoom >= 50) return 2000;        // 2 second intervals
  if (zoom >= 20) return 5000;        // 5 second intervals
  if (zoom >= 10) return 10000;       // 10 second intervals
  if (zoom >= 5) return 30000;        // 30 second intervals
  if (zoom >= 2) return 60000;        // 1 minute intervals
  if (zoom >= 1) return 300000;       // 5 minute intervals
  if (zoom >= 0.5) return 600000;     // 10 minute intervals
  return 1800000;                      // 30 minute intervals
}

export function TimeRuler({ width, zoom, scrollX, viewportWidth, fps }: TimeRulerProps) {
  const effectiveFps = getEffectiveFps(fps);
  const interval = calculateInterval(zoom);
  const marks: number[] = [];

  const visibleWidth = viewportWidth ?? width;
  const startTime = Math.floor(scrollX / zoom) * 1000;
  const endTime = startTime + (visibleWidth / zoom) * 1000;

  const startMark = Math.floor(startTime / interval) * interval;
  for (let time = startMark; time <= endTime + interval; time += interval) {
    marks.push(time);
  }

  // Frame-level sub-ticks
  const frameMs = 1000 / effectiveFps;
  const pixelsPerFrame = zoom / effectiveFps;
  const showFrameTicks = pixelsPerFrame >= MIN_PIXELS_PER_FRAME;

  const frameTicks: number[] = [];
  if (showFrameTicks) {
    const frameStart = Math.floor(startTime / frameMs) * frameMs;
    for (let t = frameStart; t <= endTime + frameMs; t += frameMs) {
      if (Math.abs(t % interval) > 0.01 && Math.abs(t % interval - interval) > 0.01) {
        frameTicks.push(t);
      }
    }
  }

  const contentWidth = Math.max(width, scrollX + visibleWidth + 100);
  const outerWidth = width + visibleWidth;

  return (
    <div
      className="bg-zinc-900 border-b border-zinc-800 relative overflow-hidden cursor-pointer"
      style={{ height: TIME_RULER_HEIGHT, width: outerWidth }}
      data-testid="time-ruler"
    >
      <div
        className="absolute top-0 h-full"
        style={{
          width: contentWidth,
        }}
      >
        {marks.map((time) => {
          const x = (time / 1000) * zoom;
          return (
            <div
              key={time}
              className="absolute top-0 h-full"
              style={{ left: x }}
            >
              <span className="absolute top-0 left-1/2 -translate-x-1/2 text-xs text-zinc-500 whitespace-nowrap">
                {showFrameTicks ? formatTimecode(time, effectiveFps) : formatTime(time, false)}
              </span>
              <div className="absolute bottom-0 left-0 w-px h-2 bg-zinc-700 -translate-x-[0.5px]" />
            </div>
          );
        })}
        {frameTicks.map((time) => (
          <div
            key={`frame-${time}`}
            className="absolute bottom-0 w-px h-2 bg-zinc-800"
            style={{ left: (time / 1000) * zoom }}
          />
        ))}
      </div>
    </div>
  );
}
