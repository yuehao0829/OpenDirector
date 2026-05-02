/**
 * Dirty Tracking
 *
 * Shared utilities for suppressing dirty marks during internal sync operations.
 * Used by projectStore and undoManager to prevent false dirty flags.
 */

let _suppressDirty = false;

/**
 * Run a function without triggering dirty marks from timelineStore/assetStore changes.
 */
export function withoutDirtyTracking<T>(fn: () => T): T {
  const prev = _suppressDirty;
  _suppressDirty = true;
  try {
    return fn();
  } finally {
    _suppressDirty = prev;
  }
}

/**
 * Check if dirty tracking is currently suppressed.
 */
export function isDirtyTrackingSuppressed(): boolean {
  return _suppressDirty;
}
