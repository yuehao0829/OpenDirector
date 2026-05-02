import type { Fragment, SnapContext, SnapResult, SnapLine } from '../types';

export interface GroupMoveItem {
  fragmentId: string;
  start: number;
  duration: number;
  targetTrackId: string;
}

/** Default snap threshold in CSS pixels */
const DEFAULT_SNAP_THRESHOLD_PX = 25;

/**
 * Convert pixel distance to time distance
 */
export function pixelDistanceToTime(pixels: number, zoom: number): number {
  return (pixels / zoom) * 1000;
}

/**
 * Find the nearest snap point for a given time position.
 * Priority: Playhead > Fragment edge > Scene edge
 *
 * When `context.trackId` is set, fragment edges from ALL tracks are checked
 * (for cross-track snapping), but scene edges are always checked regardless.
 */
export function findSnapPoint(
  time: number,
  context: SnapContext,
  zoom: number,
  thresholdPx: number = DEFAULT_SNAP_THRESHOLD_PX
): SnapResult {
  const threshold = pixelDistanceToTime(thresholdPx, zoom);
  const candidates: { time: number; distance: number; snapLine: SnapLine }[] = [];

  // Priority 1: Playhead snap (highest priority)
  if (context.playhead >= 0) {
    const playheadDistance = Math.abs(time - context.playhead);
    if (playheadDistance <= threshold) {
      candidates.push({
        time: context.playhead,
        distance: playheadDistance,
        snapLine: { time: context.playhead, type: 'playhead' },
      });
    }
  }

  // Priority 2: Fragment edge snaps — check ALL tracks, not just the current one
  for (const fragment of context.fragments) {
    if (context.excludeFragmentIds?.includes(fragment.id)) continue;

    const fragmentStart = fragment.start;
    const fragmentEnd = fragment.start + fragment.duration;

    // Check start edge
    const startDistance = Math.abs(time - fragmentStart);
    if (startDistance <= threshold) {
      candidates.push({
        time: fragmentStart,
        distance: startDistance,
        snapLine: { time: fragmentStart, type: 'fragment-edge' },
      });
    }

    // Check end edge
    const endDistance = Math.abs(time - fragmentEnd);
    if (endDistance <= threshold) {
      candidates.push({
        time: fragmentEnd,
        distance: endDistance,
        snapLine: { time: fragmentEnd, type: 'fragment-edge' },
      });
    }
  }

  // Priority 3: Scene edge snaps
  for (const scene of context.scenes) {
    const sceneStart = scene.start;
    const sceneEnd = scene.start + scene.duration;

    const startDistance = Math.abs(time - sceneStart);
    if (startDistance <= threshold) {
      candidates.push({
        time: sceneStart,
        distance: startDistance,
        snapLine: { time: sceneStart, type: 'scene-edge' },
      });
    }

    const endDistance = Math.abs(time - sceneEnd);
    if (endDistance <= threshold) {
      candidates.push({
        time: sceneEnd,
        distance: endDistance,
        snapLine: { time: sceneEnd, type: 'scene-edge' },
      });
    }
  }

  if (candidates.length === 0) {
    return { time, snapLines: [] };
  }

  // Sort by priority (playhead first, then by distance)
  candidates.sort((a, b) => {
    if (a.snapLine.type === 'playhead' && b.snapLine.type !== 'playhead') return -1;
    if (b.snapLine.type === 'playhead' && a.snapLine.type !== 'playhead') return 1;
    if (a.snapLine.type === 'fragment-edge' && b.snapLine.type === 'scene-edge') return -1;
    if (b.snapLine.type === 'fragment-edge' && a.snapLine.type === 'scene-edge') return 1;
    return a.distance - b.distance;
  });

  // Return the best candidate
  const best = candidates[0];

  // Collect all snap lines at the same time position
  const snapLines = candidates
    .filter(c => c.time === best.time)
    .map(c => c.snapLine);

  return { time: best.time, snapLines };
}

