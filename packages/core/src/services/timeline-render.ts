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
  });

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
    clips: timeline.clips.map<TimelineRenderClip>((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      assetId: clip.assetId,
      inputPath: clip.inputPath,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      trimStartMs: clip.trimStartMs,
      crop: clip.crop,
      transform: clip.transform,
    })),
  });
}
