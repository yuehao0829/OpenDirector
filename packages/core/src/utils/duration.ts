import { clamp } from './common';

const MIN_GEN_SECONDS = 4;
const MAX_GEN_SECONDS = 15;
const CONTINUOUS_THRESHOLD_MS = MAX_GEN_SECONDS * 1000;

/**
 * Convert fragment duration (ms) to generation seconds.
 * Clamps to [4, 15] and rounds up (ceil).
 */
export function fragmentMsToGenSeconds(ms: number): number {
  return clamp(Math.ceil(ms / 1000), MIN_GEN_SECONDS, MAX_GEN_SECONDS);
}

/**
 * Check whether a fragment duration requires continuous generation mode.
 * Returns true when the fragment is longer than 15 seconds.
 */
export function isContinuousMode(ms: number): boolean {
  return ms > CONTINUOUS_THRESHOLD_MS;
}

/**
 * Split a total duration (ms) into segments of up to 15 seconds.
 * Each segment is rounded up (ceil) to the nearest integer second.
 * If the last segment would be less than MIN_GEN_SECONDS (4), the last
 * two segments are merged and re-split evenly so every segment is >= 4s.
 */
export function buildContinuousPlan(ms: number): number[] {
  const seconds = Math.ceil(ms / 1000);
  const segments: number[] = [];
  let remaining = seconds;
  while (remaining > 0) {
    const seg = Math.min(MAX_GEN_SECONDS, remaining);
    segments.push(seg);
    remaining -= seg;
  }

  // Fix tail: if last segment < MIN_GEN_SECONDS, merge last two and split evenly
  while (segments.length >= 2 && segments[segments.length - 1] < MIN_GEN_SECONDS) {
    const tail = segments.pop()!;
    const prev = segments.pop()!;
    const combined = tail + prev;
    segments.push(Math.ceil(combined / 2));
    segments.push(Math.floor(combined / 2));
  }

  return segments;
}

/**
 * Convert generation seconds back to fragment milliseconds (for slider → fragment sync).
 */
export function genSecondsToFragmentMs(seconds: number): number {
  return seconds * 1000;
}

