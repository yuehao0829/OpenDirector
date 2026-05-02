export interface NativePlaybackSample {
  positionMs: number;
  updatedAt: number;
  rate: number;
}

export function projectNativePlaybackPosition(
  sample: NativePlaybackSample,
  targetTime: number,
): number {
  const basePositionMs = Number.isFinite(sample.positionMs) ? sample.positionMs : 0;
  const sampleUpdatedAt = Number.isFinite(sample.updatedAt) ? sample.updatedAt : 0;

  if (sampleUpdatedAt <= 0) {
    return Math.max(0, basePositionMs);
  }

  const effectiveTargetTime = Number.isFinite(targetTime) ? targetTime : sampleUpdatedAt;
  if (effectiveTargetTime <= sampleUpdatedAt) {
    return Math.max(0, basePositionMs);
  }

  const rate = Number.isFinite(sample.rate) && sample.rate > 0 ? sample.rate : 1;
  return Math.max(0, basePositionMs + (effectiveTargetTime - sampleUpdatedAt) * rate);
}
