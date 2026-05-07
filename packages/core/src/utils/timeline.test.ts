import { describe, it, expect } from 'vitest';
import {
  hasOverlap,
  canPlaceFragment,
  findFragmentAt,
  getFragmentsInRange,
  areFragmentsAdjacent,
  snapToGrid,
  pixelToTime,
  timeToPixel,
  calculateTimelineDuration,
} from './timeline';
import { Fragment, Scene } from '../types';

// Helper to create test fragments
const createFragment = (
  id: string,
  start: number,
  duration: number,
  trackId: string = 'track-1'
): Fragment => ({
  id,
  trackId,
  start,
  duration,
  prompt: '',
  references: [],
  status: 'draft',
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('hasOverlap', () => {
  it('should return false when there are no fragments', () => {
    expect(hasOverlap([], 0, 1000)).toBe(false);
  });

  it('should return false when fragments do not overlap', () => {
    const fragments = [
      createFragment('f1', 0, 1000),
      createFragment('f2', 2000, 1000),
    ];
    expect(hasOverlap(fragments, 1000, 1000)).toBe(false);
  });

  it('should return true when fragments overlap at start', () => {
    const fragments = [createFragment('f1', 0, 1000)];
    expect(hasOverlap(fragments, 500, 1000)).toBe(true);
  });

  it('should return true when fragments overlap at end', () => {
    const fragments = [createFragment('f1', 1000, 1000)];
    expect(hasOverlap(fragments, 0, 1500)).toBe(true);
  });

  it('should return true when new fragment contains existing fragment', () => {
    const fragments = [createFragment('f1', 500, 500)];
    expect(hasOverlap(fragments, 0, 2000)).toBe(true);
  });

  it('should return true when existing fragment contains new fragment', () => {
    const fragments = [createFragment('f1', 0, 2000)];
    expect(hasOverlap(fragments, 500, 500)).toBe(true);
  });

  it('should return false when fragments touch at boundary', () => {
    const fragments = [createFragment('f1', 0, 1000)];
    expect(hasOverlap(fragments, 1000, 1000)).toBe(false);
  });

  it('should exclude fragment by id when excludeId is provided', () => {
    const fragments = [createFragment('f1', 0, 1000)];
    expect(hasOverlap(fragments, 500, 500, 'f1')).toBe(false);
  });

  it('should check overlap with other fragments when excludeId is provided', () => {
    const fragments = [
      createFragment('f1', 0, 1000),
      createFragment('f2', 2000, 1000),
    ];
    expect(hasOverlap(fragments, 500, 500, 'f1')).toBe(false);
    expect(hasOverlap(fragments, 1500, 1000, 'f1')).toBe(true);
  });
});

describe('canPlaceFragment', () => {
  it('should return true when track has no fragments', () => {
    expect(canPlaceFragment([], 0, 1000, 'track-1')).toBe(true);
  });

  it('should return true when there is no overlap on the same track', () => {
    const fragments = [
      createFragment('f1', 0, 1000, 'track-1'),
      createFragment('f2', 0, 1000, 'track-2'),
    ];
    // f2 on track-2 occupies 0-1000, so 1500-2500 should be fine
    expect(canPlaceFragment(fragments, 1500, 1000, 'track-2')).toBe(true);
    // f1 on track-1 occupies 0-1000, so 500-1500 should overlap
    expect(canPlaceFragment(fragments, 500, 1000, 'track-1')).toBe(false);
  });

  it('should return false when there is overlap on the same track', () => {
    const fragments = [createFragment('f1', 0, 1000, 'track-1')];
    expect(canPlaceFragment(fragments, 500, 1000, 'track-1')).toBe(false);
  });

  it('should only check fragments on the specified track', () => {
    const fragments = [
      createFragment('f1', 0, 1000, 'track-1'),
      createFragment('f2', 0, 1000, 'track-2'),
    ];
    expect(canPlaceFragment(fragments, 500, 1000, 'track-3')).toBe(true);
  });
});

describe('findFragmentAt', () => {
  it('should return undefined when no fragments exist', () => {
    expect(findFragmentAt([], 0)).toBeUndefined();
  });

  it('should return fragment when time is at start', () => {
    const fragment = createFragment('f1', 1000, 1000);
    expect(findFragmentAt([fragment], 1000)).toBe(fragment);
  });

  it('should return fragment when time is in middle', () => {
    const fragment = createFragment('f1', 1000, 1000);
    expect(findFragmentAt([fragment], 1500)).toBe(fragment);
  });

  it('should return undefined when time is at end (exclusive)', () => {
    const fragment = createFragment('f1', 1000, 1000);
    expect(findFragmentAt([fragment], 2000)).toBeUndefined();
  });

  it('should return undefined when time is before fragment', () => {
    const fragment = createFragment('f1', 1000, 1000);
    expect(findFragmentAt([fragment], 500)).toBeUndefined();
  });

  it('should return undefined when time is after fragment', () => {
    const fragment = createFragment('f1', 1000, 1000);
    expect(findFragmentAt([fragment], 2500)).toBeUndefined();
  });

  it('should find correct fragment among multiple', () => {
    const fragments = [
      createFragment('f1', 0, 1000),
      createFragment('f2', 1000, 1000),
      createFragment('f3', 2000, 1000),
    ];
    expect(findFragmentAt(fragments, 1500)).toBe(fragments[1]);
  });
});

describe('getFragmentsInRange', () => {
  it('should return empty array when no fragments exist', () => {
    expect(getFragmentsInRange([], 0, 1000)).toEqual([]);
  });

  it('should return fragment fully contained in range', () => {
    const fragment = createFragment('f1', 500, 500);
    const result = getFragmentsInRange([fragment], 0, 2000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(fragment);
  });

  it('should return fragment partially overlapping at start', () => {
    const fragment = createFragment('f1', 0, 1000);
    const result = getFragmentsInRange([fragment], 500, 1000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(fragment);
  });

  it('should return fragment partially overlapping at end', () => {
    const fragment = createFragment('f1', 500, 1000);
    const result = getFragmentsInRange([fragment], 0, 1000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(fragment);
  });

  it('should return fragment that contains the range', () => {
    const fragment = createFragment('f1', 0, 2000);
    const result = getFragmentsInRange([fragment], 500, 1000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(fragment);
  });

  it('should not return fragment outside range', () => {
    const fragment = createFragment('f1', 0, 500);
    const result = getFragmentsInRange([fragment], 1000, 1000);
    expect(result).toHaveLength(0);
  });

  it('should return multiple fragments in range', () => {
    const fragments = [
      createFragment('f1', 0, 1000),
      createFragment('f2', 1000, 1000),
      createFragment('f3', 3000, 1000),
    ];
    const result = getFragmentsInRange(fragments, 500, 2000);
    expect(result).toHaveLength(2);
    expect(result.map(f => f.id)).toEqual(['f1', 'f2']);
  });

  it('should handle boundary case where fragment starts at range end', () => {
    const fragment = createFragment('f1', 2000, 1000);
    const result = getFragmentsInRange([fragment], 0, 2000);
    expect(result).toHaveLength(0);
  });

  it('should handle boundary case where fragment ends at range start', () => {
    const fragment = createFragment('f1', 0, 1000);
    const result = getFragmentsInRange([fragment], 1000, 1000);
    expect(result).toHaveLength(0);
  });
});

describe('areFragmentsAdjacent', () => {
  it('should return true for empty array', () => {
    expect(areFragmentsAdjacent([])).toBe(true);
  });

  it('should return true for single fragment', () => {
    expect(areFragmentsAdjacent([createFragment('f1', 0, 1000)])).toBe(true);
  });

  it('should return true for adjacent fragments', () => {
    const fragments = [
      createFragment('f1', 0, 1000),
      createFragment('f2', 1000, 500),
      createFragment('f3', 1500, 500),
    ];
    expect(areFragmentsAdjacent(fragments)).toBe(true);
  });

  it('should return false for non-adjacent fragments', () => {
    const fragments = [
      createFragment('f1', 0, 1000),
      createFragment('f2', 2000, 1000), // gap of 1000
    ];
    expect(areFragmentsAdjacent(fragments)).toBe(false);
  });

  it('should return false for overlapping fragments', () => {
    const fragments = [
      createFragment('f1', 0, 1500),
      createFragment('f2', 1000, 1000), // overlap
    ];
    expect(areFragmentsAdjacent(fragments)).toBe(false);
  });

  it('should handle unsorted fragments', () => {
    const fragments = [
      createFragment('f1', 1000, 500),
      createFragment('f2', 0, 1000),
      createFragment('f3', 1500, 500),
    ];
    expect(areFragmentsAdjacent(fragments)).toBe(true);
  });
});

describe('snapToGrid', () => {
  it('should snap to nearest grid with default 1 second grid', () => {
    // Math.round is used, so 500/1000 = 0.5 rounds to 1
    expect(snapToGrid(500)).toBe(1000); // 0.5 rounds to 1
    expect(snapToGrid(400)).toBe(0);    // 0.4 rounds to 0
    expect(snapToGrid(600)).toBe(1000); // 0.6 rounds to 1
    expect(snapToGrid(1500)).toBe(2000); // 1.5 rounds to 2
    expect(snapToGrid(1400)).toBe(1000); // 1.4 rounds to 1
  });

  it('should keep values already on grid', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(1000)).toBe(1000);
    expect(snapToGrid(5000)).toBe(5000);
  });

  it('should support custom grid size', () => {
    expect(snapToGrid(250, 500)).toBe(500);  // 0.5 rounds to 1
    expect(snapToGrid(200, 500)).toBe(0);    // 0.4 rounds to 0
    expect(snapToGrid(300, 500)).toBe(500);  // 0.6 rounds to 1
    expect(snapToGrid(750, 500)).toBe(1000); // 1.5 rounds to 2
    expect(snapToGrid(800, 500)).toBe(1000); // 1.6 rounds to 2
  });

  it('should handle small grid sizes', () => {
    expect(snapToGrid(50, 100)).toBe(100);  // 0.5 rounds to 1
    expect(snapToGrid(49, 100)).toBe(0);    // 0.49 rounds to 0
    expect(snapToGrid(150, 100)).toBe(200); // 1.5 rounds to 2
  });

  it('should handle large grid sizes', () => {
    expect(snapToGrid(2500, 5000)).toBe(5000); // 0.5 rounds to 1
    expect(snapToGrid(2000, 5000)).toBe(0);    // 0.4 rounds to 0
    expect(snapToGrid(3000, 5000)).toBe(5000); // 0.6 rounds to 1
  });
});

describe('pixelToTime', () => {
  it('should convert pixel to time correctly', () => {
    // At zoom 50 (pixels per second), 50 pixels = 1 second = 1000ms
    expect(pixelToTime(50, 50)).toBe(1000);
    expect(pixelToTime(100, 50)).toBe(2000);
    expect(pixelToTime(25, 50)).toBe(500);
  });

  it('should handle different zoom levels', () => {
    // At zoom 100 (pixels per second), 100 pixels = 1 second = 1000ms
    expect(pixelToTime(100, 100)).toBe(1000);
    expect(pixelToTime(50, 100)).toBe(500);

    // At zoom 25 (pixels per second), 25 pixels = 1 second = 1000ms
    expect(pixelToTime(25, 25)).toBe(1000);
  });

  it('should handle zero pixel', () => {
    expect(pixelToTime(0, 50)).toBe(0);
  });

  it('should handle large pixel values', () => {
    expect(pixelToTime(5000, 50)).toBe(100000);
  });
});

describe('timeToPixel', () => {
  it('should convert time to pixel correctly', () => {
    // At zoom 50 (pixels per second), 1000ms = 1 second = 50 pixels
    expect(timeToPixel(1000, 50)).toBe(50);
    expect(timeToPixel(2000, 50)).toBe(100);
    expect(timeToPixel(500, 50)).toBe(25);
  });

  it('should handle different zoom levels', () => {
    // At zoom 100 (pixels per second), 1000ms = 100 pixels
    expect(timeToPixel(1000, 100)).toBe(100);
    expect(timeToPixel(500, 100)).toBe(50);

    // At zoom 25 (pixels per second), 1000ms = 25 pixels
    expect(timeToPixel(1000, 25)).toBe(25);
  });

  it('should handle zero time', () => {
    expect(timeToPixel(0, 50)).toBe(0);
  });

  it('should handle large time values', () => {
    expect(timeToPixel(100000, 50)).toBe(5000);
  });
});

describe('pixelToTime and timeToPixel are inverses', () => {
  it('should be inverse operations', () => {
    const zoom = 50;
    const time = 5000;
    const pixel = timeToPixel(time, zoom);
    expect(pixelToTime(pixel, zoom)).toBe(time);

    const pixel2 = 250;
    const time2 = pixelToTime(pixel2, zoom);
    expect(timeToPixel(time2, zoom)).toBe(pixel2);
  });
});

// Helper to create test scenes
const createScene = (
  id: string,
  start: number,
  duration: number
): Scene => ({
  id,
  name: `Scene ${id}`,
  start,
  duration,
  referenceIds: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('calculateTimelineDuration', () => {
  it('should return 0 when no fragments or scenes', () => {
    expect(calculateTimelineDuration([], [])).toBe(0);
  });

  it('should return max fragment end when only fragments exist', () => {
    const fragments = [
      createFragment('f1', 0, 1000),
      createFragment('f2', 2000, 1000),
    ];
    expect(calculateTimelineDuration(fragments, [])).toBe(3000);
  });

  it('should return max scene end when only scenes exist', () => {
    const scenes = [
      createScene('s1', 0, 1000),
      createScene('s2', 1000, 2000),
    ];
    expect(calculateTimelineDuration([], scenes)).toBe(3000);
  });

  it('should return max of both fragments and scenes', () => {
    const fragments = [createFragment('f1', 0, 2000)];
    const scenes = [createScene('s1', 0, 5000)];
    expect(calculateTimelineDuration(fragments, scenes)).toBe(5000);
  });

  it('should handle fragments extending beyond scenes', () => {
    const fragments = [createFragment('f1', 0, 10000)];
    const scenes = [createScene('s1', 0, 3000)];
    expect(calculateTimelineDuration(fragments, scenes)).toBe(10000);
  });
});
