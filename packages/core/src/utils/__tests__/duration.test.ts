import { describe, it, expect } from 'vitest';
import { buildContinuousPlan, fragmentMsToGenSeconds, isContinuousMode } from '../duration';

describe('buildContinuousPlan', () => {
  it('returns a single segment for durations <= 15s', () => {
    expect(buildContinuousPlan(5000)).toEqual([5]);
    expect(buildContinuousPlan(15000)).toEqual([15]);
  });

  it('splits exactly at 15s boundary', () => {
    expect(buildContinuousPlan(30000)).toEqual([15, 15]);
  });

  it('splits 32s into [15, 9, 8] (not [15, 15, 2])', () => {
    expect(buildContinuousPlan(32000)).toEqual([15, 9, 8]);
  });

  it('splits 17s into [9, 8] (not [15, 2])', () => {
    expect(buildContinuousPlan(17000)).toEqual([9, 8]);
  });

  it('splits 16s into [8, 8] (not [15, 1])', () => {
    expect(buildContinuousPlan(16000)).toEqual([8, 8]);
  });

  it('splits 33s into [15, 9, 9] (not [15, 15, 3])', () => {
    expect(buildContinuousPlan(33000)).toEqual([15, 9, 9]);
  });

  it('handles 45s as [15, 15, 15]', () => {
    expect(buildContinuousPlan(45000)).toEqual([15, 15, 15]);
  });

  it('handles 4s as [4]', () => {
    expect(buildContinuousPlan(4000)).toEqual([4]);
  });

  it('every segment is >= 4 and <= 15', () => {
    for (const ms of [4000, 5000, 16000, 17000, 20000, 32000, 33000, 45000, 60000, 90000]) {
      const plan = buildContinuousPlan(ms);
      for (const seg of plan) {
        expect(seg).toBeGreaterThanOrEqual(4);
        expect(seg).toBeLessThanOrEqual(15);
      }
    }
  });

  it('sum of segments equals total seconds', () => {
    for (const ms of [4000, 5000, 16000, 17000, 32000, 33000, 45000, 60000]) {
      const plan = buildContinuousPlan(ms);
      const total = plan.reduce((a, b) => a + b, 0);
      expect(total).toBe(Math.ceil(ms / 1000));
    }
  });
});

describe('fragmentMsToGenSeconds', () => {
  it('clamps to [4, 15] and rounds up', () => {
    expect(fragmentMsToGenSeconds(1000)).toBe(4);
    expect(fragmentMsToGenSeconds(3000)).toBe(4);
    expect(fragmentMsToGenSeconds(5000)).toBe(5);
    expect(fragmentMsToGenSeconds(20000)).toBe(15);
  });
});

describe('isContinuousMode', () => {
  it('returns true for durations > 15s', () => {
    expect(isContinuousMode(16000)).toBe(true);
    expect(isContinuousMode(15001)).toBe(true);
  });

  it('returns false for durations <= 15s', () => {
    expect(isContinuousMode(15000)).toBe(false);
    expect(isContinuousMode(5000)).toBe(false);
  });
});

