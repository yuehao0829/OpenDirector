/**
 * Undo Manager
 *
 * Global undo/redo system using a manual snapshot stack.
 * Snapshots are taken when cross-store subscriptions detect changes, ensuring undo
 * history only contains meaningful project-level changes.
 *
 * Dirty state is tracked by projectStore comparing the current state against a saved
 * snapshot. After undo/redo, the caller is responsible for calling
 * `afterUndoRedo()` to recompute isDirty.
 *
 * This module has NO dependency on projectStore, breaking the circular dependency.
 */

import { useTimelineStore } from './timelineStore';
import { storeEvents } from './store-events';
import type { SnapshotPayload } from './store-events';
import { useAssetStore } from './assetStore';
import { withoutDirtyTracking } from './dirty-tracking';
import type { Track, Fragment, Scene } from '../types/timeline';
import type { Asset } from '../types';

// ============================================================================
// Types
// ============================================================================

export interface UndoableSnapshot {
  // Timeline data
  tracks: Track[];
  fragments: Fragment[];
  scenes: Scene[];
  duration: number;
  // Asset data
  assets: Asset[];
  pendingDeletions: Asset[];
}

// ============================================================================
// State
// ============================================================================

const MAX_HISTORY = 50;
let pastStack: UndoableSnapshot[] = [];
let futureStack: UndoableSnapshot[] = [];

/**
 * Whether we are in the middle of an undo/redo operation.
 * Prevents snapshots from being taken during restore.
 */
let _undoActive = false;

/**
 * Debounce timer for pushSnapshot. Groups rapid state changes
 * (e.g. during drag resize) into a single undo record.
 */
let _snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let _snapshotPending = false;

/**
 * The snapshot captured at the last save point.
 * Used to compute isDirty after undo/redo.
 */
let _savedSnapshot: UndoableSnapshot | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Push the current state as the base snapshot (synchronous, no debounce).
 * Called after project load/create to ensure the initial state is on the stack,
 * so the first undo restores to the loaded state.
 */
export function pushBaseSnapshot(): void {
  const snapshot = collectSnapshot();
  pastStack = [snapshot];
  futureStack = [];
  _savedSnapshot = snapshot;
}

/**
 * Push a snapshot onto the undo stack (debounced).
 * Called by cross-store subscriptions when undoable state changes.
 *
 * Uses a 150ms debounce to group rapid state changes (e.g. during drag
 * resize or drag move) into a single undo record.
 */
export function pushSnapshot(): void {
  if (_undoActive) return;
  _snapshotPending = true;

  if (_snapshotTimer !== null) {
    clearTimeout(_snapshotTimer);
  }
  _snapshotTimer = setTimeout(() => {
    _snapshotTimer = null;
    if (!_snapshotPending) return;
    _snapshotPending = false;
    commitSnapshot();
  }, 150);
}

/**
 * Immediately flush any pending debounced snapshot.
 * Call this after operations that need guaranteed undo recording.
 */
export function flushSnapshot(): void {
  if (_snapshotTimer !== null) {
    clearTimeout(_snapshotTimer);
    _snapshotTimer = null;
  }
  if (!_snapshotPending) return;
  _snapshotPending = false;
  commitSnapshot();
}

/**
 * Record the current state as the saved snapshot (call on project save).
 * After this, the caller (projectStore) compares against this to set isDirty.
 */
export function setSavedSnapshot(): void {
  _savedSnapshot = collectSnapshot();
}

/**
 * Get the saved snapshot for comparison.
 * Used by projectStore.afterUndoRedo() to determine dirty state.
 */
export function getSavedSnapshot(): UndoableSnapshot | null {
  return _savedSnapshot;
}

/**
 * Apply a system-level asset update across undo/redo history and the saved snapshot.
 * Preserves shared asset-array references so dirty checks stay stable after undo/redo.
 */
export function mapAssetSnapshots(mapAssets: (assets: Asset[]) => Asset[]): void {
  const mappedAssetsByRef = new Map<Asset[], Asset[]>();

  const getMappedAssets = (assets: Asset[]): Asset[] => {
    if (mappedAssetsByRef.has(assets)) {
      return mappedAssetsByRef.get(assets)!;
    }

    const mappedAssets = mapAssets(assets);
    mappedAssetsByRef.set(assets, mappedAssets);
    return mappedAssets;
  };

  const mapSnapshot = (snapshot: UndoableSnapshot): UndoableSnapshot => {
    const mappedAssets = getMappedAssets(snapshot.assets);
    if (mappedAssets === snapshot.assets) {
      return snapshot;
    }

    return {
      ...snapshot,
      assets: mappedAssets,
    };
  };

  pastStack = pastStack.map(mapSnapshot);
  futureStack = futureStack.map(mapSnapshot);
  _savedSnapshot = _savedSnapshot ? mapSnapshot(_savedSnapshot) : null;
}

