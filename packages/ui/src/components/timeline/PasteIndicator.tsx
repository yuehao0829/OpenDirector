import { TRACK_HEADER_WIDTH, TRACK_HEIGHT, TRACKS_AREA_OFFSET, SCENE_TRACK_HEIGHT } from './constants';

interface PasteIndicatorProps {
  /** Position in content coordinates (pixels from content origin) */
  x: number;
  /** Visual Y position from TRACKS_AREA_OFFSET (pixels), or undefined for Scene track */
  visualY?: number;
}

/**
 * PasteIndicator component - shows where content will be pasted.
 *
 * Displays a blinking white vertical line at the paste target position.
 * - For fragments: positioned at visualY with track height
 * - For scenes: positioned at scene track with scene track height
 */
export function PasteIndicator({ x, visualY }: PasteIndicatorProps) {
  const isSceneTrack = visualY === undefined;

  const top = isSceneTrack
    ? TRACKS_AREA_OFFSET - SCENE_TRACK_HEIGHT
    : TRACKS_AREA_OFFSET + visualY;

  const height = isSceneTrack ? SCENE_TRACK_HEIGHT : TRACK_HEIGHT;

  return (
    <div
      className="absolute w-0.5 bg-white z-30 pointer-events-none animate-pulse"
      style={{
        left: x + TRACK_HEADER_WIDTH,
        top,
        height,
      }}
      data-testid="paste-indicator"
    />
  );
}
