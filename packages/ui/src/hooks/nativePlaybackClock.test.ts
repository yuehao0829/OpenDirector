import { describe, expect, it } from 'vitest';
import { projectNativePlaybackPosition } from './nativePlaybackClock';

describe('projectNativePlaybackPosition', () => {
  it('projects a native sample forward by the elapsed wall-clock time', () => {
    expect(
      projectNativePlaybackPosition(
        {
          positionMs: 100,
          updatedAt: 1_000,
          rate: 1,
        },
        1_090,
      ),
    ).toBe(190);
  });

  it('applies the playback rate when projecting a sample', () => {
    expect(
      projectNativePlaybackPosition(
        {
          positionMs: 250,
          updatedAt: 500,
          rate: 0.5,
        },
        700,
      ),
    ).toBe(350);
  });

  it('falls back to the raw sample when the timestamp is not initialized', () => {
    expect(
      projectNativePlaybackPosition(
        {
          positionMs: 320,
          updatedAt: 0,
          rate: 1,
        },
        1_000,
      ),
    ).toBe(320);
  });

  it('preserves continuity when a playback clock is rebased for a rate change', () => {
    const rebasedPositionMs = projectNativePlaybackPosition(
      {
        positionMs: 100,
        updatedAt: 1_000,
        rate: 1,
      },
      1_600,
    );

    expect(
      projectNativePlaybackPosition(
        {
          positionMs: rebasedPositionMs,
          updatedAt: 1_600,
          rate: 2,
        },
        1_700,
      ),
    ).toBe(900);
  });
});