/**
 * Perform undo: pop the current state (stack top), restore the new top.
 *
 * Stack model: pastStack top always equals the current state.
 *   [S0, S1, S2] ← S2 is current
 *   undo → pop S2 to future, restore S1 (new top)
 *   → pastStack = [S0, S1], futureStack = [S2]
 */
export function undo(): { changed: boolean; currentSnapshot: UndoableSnapshot | null } {
  flushSnapshot();
  // Need at least 2 entries: base + one change
  if (pastStack.length <= 1) return { changed: false, currentSnapshot: null };

  // Pop current state to redo stack
  const popped = pastStack.pop()!;
  futureStack.push(popped);

  // Restore the new top (the state before the change)
  const target = pastStack[pastStack.length - 1];

  _undoActive = true;
  try {
    restoreSnapshot(target);
  } finally {
    _undoActive = false;
  }

  // Clear selections (items may no longer exist)
  storeEvents.emit({ type: 'SELECTION_CLEAR' });

  return { changed: true, currentSnapshot: target };
}

/**
 * Perform redo: pop from futureStack, push onto pastStack, restore it.
 *
 *   pastStack = [S0], futureStack = [S2, S1]
 *   redo → pop S1, push to past, restore S1 (new top)
 *   → pastStack = [S0, S1], futureStack = [S2]
 */
export function redo(): { changed: boolean; currentSnapshot: UndoableSnapshot | null } {
  flushSnapshot();
  if (futureStack.length === 0) return { changed: false, currentSnapshot: null };

  // Pop from redo stack and push onto undo stack
  const next = futureStack.pop()!;
  pastStack.push(next);

  _undoActive = true;
  try {
    restoreSnapshot(next);
  } finally {
    _undoActive = false;
  }

  // Clear selections (items may no longer exist)
  storeEvents.emit({ type: 'SELECTION_CLEAR' });

  return { changed: true, currentSnapshot: next };
}

/**
 * Clear all undo/redo history and saved snapshot.
 */
export function clearHistory(): void {
  if (_snapshotTimer !== null) {
    clearTimeout(_snapshotTimer);
    _snapshotTimer = null;
  }
  _snapshotPending = false;
  pastStack = [];
  futureStack = [];
}

/**
 * Get current history state for UI.
 */
export function getHistoryState(): { canUndo: boolean; canRedo: boolean } {
  return {
    canUndo: pastStack.length > 1,
    canRedo: futureStack.length > 0,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Actually push a snapshot onto the undo stack.
 */
function commitSnapshot(): void {
  const snapshot = collectSnapshot();

  // Skip if identical to current top of past stack
  if (pastStack.length > 0) {
    const top = pastStack[pastStack.length - 1];
    if (snapshotRefEqual(top, snapshot)) {
      return;
    }
  }

  // New change discards redo history
  futureStack = [];

  pastStack.push(snapshot);

  // Enforce limit
  if (pastStack.length > MAX_HISTORY) {
    pastStack.shift();
  }
}

/**
 * Collect the current undoable slice from timelineStore and assetStore.
 */
function collectSnapshot(): UndoableSnapshot {
  const timeline = useTimelineStore.getState();
  const asset = useAssetStore.getState();
  return {
    tracks: timeline.tracks,
    fragments: timeline.fragments,
    scenes: timeline.scenes,
    duration: timeline.duration,
    assets: asset.assets,
    pendingDeletions: asset.pendingDeletions,
  };
}

/**
 * Reference equality check between two snapshots.
 * Exported so projectStore can compare current state with saved snapshot.
 */
export function snapshotRefEqual(a: UndoableSnapshot, b: UndoableSnapshot): boolean {
  return (
    a.tracks === b.tracks &&
    a.fragments === b.fragments &&
    a.scenes === b.scenes &&
    a.duration === b.duration &&
    a.assets === b.assets &&
    a.pendingDeletions === b.pendingDeletions
  );
}

/**
 * Restore a snapshot by emitting SNAPSHOT_RESTORED event.
 * timelineStore and assetStore subscribe to this event and restore their own state.
 * Wrapped in withoutDirtyTracking to prevent re-triggering markDirty.
 */
function restoreSnapshot(snapshot: UndoableSnapshot): void {
  withoutDirtyTracking(() => {
    const payload: SnapshotPayload = {
      tracks: snapshot.tracks,
      fragments: snapshot.fragments,
      scenes: snapshot.scenes,
      duration: snapshot.duration,
      assets: snapshot.assets,
      pendingDeletions: snapshot.pendingDeletions,
    };
    storeEvents.emit({ type: 'SNAPSHOT_RESTORED', snapshot: payload });
  });
}