/**
 * Find snap points for both start and end edges during drag.
 * Returns the best snap result considering both edges.
 *
 * Unlike single-edge snap, this checks both the start AND end of the dragged
 * fragment against all snap targets, and picks whichever edge is closer to a
 * snap point.
 */
export function findSnapPointsForDrag(
  startTime: number,
  duration: number,
  context: SnapContext,
  zoom: number,
  thresholdPx: number = DEFAULT_SNAP_THRESHOLD_PX
): SnapResult {
  const endTime = startTime + duration;

  // Check start edge against all targets (including playhead)
  const startSnap = findSnapPoint(startTime, context, zoom, thresholdPx);

  // Check end edge against all targets (including playhead)
  const endSnap = findSnapPoint(endTime, context, zoom, thresholdPx);

  const startHasSnap = startSnap.snapLines.length > 0;
  const endHasSnap = endSnap.snapLines.length > 0;

  // Neither edge has a snap target
  if (!startHasSnap && !endHasSnap) {
    return { time: startTime, snapLines: [] };
  }

  // Only start edge has a snap — use it directly
  if (startHasSnap && !endHasSnap) {
    return { time: startSnap.time, snapLines: startSnap.snapLines };
  }

  // Only end edge has a snap — adjust start so end aligns
  if (!startHasSnap && endHasSnap) {
    return {
      time: endSnap.time - duration,
      snapLines: endSnap.snapLines,
    };
  }

  // Both edges have snaps — pick the closer one (prefer start on tie)
  const startDistancePx = Math.abs((startTime - startSnap.time) / 1000 * zoom);
  const endDistancePx = Math.abs((endTime - endSnap.time) / 1000 * zoom);

  if (startDistancePx <= endDistancePx) {
    return { time: startSnap.time, snapLines: startSnap.snapLines };
  } else {
    return {
      time: endSnap.time - duration,
      snapLines: endSnap.snapLines,
    };
  }
}

/**
 * Check if a position would create overlap with existing fragments.
 * Touching (end == start) is NOT considered overlap.
 */
export function wouldCreateOverlap(
  fragmentId: string,
  newStart: number,
  duration: number,
  trackId: string,
  fragments: Fragment[]
): boolean {
  const trackFragments = fragments.filter(
    f => f.trackId === trackId && f.id !== fragmentId
  );

  const newEnd = newStart + duration;

  return trackFragments.some(f => {
    const fEnd = f.start + f.duration;
    return newStart < fEnd && newEnd > f.start;
  });
}

/**
 * Find the nearest non-overlapping position for a fragment.
 * If the proposed position would overlap, snaps to the nearest edge
 * of the overlapping fragment.
 *
 * `snappedFromOverlap` returns true when the position was adjusted away
 * from the original proposal due to overlap — callers can use this to
 * skip snap-line display when the overlap push-back hides the original snap.
 */
