import type { OtioTimeline } from './types';
import { textToArrayBuffer } from '../encoding';

export function serializeOtioTimeline(timeline: OtioTimeline): string {
  return `${JSON.stringify(timeline, null, 2)}\n`;
}

export function serializeOtioTimelineToBuffer(timeline: OtioTimeline): ArrayBuffer {
  return textToArrayBuffer(serializeOtioTimeline(timeline));
}
