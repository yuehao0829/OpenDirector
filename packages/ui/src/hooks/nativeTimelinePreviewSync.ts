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

