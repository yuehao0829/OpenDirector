/**
 * Store Events — lightweight typed event bus for cross-store coordination.
 *
 * Decouples stores so that a change in one store's API does not silently
 * break another.  Instead of direct `useXxxStore.getState().action()`,
 * the originating store emits an event; the target store subscribes and
 * handles it internally.
 *
 * Event categories:
 * 1. Selection coordination — one-way writes from timeline/asset → selectionStore
 * 2. Undo/Redo coordination — snapshot restore broadcast
 */

import type { DraftSelection } from './selectionStore';
import type { Track, Fragment, Scene } from '../types/timeline';
import type { Asset } from '../types';

// ============================================================================
// Event types
// ============================================================================

// Selection coordination events
export type StoreEvent =
  | { type: 'SELECTION_CLEAR' }
  | { type: 'SELECTION_SELECT_FRAGMENT'; id: string }
  | { type: 'SELECTION_SELECT_FRAGMENTS'; ids: string[] }
  | { type: 'SELECTION_SELECT_SCENES'; ids: string[] }
  | { type: 'SELECTION_SELECT_DRAFT'; data: DraftSelection }
  | { type: 'SELECTION_CLEAR_SECONDARY_FOCUS' }
  // Undo/Redo coordination
  | { type: 'SNAPSHOT_RESTORED'; snapshot: SnapshotPayload };

export interface SnapshotPayload {
  tracks: Track[];
  fragments: Fragment[];
  scenes: Scene[];
  duration: number;
  assets: Asset[];
  pendingDeletions: Asset[];
}

// ============================================================================
// Handler type
// ============================================================================

export type StoreEventHandler = (event: StoreEvent) => void;

// ============================================================================
// Event bus implementation
// ============================================================================

const handlers = new Set<StoreEventHandler>();

export const storeEvents = {
  /** Emit an event to all subscribers. */
  emit(event: StoreEvent): void {
    for (const handler of handlers) {
      handler(event);
    }
  },

  /**
   * Subscribe to all events.
   * @returns an unsubscribe function
   */
  subscribe(handler: StoreEventHandler): () => void {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },

  /** Clear all subscribers (useful for tests). */
  clearAll(): void {
    handlers.clear();
  },
};
