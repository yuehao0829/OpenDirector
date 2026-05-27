import type { SnapLine as SnapLineType } from '@opendirector/core/types/timeline';

interface SnapLineProps {
  snapLine: SnapLineType;
  zoom: number;
}

/**
 * Single snap line component for visual feedback during drag/resize operations.
 * Different colors indicate different snap types:
 * - Playhead: red
 * - Fragment edge: blue
 * - Scene edge: cyan
 */
export function SnapLine({ snapLine, zoom }: SnapLineProps) {
  const left = (snapLine.time / 1000) * zoom;

  const lineColors = {
    playhead: 'bg-red-500',
    'fragment-edge': 'bg-blue-400',
    'scene-edge': 'bg-cyan-400',
  };

  return (
    <div
      className={`absolute top-0 bottom-0 w-0.5 z-40 pointer-events-none ${lineColors[snapLine.type]}`}
      style={{ left }}
    />
  );
}

interface SnapLinesProps {
  snapLines: SnapLineType[];
  zoom: number;
}

/**
 * Container component that renders all active snap lines.
 */
export function SnapLines({ snapLines, zoom }: SnapLinesProps) {
  if (snapLines.length === 0) return null;

  return (
    <>
      {snapLines.map((line, index) => (
        <SnapLine
          key={`${line.type}-${line.time}-${index}`}
          snapLine={line}
          zoom={zoom}
        />
      ))}
    </>
  );
}
