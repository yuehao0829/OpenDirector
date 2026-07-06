import { describe, expect, it } from 'vitest';
import {
  applyBackendSample,
  applyIntent,
  createNativeTransportModel,
  projectPositionMs,
  shouldAdoptPausedPosition,
  type NativeTransportModel,
} from './nativeTransportModel';

describe('nativeTransportModel intents', () => {
  it('starts idle at the origin', () => {
    const model = createNativeTransportModel(1_000);
    expect(model).toEqual({
      phase: 'idle',
      anchorMs: 0,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    });
  });

  it('re-anchors on a seek intent while preserving the phase', () => {
    const model: NativeTransportModel = {
      phase: 'paused',
      anchorMs: 0,
      anchorAt: 0,
      rate: 1,
      pendingAnchorSample: false,
    };
    const next = applyIntent(model, { type: 'seek', targetMs: 4_200 }, 500);
    expect(next).toEqual({
      phase: 'paused',
      anchorMs: 4_200,
      anchorAt: 500,
      rate: 1,
      pendingAnchorSample: true,
    });
  });

  it('enters the playing phase anchored at the play target', () => {
    const model = createNativeTransportModel(0);
    const next = applyIntent(model, { type: 'play', targetMs: 2_000 }, 800);
    expect(next).toEqual({
      phase: 'playing',
      anchorMs: 2_000,
      anchorAt: 800,
      rate: 1,
      pendingAnchorSample: true,
    });
  });

  it('freezes the anchor when pausing', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 0,
      rate: 1,
      pendingAnchorSample: false,
    };
    const next = applyIntent(model, { type: 'pause', targetMs: 1_500 }, 900);
    expect(next).toEqual({
      phase: 'paused',
      anchorMs: 1_500,
      anchorAt: 900,
      rate: 1,
      pendingAnchorSample: true,
    });
  });

  it('keeps the projected position continuous across a rate change', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    };
    const next = applyIntent(model, { type: 'rate', rate: 2 }, 1_600);
    expect(next.rate).toBe(2);
    expect(next.anchorMs).toBe(1_600); // 1000 + (1600-1000)*1
    expect(projectPositionMs(next, 1_700)).toBe(1_800); // 1600 + (1700-1600)*2
  });
});

describe('applyBackendSample', () => {
  it('adopts the backend phase, position, and rate on a phase transition', () => {
    const model = createNativeTransportModel(0);
    const next = applyBackendSample(model, { positionMs: 3_000, phase: 'playing', rate: 2 }, 500);
    expect(next).toEqual({
      phase: 'playing',
      anchorMs: 3_000,
      anchorAt: 500,
      rate: 2,
      pendingAnchorSample: false,
    });
  });

  it('re-anchors a position-only sample while paused', () => {
    const model: NativeTransportModel = {
      phase: 'paused',
      anchorMs: 0,
      anchorAt: 0,
      rate: 1.5,
      pendingAnchorSample: false,
    };
    const next = applyBackendSample(model, { positionMs: 4_000 }, 700);
    expect(next).toEqual({
      phase: 'paused',
      anchorMs: 4_000,
      anchorAt: 700,
      rate: 1.5,
      pendingAnchorSample: false,
    });
  });

  it('ignores a non-positive rate and keeps the current rate', () => {
    const model: NativeTransportModel = {
      phase: 'paused',
      anchorMs: 0,
      anchorAt: 0,
      rate: 2,
      pendingAnchorSample: false,
    };
    const next = applyBackendSample(model, { positionMs: 100, phase: 'paused', rate: 0 }, 10);
    expect(next.rate).toBe(2);
  });

  it('leaves the playing anchor untouched for a within-threshold drift', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    };
    // projection at now=1000 is 1000; sample 1100 drifts +100 (<= 250ms).
    const next = applyBackendSample(model, { positionMs: 1_100, phase: 'playing' }, 1_000);
    expect(next).toBe(model);
  });

  it('re-anchors the playing clock for a beyond-threshold drift', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    };
    // projection at now=1000 is 1000; sample 1400 drifts +400 (> 250ms).
    const next = applyBackendSample(model, { positionMs: 1_400, phase: 'playing' }, 1_000);
    expect(next.anchorMs).toBe(1_400);
    expect(next.anchorAt).toBe(1_000);
  });

  it('re-anchors the first playing sample after an intent even within threshold', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: true,
    };
    const next = applyBackendSample(model, { positionMs: 1_050, phase: 'playing' }, 1_000);
    expect(next.anchorMs).toBe(1_050);
    expect(next.pendingAnchorSample).toBe(false);
  });

  it('re-anchors at the projection on a rate change while playing', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    };
    const next = applyBackendSample(model, { positionMs: 9_999, phase: 'playing', rate: 2 }, 1_600);
    // Anchor follows the projection (1600), not the sample position (9999).
    expect(next.anchorMs).toBe(1_600);
    expect(next.rate).toBe(2);
  });

  it('never re-anchors the playing clock from a frame-timestamp sample', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    };
    const next = applyBackendSample(model, { positionMs: 5_000 }, 1_000);
    expect(next).toBe(model);
  });

  it('adopts a non-playing sample directly while playing', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 1_000,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    };
    const next = applyBackendSample(model, { positionMs: 3_000, phase: 'paused' }, 2_000);
    expect(next).toEqual({
      phase: 'paused',
      anchorMs: 3_000,
      anchorAt: 2_000,
      rate: 1,
      pendingAnchorSample: false,
    });
  });
});

