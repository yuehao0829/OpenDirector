/**
 * Timeline constants shared between core and UI
 */

/** Minimum zoom level (pixels per second) - shows entire 6-hour timeline */
export const ZOOM_MIN = 0.5;

/** Maximum zoom level (pixels per second) - detailed frame-level editing */
export const ZOOM_MAX = 200;

/** Default zoom level (pixels per second) */
export const ZOOM_DEFAULT = 50;

/** Zoom step for +/- buttons (pixels per second) */
export const ZOOM_STEP = 10;

/** Number of discrete steps on the zoom slider */
export const ZOOM_SLIDER_STEPS = 100;

/** Maximum timeline duration in milliseconds (6 hours) */
export const MAX_TIMELINE_DURATION = 6 * 60 * 60 * 1000;
