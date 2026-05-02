import type { OtioTimeline } from './types';

export function parseOtioTimeline(input: string): OtioTimeline {
  const parsed = JSON.parse(input) as unknown;
  if (!isOtioTimeline(parsed)) {
    throw new Error('Invalid OTIO timeline payload');
  }
  return parsed;
}

function isOtioTimeline(value: unknown): value is OtioTimeline {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.OTIO_SCHEMA !== 'Timeline.1') {
    return false;
  }

  const tracks = candidate.tracks;
  if (!tracks || typeof tracks !== 'object') {
    return false;
  }

  return (tracks as Record<string, unknown>).OTIO_SCHEMA === 'Stack.1';
}
