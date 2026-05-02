import type { XgesTimelineClip, XgesTimelineExportPayload } from '../types/media-exchange';
import { buildProjectMediaTimeline, type BuildProjectMediaTimelineOptions } from './project-media-timeline';

export interface BuildXgesExportTimelineOptions extends BuildProjectMediaTimelineOptions {}

export function buildXgesExportTimeline(
  options: BuildXgesExportTimelineOptions,
): XgesTimelineExportPayload {
  const timeline = buildProjectMediaTimeline({
    ...options,
    missingAssetErrorLabel: 'XGES export',
    missingMediaPolicy: 'skip',
  });

  return {
    projectName: timeline.projectName,
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    tracks: timeline.tracks.map((track) => ({
      id: track.id,
      type: track.type,
      muted: track.muted,
      order: track.order,
    })),
    clips: timeline.clips.map<XgesTimelineClip>((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      inputPath: clip.inputPath,
      name: clip.name,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      trimStartMs: clip.trimStartMs,
      crop: clip.crop,
    })),
  };
}
