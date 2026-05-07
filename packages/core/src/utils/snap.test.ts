import { describe, expect, it } from 'vitest';
import type { Fragment } from '../types';
import { findNearestValidGroupDelta } from './snap';

function createFragment(
  id: string,
  trackId: string,
  start: number,
  duration: number
): Fragment {
  return {
    id,
    trackId,
    start,
    duration,
    prompt: '',
    references: [],
    status: 'draft',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('findNearestValidGroupDelta', () => {
  it('should push the whole group to the nearest valid non-overlapping delta', () => {
    const fragments = [
      createFragment('selected-1', 'track-1', 0, 1000),
      createFragment('selected-2', 'track-1', 2000, 1000),
      createFragment('external', 'track-1', 2500, 1000),
    ];

    const result = findNearestValidGroupDelta(
      1000,
      [
        { fragmentId: 'selected-1', start: 0, duration: 1000, targetTrackId: 'track-1' },
        { fragmentId: 'selected-2', start: 2000, duration: 1000, targetTrackId: 'track-1' },
      ],
      fragments,
    );

    expect(result.delta).toBe(1500);
    expect(result.adjusted).toBe(true);
  });

  it('should respect the minimum delta clamp', () => {
    const fragments = [
      createFragment('selected-1', 'track-1', 500, 1000),
    ];

    const result = findNearestValidGroupDelta(
      -1000,
      [
        { fragmentId: 'selected-1', start: 500, duration: 1000, targetTrackId: 'track-1' },
      ],
      fragments,
      -500,
    );

    expect(result.delta).toBe(-500);
    expect(result.adjusted).toBe(true);
  });
});
