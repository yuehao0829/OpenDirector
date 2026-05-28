import type {
  MediaBackendId,
  TimelineRenderClip,
  TimelineRenderRequest,
  TimelineRenderTrack,
} from '../types/media-backend';
import { buildProjectMediaTimeline, type BuildProjectMediaTimelineOptions } from './project-media-timeline';

export interface BuildTimelineRenderRequestOptions {
  backend?: MediaBackendId;
  outputPath: string;
  outputFormat?: string;
  width: number;
  height: number;
  fps: number;
  tracks: TimelineRenderTrack[];
  clips: TimelineRenderClip[];
}

export interface BuildProjectTimelineRenderRequestOptions extends BuildProjectMediaTimelineOptions {
  backend?: MediaBackendId;
  outputPath: string;
  outputFormat?: string;
  rangeMs?: { start: number; end: number };
}

export function buildTimelineRenderRequest(
  options: BuildTimelineRenderRequestOptions,
): TimelineRenderRequest {
  return {
    backend: options.backend,
    outputPath: options.outputPath,
    outputFormat: options.outputFormat,
    width: options.width,
    height: options.height,
    fps: options.fps,
    tracks: options.tracks,
    clips: options.clips,
  };
}

export function buildProjectTimelineRenderRequest(
  options: BuildProjectTimelineRenderRequestOptions,
): TimelineRenderRequest {
  const timeline = buildProjectMediaTimeline({
    project: options.project,
    assetPathResolver: options.assetPathResolver,
    missingAssetErrorLabel: 'Timeline render',
    includeVideoSourceAudio: true,
    missingMediaPolicy: 'skip',
    resolution: options.resolution,
  });

  let clips = timeline.clips.map<TimelineRenderClip>((clip) => ({
    id: clip.id,
    trackId: clip.trackId,
    assetId: clip.assetId,
    inputPath: clip.inputPath,
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    trimStartMs: clip.trimStartMs,
    mute: clip.muted || undefined,
    crop: clip.crop,
    transform: clip.transform,
  }));

  if (options.rangeMs) {
    const { start: rangeStart, end: rangeEnd } = options.rangeMs;

    clips = clips.reduce<TimelineRenderClip[]>((acc, clip) => {
      const clipEnd = clip.startMs + clip.durationMs;
      if (!(clipEnd > rangeStart && clip.startMs < rangeEnd)) return acc;

      const trimmedStartMs = Math.max(clip.startMs, rangeStart);
      const trimmedEndMs = Math.min(clipEnd, rangeEnd);
      const trimOffset = trimmedStartMs - clip.startMs;

      acc.push({
        ...clip,
        startMs: trimmedStartMs - rangeStart,
        durationMs: trimmedEndMs - trimmedStartMs,
        trimStartMs: (clip.trimStartMs ?? 0) + trimOffset,
      });
      return acc;
    }, []);
  }

  return buildTimelineRenderRequest({
    backend: options.backend,
    outputPath: options.outputPath,
    outputFormat: options.outputFormat,
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    tracks: timeline.tracks.map<TimelineRenderTrack>((track) => ({
      id: track.id,
      type: track.type,
      muted: track.muted,
      order: track.order,
    })),
    clips,
  });
}
