import { describe, it, expect, beforeEach } from 'vitest';
import { storeEvents, StoreEvent } from './store-events';

describe('storeEvents', () => {
  beforeEach(() => {
    storeEvents.clearAll();
  });

  describe('emit / subscribe', () => {
    it('should deliver events to subscribers', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      storeEvents.emit({ type: 'SELECTION_CLEAR' });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('SELECTION_CLEAR');
    });

    it('should deliver events with payload', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      storeEvents.emit({ type: 'SELECTION_SELECT_FRAGMENT', id: 'f1' });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ type: 'SELECTION_SELECT_FRAGMENT', id: 'f1' });
    });

    it('should deliver to multiple subscribers', () => {
      const received1: StoreEvent[] = [];
      const received2: StoreEvent[] = [];
      storeEvents.subscribe((event) => received1.push(event));
      storeEvents.subscribe((event) => received2.push(event));

      storeEvents.emit({ type: 'SELECTION_CLEAR' });

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });
  });

  describe('unsubscribe', () => {
    it('should stop receiving events after unsubscribe', () => {
      const received: StoreEvent[] = [];
      const unsubscribe = storeEvents.subscribe((event) => received.push(event));

      storeEvents.emit({ type: 'SELECTION_CLEAR' });
      expect(received).toHaveLength(1);

      unsubscribe();

      storeEvents.emit({ type: 'SELECTION_CLEAR' });
      expect(received).toHaveLength(1); // should not receive after unsubscribe
    });
  });

  describe('clearAll', () => {
    it('should remove all subscribers', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      storeEvents.clearAll();

      storeEvents.emit({ type: 'SELECTION_CLEAR' });
      expect(received).toHaveLength(0);
    });
  });

  describe('all event types', () => {
    it('should handle SELECTION_SELECT_FRAGMENTS', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      storeEvents.emit({ type: 'SELECTION_SELECT_FRAGMENTS', ids: ['f1', 'f2'] });

      expect(received[0]).toEqual({ type: 'SELECTION_SELECT_FRAGMENTS', ids: ['f1', 'f2'] });
    });

    it('should handle SELECTION_SELECT_SCENES', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      storeEvents.emit({ type: 'SELECTION_SELECT_SCENES', ids: ['s1'] });

      expect(received[0]).toEqual({ type: 'SELECTION_SELECT_SCENES', ids: ['s1'] });
    });

    it('should handle SELECTION_SELECT_DRAFT', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      const draftData = { trackId: 't1', start: 0, duration: 1000 };
      storeEvents.emit({ type: 'SELECTION_SELECT_DRAFT', data: draftData });

      expect(received[0]).toEqual({ type: 'SELECTION_SELECT_DRAFT', data: draftData });
    });

    it('should handle SELECTION_CLEAR_SECONDARY_FOCUS', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      storeEvents.emit({ type: 'SELECTION_CLEAR_SECONDARY_FOCUS' });

      expect(received[0]).toEqual({ type: 'SELECTION_CLEAR_SECONDARY_FOCUS' });
    });

    it('should handle SNAPSHOT_RESTORED', () => {
      const received: StoreEvent[] = [];
      storeEvents.subscribe((event) => received.push(event));

      const snapshot = {
        tracks: [],
        fragments: [],
        scenes: [],
        duration: 0,
        assets: [],
        pendingDeletions: [],
      };
      storeEvents.emit({ type: 'SNAPSHOT_RESTORED', snapshot });

      expect(received[0]).toEqual({ type: 'SNAPSHOT_RESTORED', snapshot });
    });
  });
});
