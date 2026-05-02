interface ShouldSyncPausedNativePlayheadOptions {
  nextPositionMs: number;
  currentPlayheadMs: number;
  currentPlayheadRefMs: number;
  timelineDurationMs: number;
  timelineReady: boolean;
  timelineAttached: boolean;
  thresholdMs: number;
}

interface ShouldIgnoreStaleNativePlayingPositionOptions {
  nextPositionMs: number;
  targetPositionMs: number | null;
  sourcePositionMs: number | null;
  currentPlayheadRefMs: number;
  requestedAt: number | null;
  now: number;
  thresholdMs: number;
  maxPendingMs: number;
}

interface ShouldRebasePlayingClockToNativeOptions {
  nativePositionMs: number;
  currentPlayheadRefMs: number;
  thresholdMs: number;
}

interface ShouldIgnoreBackwardNativePlayingClockRebaseOptions {
  nativePositionMs: number;
  currentPlayheadRefMs: number;
  pendingTargetMs: number | null;
  pendingTargetRequestedAt: number | null;
  pendingTransportTargetMs: number | null;
  pendingTransportRequestedAt: number | null;
  now: number;
  thresholdMs: number;
  maxPendingMs: number;
  maxPendingTransportIntentMs: number;
}

/**
 * Accept paused/idle native positions when they either match the editor's
 * current playhead or match the playhead clamped into the current timeline
 * bounds. Small aligned updates are allowed as soon as the current session has
 * submitted a timeline, but boundary corrections only become valid after the
 * session reports that the timeline is actually attached.
 */
export function shouldSyncPausedNativePlayhead({
  nextPositionMs,
  currentPlayheadMs,
  currentPlayheadRefMs,
  timelineDurationMs,
  timelineReady,
  timelineAttached,
  thresholdMs,
}: ShouldSyncPausedNativePlayheadOptions): boolean {
  if (!timelineReady) {
    return false;
  }

  const maxTimelinePositionMs = Math.max(0, timelineDurationMs);
  const clampToTimeline = (positionMs: number) =>
    Math.min(Math.max(0, positionMs), maxTimelinePositionMs);

  const clampedNextPositionMs = clampToTimeline(nextPositionMs);
  const clampedCurrentPlayheadMs = Math.max(0, currentPlayheadMs);
  const clampedCurrentPlayheadRefMs = Math.max(0, currentPlayheadRefMs);

  const matchesCurrentPlayhead =
    Math.abs(clampedCurrentPlayheadMs - clampedNextPositionMs) <= thresholdMs &&
    Math.abs(clampedCurrentPlayheadRefMs - clampedNextPositionMs) <= thresholdMs;
  if (matchesCurrentPlayhead) {
    return true;
  }

  if (!timelineAttached) {
    return false;
  }

  const clampedCurrentTimelinePlayheadMs = clampToTimeline(currentPlayheadMs);
  const clampedCurrentTimelinePlayheadRefMs = clampToTimeline(currentPlayheadRefMs);
  return (
    Math.abs(clampedCurrentTimelinePlayheadMs - clampedNextPositionMs) <= thresholdMs &&
    Math.abs(clampedCurrentTimelinePlayheadRefMs - clampedNextPositionMs) <= thresholdMs
  );
}

/**
 * Ignore stale native playing samples while the UI is still waiting for a
 * locally requested seek target. This prevents seek->play races from briefly
 * rebasing the timeline clock back to an older backend position.
 */
export function shouldIgnoreStaleNativePlayingPosition({
  nextPositionMs,
  targetPositionMs,
  sourcePositionMs,
  currentPlayheadRefMs,
  requestedAt,
  now,
  thresholdMs,
  maxPendingMs,
}: ShouldIgnoreStaleNativePlayingPositionOptions): boolean {
  if (targetPositionMs === null || sourcePositionMs === null || requestedAt === null) {
    return false;
  }

  if (now - requestedAt > maxPendingMs) {
    return false;
  }

  const clampedTargetPositionMs = Math.max(0, targetPositionMs);
  const clampedSourcePositionMs = Math.max(0, sourcePositionMs);
  const clampedCurrentPlayheadRefMs = Math.max(0, currentPlayheadRefMs);
  const clampedNextPositionMs = Math.max(0, nextPositionMs);

  if (Math.abs(clampedTargetPositionMs - clampedSourcePositionMs) <= thresholdMs) {
    return false;
  }

  if (clampedTargetPositionMs > clampedSourcePositionMs) {
    return (
      clampedNextPositionMs < clampedTargetPositionMs - thresholdMs &&
      clampedNextPositionMs < clampedCurrentPlayheadRefMs - thresholdMs
    );
  }

  return (
    clampedNextPositionMs > clampedTargetPositionMs + thresholdMs &&
    clampedNextPositionMs > clampedCurrentPlayheadRefMs + thresholdMs
  );
}

/**
 * Rebase the local playback clock whenever a direct native transport sample and
 * the editor's authoritative playhead drift apart beyond the accepted
 * threshold. Event-driven samples are authoritative enough to correct both
 * leading and lagging drift; the animation loop applies its own stricter
 * backward-only guard to avoid visual jitter near clip boundaries.
 */
export function shouldRebasePlayingClockToNative({
  nativePositionMs,
  currentPlayheadRefMs,
  thresholdMs,
}: ShouldRebasePlayingClockToNativeOptions): boolean {
  const clampedNativePositionMs = Math.max(0, nativePositionMs);
  const clampedCurrentPlayheadRefMs = Math.max(0, currentPlayheadRefMs);
  return Math.abs(clampedNativePositionMs - clampedCurrentPlayheadRefMs) > thresholdMs;
}

/**
 * While a newer local seek / transport target is still pending, the backend may
 * continue to report an older playing position for a short window. Ignore those
 * backward rebases so the UI does not snap back to the stale backend clock
 * before the native transport finishes catching up.
 */
export function shouldIgnoreBackwardNativePlayingClockRebase({
  nativePositionMs,
  currentPlayheadRefMs,
  pendingTargetMs,
  pendingTargetRequestedAt,
  pendingTransportTargetMs,
  pendingTransportRequestedAt,
  now,
  thresholdMs,
  maxPendingMs,
  maxPendingTransportIntentMs,
}: ShouldIgnoreBackwardNativePlayingClockRebaseOptions): boolean {
  const clampedNativePositionMs = Math.max(0, nativePositionMs);
  const clampedCurrentPlayheadRefMs = Math.max(0, currentPlayheadRefMs);

  if (clampedNativePositionMs >= clampedCurrentPlayheadRefMs - thresholdMs) {
    return false;
  }

  const hasFreshProtectedTarget = (
    targetMs: number | null,
    requestedAt: number | null,
    maxAgeMs: number,
  ) => {
    if (targetMs === null || requestedAt === null) {
      return false;
    }

    if (now - requestedAt > maxAgeMs) {
      return false;
    }

    const clampedTargetMs = Math.max(0, targetMs);
    return (
      clampedTargetMs >= clampedCurrentPlayheadRefMs - thresholdMs &&
      clampedTargetMs > clampedNativePositionMs + thresholdMs
    );
  };

  return (
    hasFreshProtectedTarget(pendingTargetMs, pendingTargetRequestedAt, maxPendingMs) ||
    hasFreshProtectedTarget(
      pendingTransportTargetMs,
      pendingTransportRequestedAt,
      maxPendingTransportIntentMs,
    )
  );
}
