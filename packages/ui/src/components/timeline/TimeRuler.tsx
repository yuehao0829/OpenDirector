import { formatTime } from '@opendirector/core/utils/time';
import { TRACK_HEADER_WIDTH, TIME_RULER_HEIGHT } from './constants';

interface TimeRulerProps {
  width: number;
  zoom: number;
  scrollX: number;
  viewportWidth?: number; // Width of the visible viewport area (for proper mark generation)
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * Calculate appropriate time interval for ruler marks based on zoom level.
 * Uses logarithmic scaling for smooth transitions across zoom range.
 */
function calculateInterval(zoom: number): number {
  // zoom is pixels per second
  // At low zoom (showing many hours), use larger intervals
  // At high zoom (showing seconds), use smaller intervals
  if (zoom >= 100) return 1000;       // 1 second intervals
  if (zoom >= 50) return 2000;        // 2 second intervals
  if (zoom >= 20) return 5000;        // 5 second intervals
  if (zoom >= 10) return 10000;       // 10 second intervals
  if (zoom >= 5) return 30000;        // 30 second intervals
  if (zoom >= 2) return 60000;        // 1 minute intervals
  if (zoom >= 1) return 300000;       // 5 minute intervals
  if (zoom >= 0.5) return 600000;     // 10 minute intervals
  return 1800000;                      // 30 minute intervals (for very zoomed out)
}

export function TimeRuler({ width, zoom, scrollX, viewportWidth, onClick }: TimeRulerProps) {
  // Calculate time marks based on zoom
  const interval = calculateInterval(zoom);
  const marks: number[] = [];

  // Calculate visible time range in content coordinates
  // When using transform: translateX(-scrollX), the visible content is from scrollX to scrollX + viewportWidth
  // If viewportWidth is not provided, fall back to using width (for backward compatibility)
  const visibleWidth = viewportWidth ?? width;
  const startTime = Math.floor(scrollX / zoom) * 1000;
  const endTime = startTime + (visibleWidth / zoom) * 1000;

  // Generate marks for visible range with some buffer
  const startMark = Math.floor(startTime / interval) * interval;
  for (let time = startMark; time <= endTime + interval; time += interval) {
    marks.push(time);
  }

  // Calculate content width: must be at least scrollX + visibleWidth to cover the visible area
  // Add extra buffer to ensure marks are generated beyond the visible area
  const contentWidth = Math.max(width, scrollX + visibleWidth + 100);

  // Outer width = timelineWidth + viewportWidth, ensures no truncation when scrolling to the end
  const outerWidth = width + visibleWidth;

  return (
    <div
      className="bg-zinc-900 border-b border-zinc-800 relative overflow-hidden cursor-pointer"
      style={{ height: TIME_RULER_HEIGHT, width: outerWidth }}
      data-testid="time-ruler"
      onClick={onClick}
    >
      {/* Track header offset */}
      <div
        className="absolute left-0 top-0 bottom-0 bg-zinc-900 border-r border-zinc-800 z-10"
        style={{ width: TRACK_HEADER_WIDTH }}
      />

      {/* Content container - natural scroll to align with SceneTrack and Track */}
      <div
        className="absolute top-0 h-full"
        style={{
          width: contentWidth,
          left: TRACK_HEADER_WIDTH,
        }}
      >
        {marks.map((time) => (
          <div
            key={time}
            className="absolute top-0 h-full flex flex-col items-center"
            style={{ left: (time / 1000) * zoom }}
          >
            <span className="text-xs text-zinc-500">
              {formatTime(time, false)}
            </span>
            <div className="w-px h-2 bg-zinc-700" />
          </div>
        ))}
      </div>
    </div>
  );
}
