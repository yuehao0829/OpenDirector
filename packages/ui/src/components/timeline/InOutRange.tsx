import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { timeToPixel } from '@opendirector/core/utils/timeline';
import { TIME_RULER_HEIGHT, SCENE_TRACK_HEIGHT } from './constants';

const MARKER_WIDTH = 12;
const MARKER_HIT_RADIUS = 6;
const DRAG_START_THRESHOLD = 5;

export { MARKER_HIT_RADIUS, DRAG_START_THRESHOLD };

interface InOutRangeProps {
  zoom: number;
}

function RangeMarker({ x, colorClass, marker }: { x: number; colorClass: string; marker: 'in' | 'out' }) {
  return (
    <div
      className="absolute pointer-events-auto cursor-ew-resize"
      style={{ left: x - MARKER_WIDTH / 2, top: 0, width: MARKER_WIDTH, height: TIME_RULER_HEIGHT }}
      data-inout-marker={marker}
    >
      <svg
        width={MARKER_WIDTH}
        height={TIME_RULER_HEIGHT}
        viewBox={`0 0 ${MARKER_WIDTH} ${TIME_RULER_HEIGHT}`}
        className={colorClass}
      >
        <polygon points={`0,0 ${MARKER_WIDTH},0 ${MARKER_WIDTH / 2},10`} fill="currentColor" />
      </svg>
    </div>
  );
}

export function InOutRange({ zoom }: InOutRangeProps) {
  const inPoint = useTimelineStore((s) => s.inPoint);
  const outPoint = useTimelineStore((s) => s.outPoint);

  if (inPoint === null && outPoint === null) return null;

  const inX = inPoint !== null ? timeToPixel(inPoint, zoom) : null;
  const outX = outPoint !== null ? timeToPixel(outPoint, zoom) : null;
  const rulerTotalHeight = TIME_RULER_HEIGHT + SCENE_TRACK_HEIGHT;

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ height: rulerTotalHeight }}>
      {inX !== null && outX !== null && (
        <div
          className="absolute bg-cyan-500/15 border-x border-cyan-400/30"
          style={{ left: inX, width: Math.max(outX - inX, 1), top: 0, height: rulerTotalHeight }}
        />
      )}

      {inX !== null && <RangeMarker x={inX} colorClass="text-emerald-400" marker="in" />}
      {outX !== null && <RangeMarker x={outX} colorClass="text-red-400" marker="out" />}
    </div>
  );
}

export function InOutDimMask({ zoom }: { zoom: number }) {
  const inPoint = useTimelineStore((s) => s.inPoint);
  const outPoint = useTimelineStore((s) => s.outPoint);

  return (
    <>
      {inPoint !== null && (
        <div
          className="absolute top-0 bottom-0 bg-zinc-950/50 pointer-events-none"
          style={{ left: 0, width: timeToPixel(inPoint, zoom), zIndex: 5 }}
        />
      )}
      {outPoint !== null && (
        <div
          className="absolute top-0 bottom-0 bg-zinc-950/50 pointer-events-none"
          style={{ left: timeToPixel(outPoint, zoom), right: 0, zIndex: 5 }}
        />
      )}
    </>
  );
}
