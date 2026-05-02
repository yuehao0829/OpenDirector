import type { Asset } from '../types/asset';
import type { PreviewTransform } from '../types/media-preview';
import type { Project } from '../types/project';
import type { Fragment, Track } from '../types/timeline';

export interface ProjectMediaTimelineTrack {
  id: string;
  type: 'video' | 'audio';
  muted: boolean;
  order: number;
}

export interface ProjectMediaTimelineClip {
  id: string;
  trackId: string;
  assetId: string;
  inputPath: string;
  name?: string;
  startMs: number;
  durationMs: number;
  trimStartMs?: number;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  transform?: PreviewTransform;
}

export interface ProjectMediaTimeline {
  projectName: string;
  width: number;
  height: number;
  fps: number;
  tracks: ProjectMediaTimelineTrack[];
  clips: ProjectMediaTimelineClip[];
}

export interface BuildProjectMediaTimelineOptions {
  project: Project;
  assetPathResolver: (asset: Asset) => string | undefined;
  missingAssetErrorLabel?: string;
  includeVideoSourceAudio?: boolean;
  missingMediaPolicy?: 'error' | 'skip';
  emptyTimelinePolicy?: 'error' | 'allow';
}

export function buildProjectMediaTimeline(
  options: BuildProjectMediaTimelineOptions,
): ProjectMediaTimeline {
  const {
    project,
    assetPathResolver,
    missingAssetErrorLabel = 'Project media timeline',
    includeVideoSourceAudio = false,
    missingMediaPolicy = 'error',
    emptyTimelinePolicy = 'error',
  } = options;
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const trackById = new Map(project.tracks.map((track) => [track.id, track]));
  const tracks = sortTracksForGesExecution(project.tracks);
  const clips: ProjectMediaTimelineClip[] = [];
  const missingFragments: string[] = [];
  const resolvedFragments: ResolvedProjectMediaFragment[] = includeVideoSourceAudio ? [] : undefined!;

  for (const fragment of project.fragments) {
    const assetId = fragment.sourceAssetId ?? fragment.resultAssetId;
    const asset = resolveFragmentAsset(fragment, assetsById);
    const track = trackById.get(fragment.trackId);
    if (!track) {
      throw new Error(
        `${missingAssetErrorLabel} references unknown track for fragment ${fragment.id}: ${fragment.trackId}`,
      );
    }

    let inputPath: string | undefined;
    if (asset) {
      try {
        inputPath = assetPathResolver(asset);
      } catch (error) {
        if (missingMediaPolicy !== 'skip') {
          throw error;
        }
      }
    }

    if (!assetId || !asset || !inputPath) {
      missingFragments.push(fragment.id);
      continue;
    }

    const clip: ProjectMediaTimelineClip = {
      id: fragment.id,
      trackId: fragment.trackId,
      assetId,
      inputPath,
      name: fragment.prompt || asset.name || undefined,
      startMs: fragment.start,
      durationMs: fragment.duration,
      trimStartMs: fragment.trimStart ?? undefined,
      crop: resolveFragmentCrop(fragment, assetId),
    };

    clips.push(clip);

    if (includeVideoSourceAudio) {
      resolvedFragments.push({
        fragment,
        track,
        assetId,
        asset,
        inputPath,
        clip,
      });
    }
  }

  if (missingFragments.length > 0 && missingMediaPolicy !== 'skip') {
    const preview = missingFragments.slice(0, 3).join(', ');
    const suffix = missingFragments.length > 3 ? '...' : '';
    throw new Error(
      `${missingAssetErrorLabel} requires media-backed fragments. Missing asset or path for ${missingFragments.length} fragment(s): ${preview}${suffix}`,
    );
  }

  if (project.fragments.length > 0 && clips.length === 0 && emptyTimelinePolicy !== 'allow') {
    const preview = missingFragments.slice(0, 3).join(', ');
    const suffix = missingFragments.length > 3 ? '...' : '';
    throw new Error(
      `${missingAssetErrorLabel} requires media-backed fragments. Missing asset or path for ${missingFragments.length} fragment(s): ${preview}${suffix}`,
    );
  }

  const timelineTracks = tracks.map((track) => ({
    id: track.id,
    type: track.type,
    muted: track.muted,
    order: track.order,
  }));

  if (includeVideoSourceAudio) {
    const linkedVideoAudio = buildLinkedVideoSourceAudioTimeline(
      tracks,
      resolvedFragments,
    );
    timelineTracks.push(...linkedVideoAudio.tracks);
    clips.push(...linkedVideoAudio.clips);
  }

  return {
    projectName: project.name,
    width: project.settings.resolution.width,
    height: project.settings.resolution.height,
    fps: project.settings.fps,
    tracks: timelineTracks,
    clips,
  };
}

