/**
 * Timeline constants shared between core and UI
 */

/** Minimum zoom level (pixels per second) - shows entire 6-hour timeline */
export const ZOOM_MIN = 0.5;

/** Maximum zoom level (pixels per second) - detailed frame-level editing */
export const ZOOM_MAX = 1000;

/** Default zoom level (pixels per second) */
export const ZOOM_DEFAULT = 50;

/** Number of discrete steps on the zoom slider */
export const ZOOM_SLIDER_STEPS = 100;

/** Multiplicative factor for zoom in/out steps */
export const ZOOM_STEP_FACTOR = 1.2;

/** Maximum timeline duration in milliseconds (6 hours) */
export const MAX_TIMELINE_DURATION = 6 * 60 * 60 * 1000;