describe('projectPositionMs', () => {
  it('advances by elapsed wall-clock while playing', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 100,
      anchorAt: 1_000,
      rate: 1,
      pendingAnchorSample: false,
    };
    expect(projectPositionMs(model, 1_090)).toBe(190);
  });

  it('applies the rate while playing', () => {
    const model: NativeTransportModel = {
      phase: 'playing',
      anchorMs: 250,
      anchorAt: 500,
      rate: 0.5,
      pendingAnchorSample: false,
    };
    expect(projectPositionMs(model, 700)).toBe(350);
  });

  it('holds the anchor while paused', () => {
    const model: NativeTransportModel = {
      phase: 'paused',
      anchorMs: 320,
      anchorAt: 500,
      rate: 1,
      pendingAnchorSample: false,
    };
    expect(projectPositionMs(model, 5_000)).toBe(320);
  });
});

describe('shouldAdoptPausedPosition', () => {
  const base = {
    timelineDurationMs: 10_000,
    timelineReady: true,
    timelineAttached: true,
    toleranceMs: 250,
  };

  it('rejects paused positions before the timeline is ready', () => {
    expect(
      shouldAdoptPausedPosition({
        ...base,
        timelineReady: false,
        backendMs: 5_000,
        playheadMs: 5_000,
        playheadRefMs: 5_000,
      }),
    ).toBe(false);
  });

  it('adopts a paused position that confirms the editor playhead', () => {
    expect(
      shouldAdoptPausedPosition({
        ...base,
        backendMs: 5_020,
        playheadMs: 5_000,
        playheadRefMs: 5_010,
      }),
    ).toBe(true);
  });

  it('rejects a paused position that neither confirms nor clamps the editor', () => {
    expect(
      shouldAdoptPausedPosition({
        ...base,
        timelineDurationMs: 1_000,
        backendMs: 0,
        playheadMs: 5_000,
        playheadRefMs: 5_000,
      }),
    ).toBe(false);
  });

  it('adopts a boundary clamp once the timeline is attached', () => {
    expect(
      shouldAdoptPausedPosition({
        ...base,
        timelineDurationMs: 3_000,
        backendMs: 3_000,
        playheadMs: 5_000,
        playheadRefMs: 5_000,
      }),
    ).toBe(true);
  });

  it('rejects a boundary clamp before the timeline is attached', () => {
    expect(
      shouldAdoptPausedPosition({
        ...base,
        timelineAttached: false,
        timelineDurationMs: 3_000,
        backendMs: 3_000,
        playheadMs: 5_000,
        playheadRefMs: 5_000,
      }),
    ).toBe(false);
  });
});
