/**
 * Default project settings constants.
 * Single source of truth for resolution, FPS, and other project defaults.
 */

export const DEFAULT_PROJECT_SETTINGS = {
  resolution: { width: 1920, height: 1080 },
} as const;

export const DEFAULT_FPS = 30;
export const DEFAULT_PROVIDER = 'seedance';
export const DEFAULT_ASPECT_RATIO = '16:9';

/** Subdirectories created inside every project folder. */
export const PROJECT_SUBDIRS = [
  'Assets/Video',
  'Assets/Image',
  'Assets/Audio',
  'Generated/Video',
  'Generated/Image',
  'Generated/Audio',
  'Thumbnails',
  'Cache/Preview',
  'Cache/Proxy',
  'Autosave',
] as const;