export function findNearestNonOverlappingPosition(
  fragmentId: string,
  proposedStart: number,
  duration: number,
  trackId: string,
  fragments: Fragment[]
): { position: number; snappedFromOverlap: boolean } {
  const trackFragments = fragments.filter(
    f => f.trackId === trackId && f.id !== fragmentId
  );

  const proposedEnd = proposedStart + duration;

  // Find all overlapping fragments
  const overlapping = trackFragments.filter(f => {
    const fEnd = f.start + f.duration;
    return proposedStart < fEnd && proposedEnd > f.start;
  });

  if (overlapping.length === 0) {
    return { position: proposedStart, snappedFromOverlap: false };
  }

  // Find the nearest non-overlapping position
  let bestPosition = proposedStart;
  let minDistance = Infinity;

  for (const f of overlapping) {
    const fEnd = f.start + f.duration;

    // Try placing before this fragment (fragment end aligns with fragment start)
    const positionBefore = f.start - duration;
    const beforeDistance = Math.abs(positionBefore - proposedStart);
    if (positionBefore >= 0 && beforeDistance < minDistance) {
      minDistance = beforeDistance;
      bestPosition = positionBefore;
    }

    // Try placing after this fragment (fragment start aligns with fragment end)
    const afterDistance = Math.abs(fEnd - proposedStart);
    if (afterDistance < minDistance) {
      minDistance = afterDistance;
      bestPosition = fEnd;
    }
  }

  // Ensure the position is still valid (no overlap at the new position)
  const finalEnd = bestPosition + duration;
  const stillOverlapping = trackFragments.some(f => {
    const fEnd = f.start + f.duration;
    return bestPosition < fEnd && finalEnd > f.start;
  });

  // If still overlapping, find any valid position
  if (stillOverlapping) {
    const sorted = [...trackFragments].sort((a, b) => a.start - b.start);
    let lastEnd = 0;
    for (const f of sorted) {
      if (f.start - lastEnd >= duration) {
        return { position: lastEnd, snappedFromOverlap: true };
      }
      lastEnd = f.start + f.duration;
    }
    return { position: lastEnd, snappedFromOverlap: true };
  }

  return { position: Math.max(0, bestPosition), snappedFromOverlap: true };
}

function isDeltaValid(delta: number, intervals: { start: number; end: number }[], minDelta: number): boolean {
  if (delta < minDelta) return false;
  return intervals.every((interval) => delta <= interval.start || delta >= interval.end);
}

/**
 * Find the nearest group delta that preserves relative offsets and avoids
 * overlapping non-selected fragments on the destination tracks.
 */
export function findNearestValidGroupDelta(
  proposedDelta: number,
  items: GroupMoveItem[],
  fragments: Fragment[],
  minDelta: number = -Infinity
): { delta: number; adjusted: boolean } {
  const clampedDelta = Math.max(proposedDelta, minDelta);
  if (items.length === 0) {
    return { delta: clampedDelta, adjusted: clampedDelta !== proposedDelta };
  }

  const selectedIds = new Set(items.map((item) => item.fragmentId));
  const forbidden: { start: number; end: number }[] = [];

  for (const item of items) {
    for (const fragment of fragments) {
      if (selectedIds.has(fragment.id) || fragment.trackId !== item.targetTrackId) continue;

      forbidden.push({
        start: fragment.start - (item.start + item.duration),
        end: fragment.start + fragment.duration - item.start,
      });
    }
  }

  if (forbidden.length === 0) {
    return { delta: clampedDelta, adjusted: clampedDelta !== proposedDelta };
  }

  forbidden.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });

  const merged: { start: number; end: number }[] = [];
  for (const interval of forbidden) {
    const last = merged[merged.length - 1];
    if (!last || interval.start >= last.end) {
      merged.push({ ...interval });
      continue;
    }

    last.end = Math.max(last.end, interval.end);
  }

  if (isDeltaValid(clampedDelta, merged, minDelta)) {
    return { delta: clampedDelta, adjusted: clampedDelta !== proposedDelta };
  }

  const referenceDelta = proposedDelta;
  let bestDelta: number | null = null;
  let bestDistance = Infinity;

  const consider = (candidate: number) => {
    if (!isDeltaValid(candidate, merged, minDelta)) return;

    const distance = Math.abs(candidate - referenceDelta);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestDelta = candidate;
    }
  };

  consider(minDelta);
  for (const interval of merged) {
    consider(interval.start);
    consider(interval.end);
  }

  if (bestDelta === null) {
    return { delta: clampedDelta, adjusted: clampedDelta !== proposedDelta };
  }

  return { delta: bestDelta, adjusted: bestDelta !== proposedDelta };
}

/**
 * Find snap point specifically for resize operations (single edge).
 */
export function findSnapPointForResize(
  edgeTime: number,
  context: SnapContext,
  zoom: number,
  thresholdPx: number = DEFAULT_SNAP_THRESHOLD_PX
): SnapResult {
  return findSnapPoint(edgeTime, context, zoom, thresholdPx);
}
