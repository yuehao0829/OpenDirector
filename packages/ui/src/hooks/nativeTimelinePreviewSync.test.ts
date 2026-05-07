import { describe, expect, it } from 'vitest';
import {
  shouldIgnoreBackwardNativePlayingClockRebase,
  shouldIgnoreStaleNativePlayingPosition,
  shouldRebasePlayingClockToNative,
  shouldSyncPausedNativePlayhead,
} from './nativeTimelinePreviewSync';

describe('shouldSyncPausedNativePlayhead', () => {
  it('ignores paused native positions before the timeline has been initialized', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 0,
        currentPlayheadMs: 12_000,
        currentPlayheadRefMs: 12_000,
        timelineDurationMs: 10_000,
        timelineReady: true,
        timelineAttached: true,
        thresholdMs: 250,
      }),
    ).toBe(false);
  });

  it('ignores paused native positions when no timeline is attached', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 0,
        currentPlayheadMs: 12_000,
        currentPlayheadRefMs: 12_000,
        timelineDurationMs: 10_000,
        timelineReady: false,
        timelineAttached: false,
        thresholdMs: 250,
      }),
    ).toBe(false);
  });

  it('allows small paused position updates after initialization', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 5_020,
        currentPlayheadMs: 5_000,
        currentPlayheadRefMs: 5_010,
        timelineDurationMs: 10_000,
        timelineReady: true,
        timelineAttached: true,
        thresholdMs: 250,
      }),
    ).toBe(true);
  });

  it('rejects large paused jumps even after initialization', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 0,
        currentPlayheadMs: 5_000,
        currentPlayheadRefMs: 5_000,
        timelineDurationMs: 10_000,
        timelineReady: true,
        timelineAttached: true,
        thresholdMs: 250,
      }),
    ).toBe(false);
  });

  it('allows origin sync when the editor is also at origin', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 0,
        currentPlayheadMs: 0,
        currentPlayheadRefMs: 0,
        timelineDurationMs: 10_000,
        timelineReady: true,
        timelineAttached: true,
        thresholdMs: 250,
      }),
    ).toBe(true);
  });

  it('allows paused boundary corrections when the editor playhead is now past the timeline end', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 3_000,
        currentPlayheadMs: 5_000,
        currentPlayheadRefMs: 5_000,
        timelineDurationMs: 3_000,
        timelineReady: true,
        timelineAttached: true,
        thresholdMs: 250,
      }),
    ).toBe(true);
  });

  it('allows aligned paused updates before the session reports timelineAttached', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 5_020,
        currentPlayheadMs: 5_000,
        currentPlayheadRefMs: 5_010,
        timelineDurationMs: 10_000,
        timelineReady: true,
        timelineAttached: false,
        thresholdMs: 250,
      }),
    ).toBe(true);
  });

  it('rejects boundary corrections before the session reports timelineAttached', () => {
    expect(
      shouldSyncPausedNativePlayhead({
        nextPositionMs: 3_000,
        currentPlayheadMs: 5_000,
        currentPlayheadRefMs: 5_000,
        timelineDurationMs: 3_000,
        timelineReady: true,
        timelineAttached: false,
        thresholdMs: 250,
      }),
    ).toBe(false);
  });

  it('ignores stale playing samples that are still behind a locally requested seek target', () => {
    expect(
      shouldIgnoreStaleNativePlayingPosition({
        nextPositionMs: 0,
        targetPositionMs: 5_000,
        sourcePositionMs: 0,
        currentPlayheadRefMs: 5_000,
        requestedAt: 100,
        now: 400,
        thresholdMs: 250,
        maxPendingMs: 2_000,
      }),
    ).toBe(true);
  });

  it('accepts playing samples once the backend has nearly caught up to the requested target', () => {
    expect(
      shouldIgnoreStaleNativePlayingPosition({
        nextPositionMs: 4_900,
        targetPositionMs: 5_000,
        sourcePositionMs: 0,
        currentPlayheadRefMs: 5_000,
        requestedAt: 100,
        now: 400,
        thresholdMs: 250,
        maxPendingMs: 2_000,
      }),
    ).toBe(false);
  });

  it('ignores stale playing samples that are still ahead of a locally requested rewind target', () => {
    expect(
      shouldIgnoreStaleNativePlayingPosition({
        nextPositionMs: 18_960,
        targetPositionMs: 8_340,
        sourcePositionMs: 18_960,
        currentPlayheadRefMs: 8_340,
        requestedAt: 100,
        now: 400,
        thresholdMs: 250,
        maxPendingMs: 2_000,
      }),
    ).toBe(true);
  });

  it('continues ignoring old forward playing samples after the local clock has advanced past the target', () => {
    expect(
      shouldIgnoreStaleNativePlayingPosition({
        nextPositionMs: 4_200,
        targetPositionMs: 5_000,
        sourcePositionMs: 0,
        currentPlayheadRefMs: 5_400,
        requestedAt: 100,
        now: 400,
        thresholdMs: 250,
        maxPendingMs: 2_000,
      }),
    ).toBe(true);
  });

  it('accepts older playing samples after the pending target grace window expires', () => {
    expect(
      shouldIgnoreStaleNativePlayingPosition({
        nextPositionMs: 0,
        targetPositionMs: 5_000,
        sourcePositionMs: 0,
        currentPlayheadRefMs: 5_000,
        requestedAt: 100,
        now: 2_500,
        thresholdMs: 250,
        maxPendingMs: 2_000,
      }),
    ).toBe(false);
  });

  it('accepts rewind-side playing samples after the local clock has already advanced past the target again', () => {
    expect(
      shouldIgnoreStaleNativePlayingPosition({
        nextPositionMs: 8_720,
        targetPositionMs: 8_340,
        sourcePositionMs: 18_960,
        currentPlayheadRefMs: 8_720,
        requestedAt: 100,
        now: 400,
        thresholdMs: 250,
        maxPendingMs: 2_000,
      }),
    ).toBe(false);
  });

  it('rebases the playback clock when the native sample is ahead of the UI', () => {
    expect(
      shouldRebasePlayingClockToNative({
        nativePositionMs: 18_980,
        currentPlayheadRefMs: 7_937,
        thresholdMs: 250,
      }),
    ).toBe(true);
  });

  it('rebases the playback clock when the native sample falls clearly behind the UI', () => {
    expect(
      shouldRebasePlayingClockToNative({
        nativePositionMs: 7_937,
        currentPlayheadRefMs: 18_980,
        thresholdMs: 250,
      }),
    ).toBe(true);
  });

  it('does not rebase the playback clock for small native drift', () => {
    expect(
      shouldRebasePlayingClockToNative({
        nativePositionMs: 19_080,
        currentPlayheadRefMs: 18_960,
        thresholdMs: 250,
      }),
    ).toBe(false);
  });

  it('ignores backward playback clock rebases while a newer local seek target is still pending', () => {
    expect(
      shouldIgnoreBackwardNativePlayingClockRebase({
        nativePositionMs: 8_340,
        currentPlayheadRefMs: 18_740,
        pendingTargetMs: 18_740,
        pendingTargetRequestedAt: 1_000,
        pendingTransportTargetMs: 18_740,
        pendingTransportRequestedAt: 1_020,
        now: 1_080,
        thresholdMs: 250,
        maxPendingMs: 2_000,
        maxPendingTransportIntentMs: 1_500,
      }),
    ).toBe(true);
  });

  it('accepts backward playback clock rebases after the pending local target expires', () => {
    expect(
      shouldIgnoreBackwardNativePlayingClockRebase({
        nativePositionMs: 8_340,
        currentPlayheadRefMs: 18_740,
        pendingTargetMs: 18_740,
        pendingTargetRequestedAt: 1_000,
        pendingTransportTargetMs: 18_740,
        pendingTransportRequestedAt: 1_020,
        now: 4_000,
        thresholdMs: 250,
        maxPendingMs: 2_000,
        maxPendingTransportIntentMs: 1_500,
      }),
    ).toBe(false);
  });
});
