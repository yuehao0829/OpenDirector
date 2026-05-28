/**
 * Timeline component constants
 *
 * Note: Zoom-related constants (ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT, MAX_TIMELINE_DURATION)
 * are defined in @opendirector/core/src/constants/timeline.ts and re-exported here for convenience.
 */

// Re-export zoom constants from core
export {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  MAX_TIMELINE_DURATION,
} from '@opendirector/core/constants/timeline';

/** Width of the track header (left sidebar) in pixels */
export const TRACK_HEADER_WIDTH = 128;

/** Height of each track row in pixels */
export const TRACK_HEIGHT = 80;

/** Height of the time ruler at the top of the timeline */
export const TIME_RULER_HEIGHT = 24;

/** Height of the scene track below the time ruler */
export const SCENE_TRACK_HEIGHT = 24;

/**
 * Calculate the Y offset for track content area (below time ruler and scene track)
 * This is used for absolute positioning of elements that need to align with tracks
 */
export const TRACKS_AREA_OFFSET = TIME_RULER_HEIGHT + SCENE_TRACK_HEIGHT;

/** Height of the divider between video and audio tracks */
export const TRACK_DIVIDER_HEIGHT = 4;
