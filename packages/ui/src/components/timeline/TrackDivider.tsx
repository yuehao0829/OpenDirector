interface TrackDividerProps {
  width: number;
  viewportWidth?: number;
}

/**
 * TrackDivider component - visual separator between video and audio tracks.
 *
 * Renders a horizontal divider that spans the full width including the track header.
 * Separates:
 * - Video tracks above (order increasing upward)
 * - Audio tracks below (order increasing downward)
 */
export function TrackDivider({ width, viewportWidth }: TrackDividerProps) {
  const outerWidth = width + (viewportWidth ?? 0);

  return (
    <div
      className="relative bg-zinc-900"
      style={{ height: 4, width: outerWidth }}
      data-testid="track-divider"
    >
      {/* Horizontal divider line - spans full width */}
      <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-zinc-700" />
    </div>
  );
}
