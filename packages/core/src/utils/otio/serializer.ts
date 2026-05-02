import type { OtioTimeline } from './types';

export function serializeOtioTimeline(timeline: OtioTimeline): string {
  return `${JSON.stringify(timeline, null, 2)}\n`;
}

export function serializeOtioTimelineToBuffer(timeline: OtioTimeline): ArrayBuffer {
  return new TextEncoder().encode(serializeOtioTimeline(timeline)).buffer as ArrayBuffer;
}