interface ResolvedProjectMediaFragment {
  fragment: Fragment;
  track: Track;
  assetId: string;
  asset: Asset;
  inputPath: string;
  clip: ProjectMediaTimelineClip;
}

const LINKED_AUDIO_TRACK_PREFIX = '__linked_audio_track__';
const LINKED_AUDIO_CLIP_PREFIX = '__linked_audio_clip__';

function buildLinkedVideoSourceAudioTimeline(
  sortedTracks: Track[],
  fragments: ResolvedProjectMediaFragment[],
): Pick<ProjectMediaTimeline, 'tracks' | 'clips'> {
  const linkedVideoTracks = sortedTracks
    .filter((track) => track.type === 'video')
    .filter((track) =>
      fragments.some((fragment) =>
        fragment.track.id === track.id && assetHasEmbeddedTimelineAudio(fragment.asset),
      ),
    );

  if (linkedVideoTracks.length === 0) {
    return { tracks: [], clips: [] };
  }

  const maxAudioOrder = sortedTracks
    .filter((track) => track.type === 'audio')
    .reduce((maxOrder, track) => Math.max(maxOrder, track.order), -1);
  const linkedTrackIdByVideoTrackId = new Map<string, string>();

  const tracks = linkedVideoTracks.map((track, index) => {
    const linkedTrackId = `${LINKED_AUDIO_TRACK_PREFIX}${track.id}`;
    linkedTrackIdByVideoTrackId.set(track.id, linkedTrackId);
    return {
      id: linkedTrackId,
      type: 'audio' as const,
      muted: track.muted,
      order: maxAudioOrder + index + 1,
    };
  });

  const linkedFragments = fragments.filter((fragment) =>
    fragment.track.type === 'video' && assetHasEmbeddedTimelineAudio(fragment.asset),
  );
  const clips = linkedFragments.map((fragment) => ({
    id: `${LINKED_AUDIO_CLIP_PREFIX}${fragment.fragment.id}`,
    trackId: linkedTrackIdByVideoTrackId.get(fragment.track.id)!,
    assetId: fragment.assetId,
    inputPath: fragment.inputPath,
    name: fragment.clip.name,
    startMs: fragment.clip.startMs,
    durationMs: fragment.clip.durationMs,
    trimStartMs: fragment.clip.trimStartMs,
  }));

  return { tracks, clips };
}

function assetHasEmbeddedTimelineAudio(asset: Asset): boolean {
  return asset.type === 'video' && (asset.audioChannels ?? 0) > 0;
}

function sortTracksForGesExecution(tracks: Track[]): Track[] {
  const videoTracks = tracks
    .filter((track) => track.type === 'video')
    .sort((left, right) => right.order - left.order);

  const audioTracks = tracks
    .filter((track) => track.type === 'audio')
    .sort((left, right) => left.order - right.order);

  return [...videoTracks, ...audioTracks];
}

function resolveFragmentAsset(
  fragment: Fragment,
  assetsById: Map<string, Asset>,
): Asset | undefined {
  const assetId = fragment.sourceAssetId ?? fragment.resultAssetId;
  return assetId ? assetsById.get(assetId) : undefined;
}

function resolveFragmentCrop(
  fragment: Fragment,
  assetId: string,
): ProjectMediaTimelineClip['crop'] {
  return fragment.references.find((reference) => reference.assetId === assetId)?.cropRect;
}
