import { Fragment, Scene } from '../types';

/**
 * Safe replacement for Math.max(...array) — avoids call stack overflow on large arrays.
 */
export function safeMax(values: number[]): number {
  if (values.length === 0) return 0;
  let max = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    if (v > max) max = v;
  }
  return max;
}

/**
 * Calculate the total timeline duration based on fragments and scenes.
 * Returns the maximum end time of all fragments and scenes.
 */
export function calculateTimelineDuration(
  fragments: Fragment[],
  scenes: Scene[]
): number {
  const maxFragmentEnd = safeMax(fragments.map(f => f.start + f.duration));
  const maxSceneEnd = safeMax(scenes.map(s => s.start + s.duration));
  return Math.max(maxFragmentEnd, maxSceneEnd);
}

/**
 * Check if a time range overlaps with existing fragments
 */
export function hasOverlap(
  fragments: Fragment[],
  start: number,
  duration: number,
  excludeId?: string
): boolean {
  const end = start + duration;

  return fragments.some((f) => {
    if (f.id === excludeId) return false;

    const fEnd = f.start + f.duration;
    return start < fEnd && end > f.start;
  });
}

/**
 * Check if a fragment can be placed at a specific position
 */
export function canPlaceFragment(
  fragments: Fragment[],
  start: number,
  duration: number,
  trackId: string
): boolean {
  const trackFragments = fragments.filter((f) => f.trackId === trackId);
  return !hasOverlap(trackFragments, start, duration);
}

/**
 * Get the maximum available duration for a fragment placed at `start`
 * on a given track, before it would overlap the next fragment.
 * Returns Infinity if there is no following fragment.
 */
export function getAvailableDuration(
  fragments: Fragment[],
  start: number,
  trackId: string,
  excludeId?: string
): number {
  const nextFragment = fragments
    .filter(f => f.trackId === trackId && f.id !== excludeId && f.start > start)
    .sort((a, b) => a.start - b.start)[0];
  return nextFragment ? nextFragment.start - start : Infinity;
}

/**
 * Find fragment at a specific time position
 */
export function findFragmentAt(
  fragments: Fragment[],
  time: number
): Fragment | undefined {
  return fragments.find((f) => f.start <= time && f.start + f.duration > time);
}

/**
 * Get all fragments within a time range
 */
export function getFragmentsInRange(
  fragments: Fragment[],
  startTime: number,
  endTime: number
): Fragment[] {
  return fragments.filter((f) => {
    const fEnd = f.start + f.duration;
    return f.start < endTime && fEnd > startTime;
  });
}

/**
 * Check if fragments are adjacent
 */
export function areFragmentsContiguous(
  fragments: Fragment[]
): boolean {
  if (fragments.length < 2) return true;

  const sorted = [...fragments].sort((a, b) => a.start - b.start);

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].start + sorted[i - 1].duration < sorted[i].start) {
      return false;
    }
  }

  return true;
}

export function unlinkVideoFragment(f: Fragment): Fragment {
  return { ...f, muted: false, linkedAudioFragmentId: undefined };
}

export function findLinkedVideoFragment(fragments: Fragment[], audioFragmentId: string): Fragment | undefined {
  return fragments.find((f) => f.linkedAudioFragmentId === audioFragmentId);
}

export function buildLinkedVideoIndex(fragments: Fragment[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const f of fragments) {
    if (f.linkedAudioFragmentId) {
      let arr = index.get(f.linkedAudioFragmentId);
      if (!arr) { arr = []; index.set(f.linkedAudioFragmentId, arr); }
      arr.push(f.id);
    }
  }
  return index;
}

export function cleanupLinkedAudioOnDelete(
  fragments: Fragment[],
  deletedIds: Set<string>,
  fragmentById: Map<string, Fragment>,
): Fragment[] {
  const linkedAudioToDelete = new Set<string>();
  for (const id of deletedIds) {
    const fragment = fragmentById.get(id);
    if (fragment?.muted && fragment.linkedAudioFragmentId && !deletedIds.has(fragment.linkedAudioFragmentId)) {
      linkedAudioToDelete.add(fragment.linkedAudioFragmentId);
    }
  }

  if (linkedAudioToDelete.size === 0 && !fragments.some(f => f.linkedAudioFragmentId && deletedIds.has(f.linkedAudioFragmentId))) {
    return fragments;
  }

  return fragments.reduce<Fragment[]>((acc, f) => {
    if (linkedAudioToDelete.has(f.id)) return acc;
    if (f.linkedAudioFragmentId && deletedIds.has(f.linkedAudioFragmentId)) {
      acc.push(unlinkVideoFragment(f));
    } else {
      acc.push(f);
    }
    return acc;
  }, []);
}

/**
 * Snap time to nearest grid
 */
export function snapToGrid(
  time: number,
  gridSize: number = 1000 // default 1 second
): number {
  return Math.round(time / gridSize) * gridSize;
}

/**
 * Convert pixel position to time
 */
export function pixelToTime(
  pixel: number,
  zoom: number
): number {
  return (pixel / zoom) * 1000;
}

/**
 * Convert time to pixel position
 */
export function timeToPixel(
  time: number,
  zoom: number
): number {
  return (time / 1000) * zoom;
}
