import type { Asset, Fragment, Project, Track } from '../../types';
import { DEFAULT_FPS } from '../../constants';
import type { MediaExchangeWarning } from '../../types/media-exchange';
import type {
  OtioClip,
  OtioExternalReference,
  OtioGap,
  OtioImportAsset,
  OtioImportFragment,
  OtioImportResult,
  OtioImportTrack,
  OtioMappingResult,
  OtioRationalTime,
  OtioTimeRange,
  OtioTimeline,
  OtioTrack,
  OtioUnknownItem,
} from './types';
import type { OtioAssetPathResolver } from './path-resolver';
import { calculateTimelineDuration } from '../timeline';
import { generateId } from '../id';
import { fromOtioTargetUrl, toOtioTargetUrl } from './path-resolver';

export interface ProjectToOtioParams {
  project: Project;
  assetPathResolver: OtioAssetPathResolver;
}

export function mapProjectToOtioTimeline(params: ProjectToOtioParams): OtioMappingResult {
  const { project, assetPathResolver } = params;
  const fps = normalizeFps(project.settings.fps);
  const assetsById = new Map(project.assets.map(asset => [asset.id, asset]));
  const warnings: MediaExchangeWarning[] = [];

  const tracks = sortTracksForOtio(project.tracks).map((track) => buildTrack(track, project, fps, assetsById, assetPathResolver, warnings));
  const durationMs = calculateTimelineDuration(project.fragments, project.scenes);
  const clipCount = project.fragments.length;

  const timeline: OtioTimeline = {
    OTIO_SCHEMA: 'Timeline.1',
    name: project.name,
    metadata: {
      opendirector: {
        projectId: project.id,
        resolution: {
          width: project.settings.resolution.width,
          height: project.settings.resolution.height,
        },
        sceneCount: project.scenes.length,
        exportedAt: new Date().toISOString(),
      },
    },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      metadata: {
        opendirector: {
          fps,
        },
      },
      children: tracks,
    },
  };

  return {
    timeline,
    warnings,
    summary: {
      projectName: project.name,
      durationMs,
      trackCount: project.tracks.length,
      clipCount,
      assetCount: project.assets.length,
    },
  };
}

export function mapOtioTimelineToProjectData(timeline: OtioTimeline): OtioImportResult {
  const warnings: MediaExchangeWarning[] = [];
  const fps = resolveTimelineFps(timeline);
  const resolution = resolveTimelineResolution(timeline);
  const assetRecords = new Map<string, ImportedAssetRecord>();
  const importedTracks = timeline.tracks.children.map((track, index) =>
    buildImportedTrack(track, index, fps, assetRecords, warnings),
  );

  const videoTracks = importedTracks.filter(track => track.type === 'video');
  const audioTracks = importedTracks.filter(track => track.type === 'audio');

  const tracks: OtioImportTrack[] = [
    ...videoTracks.map((track, index) => ({
      ...track,
      order: videoTracks.length - 1 - index,
    })),
    ...audioTracks.map((track, index) => ({
      ...track,
      order: index,
    })),
  ];

  const assets = Array.from(assetRecords.values()).map<OtioImportAsset>((asset) => ({
    id: asset.id,
    name: asset.name,
    localPath: asset.localPath,
    duration: asset.duration,
    type: asset.type,
    width: asset.width,
    height: asset.height,
  }));

  const totalDuration = Math.max(
    0,
    ...tracks.flatMap(track => track.fragments.map(fragment => fragment.start + fragment.duration)),
  );

  return {
    projectName: timeline.name || 'Imported OTIO Project',
    fps,
    width: resolution.width,
    height: resolution.height,
    assets,
    tracks,
    totalDuration,
    warnings,
    summary: {
      projectName: timeline.name || 'Imported OTIO Project',
      durationMs: totalDuration,
      trackCount: tracks.length,
      clipCount: tracks.reduce((sum, track) => sum + track.fragments.length, 0),
      assetCount: assets.length,
    },
  };
}

function buildTrack(
  track: Track,
  project: Project,
  fps: number,
  assetsById: Map<string, Asset>,
  assetPathResolver: OtioAssetPathResolver,
  warnings: MediaExchangeWarning[],
): OtioTrack {
  const fragments = project.fragments
    .filter(fragment => fragment.trackId === track.id)
    .sort((left, right) => left.start - right.start);

  const children: Array<OtioGap | OtioClip> = [];
  let cursorMs = 0;

  for (const fragment of fragments) {
    if (fragment.start > cursorMs) {
      children.push(buildGap(fragment.start - cursorMs, fps, track, cursorMs));
      cursorMs = fragment.start;
    }

    if (fragment.start < cursorMs) {
      warnings.push({
        code: 'fragment_overlap',
        message: `Track "${track.name}" contains overlapping fragments; OTIO export flattened clip ${fragment.id}.`,
      });
    }

    const clip = buildClip(fragment, track, fps, assetsById, assetPathResolver, warnings);
    children.push(clip);
    cursorMs = Math.max(cursorMs, fragment.start + fragment.duration);
  }

  return {
    OTIO_SCHEMA: 'Track.1',
    name: track.name,
    kind: track.type === 'audio' ? 'Audio' : 'Video',
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    metadata: {
      opendirector: {
        id: track.id,
        order: track.order,
        muted: track.muted,
        locked: track.locked,
      },
    },
    children,
  };
}

function buildGap(durationMs: number, fps: number, track: Track, startMs: number): OtioGap {
  return {
    OTIO_SCHEMA: 'Gap.1',
    name: `${track.name} gap`,
    effects: [],
    markers: [],
    enabled: true,
    metadata: {
      opendirector: {
        startMs,
        durationMs,
      },
    },
    source_range: toOtioTimeRange(0, durationMs, fps),
  };
}

function buildClip(
  fragment: Fragment,
  track: Track,
  fps: number,
  assetsById: Map<string, Asset>,
  assetPathResolver: OtioAssetPathResolver,
  warnings: MediaExchangeWarning[],
): OtioClip {
  const assetId = fragment.sourceAssetId ?? fragment.resultAssetId;
  const asset = assetId ? assetsById.get(assetId) : undefined;
  const trimStartMs = Math.max(0, fragment.trimStart ?? 0);
  const sourceDurationMs = clampSourceDuration(fragment, asset, trimStartMs, warnings);
  const mediaReference = buildMediaReference(fragment, asset, assetPathResolver, fps, warnings);

  return {
    OTIO_SCHEMA: 'Clip.1',
    name: fragment.prompt || asset?.name || `Clip ${fragment.id}`,
    effects: [],
    markers: [],
    enabled: true,
    media_reference: mediaReference,
    metadata: {
      opendirector: {
        id: fragment.id,
        trackId: fragment.trackId,
        trackType: track.type,
        timelineStartMs: fragment.start,
        durationMs: fragment.duration,
        trimStartMs,
        sceneId: fragment.sceneId,
        sourceAssetId: fragment.sourceAssetId,
        resultAssetId: fragment.resultAssetId,
        status: fragment.status,
        references: fragment.references,
        providerSelection: fragment.providerSelection,
        genParams: fragment.genParams,
      },
    },
    source_range: toOtioTimeRange(trimStartMs, sourceDurationMs, fps),
  };
}

function buildMediaReference(
  fragment: Fragment,
  asset: Asset | undefined,
  assetPathResolver: OtioAssetPathResolver,
  fps: number,
  warnings: MediaExchangeWarning[],
): OtioExternalReference | null {
  if (!asset) {
    warnings.push({
      code: 'missing_asset',
      message: `Fragment ${fragment.id} has no resolvable asset for OTIO export.`,
    });
    return null;
  }

  const resolvedPath = assetPathResolver(asset);
  if (!resolvedPath) {
    warnings.push({
      code: 'missing_asset_path',
      message: `Asset "${asset.name}" has no exportable path for OTIO export.`,
      path: asset.relativePath ?? asset.sourcePath,
    });
    return null;
  }

  return {
    OTIO_SCHEMA: 'ExternalReference.1',
    name: asset.name,
    target_url: toOtioTargetUrl(resolvedPath),
    available_range: asset.duration !== undefined
      ? toOtioTimeRange(0, asset.duration, fps)
      : null,
    metadata: {
      opendirector: {
        assetId: asset.id,
        assetType: asset.type,
        relativePath: asset.relativePath,
        sourcePath: asset.sourcePath,
        width: asset.width,
        height: asset.height,
        durationMs: asset.duration,
        fps: asset.fps,
      },
    },
  };
}

function clampSourceDuration(
  fragment: Fragment,
  asset: Asset | undefined,
  trimStartMs: number,
  warnings: MediaExchangeWarning[],
): number {
  if (asset?.duration === undefined) {
    return fragment.duration;
  }

  const availableMs = Math.max(0, asset.duration - trimStartMs);
  if (availableMs >= fragment.duration) {
    return fragment.duration;
  }

  warnings.push({
    code: 'clip_duration_clamped',
    message: `Fragment ${fragment.id} exceeds source media duration; exported OTIO source_range was clamped.`,
    path: asset.relativePath ?? asset.sourcePath,
  });

  return availableMs;
}

function sortTracksForOtio(tracks: Track[]): Track[] {
  const videoTracks = tracks
    .filter(track => track.type === 'video')
    .sort((left, right) => right.order - left.order);

  const audioTracks = tracks
    .filter(track => track.type === 'audio')
    .sort((left, right) => left.order - right.order);

  return [...videoTracks, ...audioTracks];
}

function toOtioTimeRange(startMs: number, durationMs: number, fps: number): OtioTimeRange {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: toOtioRationalTime(startMs, fps),
    duration: toOtioRationalTime(durationMs, fps),
  };
}

function toOtioRationalTime(milliseconds: number, fps: number): OtioRationalTime {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    rate: fps,
    value: (milliseconds / 1000) * fps,
  };
}

function normalizeFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return DEFAULT_FPS;
  }
  return fps;
}

interface ImportedAssetRecord {
  id: string;
  name: string;
  localPath: string;
  duration?: number;
  type: 'video' | 'image' | 'audio';
  width?: number;
  height?: number;
}

function buildImportedTrack(
  track: OtioTrack,
  index: number,
  fps: number,
  assetRecords: Map<string, ImportedAssetRecord>,
  warnings: MediaExchangeWarning[],
): OtioImportTrack {
  let cursorMs = 0;
  const fragments: OtioImportFragment[] = [];

  for (const child of track.children) {
    if (isOtioGapItem(child)) {
      cursorMs += rationalTimeToMs(child.source_range.duration);
      continue;
    }

    if (!isOtioClipItem(child)) {
      warnings.push({
        code: 'unsupported_otio_item',
        message: `Unsupported OTIO item ${describeOtioItem(child)} in track "${track.name}" was skipped during import.`,
      });
      continue;
    }

    const duration = resolveClipDuration(child, fps);
    const trimStart = child.source_range
      ? rationalTimeToMs(child.source_range.start_time)
      : 0;
    const sourceAssetId = registerImportedAsset(child, track, assetRecords, warnings);

    fragments.push({
      id: extractStringMetadata(child.metadata, 'id') ?? generateId(),
      name: child.name || 'Imported Clip',
      start: cursorMs,
      duration,
      trimStart,
      sourceAssetId,
    });
    cursorMs += duration;
  }

  return {
    id: extractTrackId(track, index),
    type: track.kind === 'Audio' ? 'audio' : 'video',
    name: track.name || `${track.kind} Track ${index + 1}`,
    muted: extractTrackMuted(track),
    order: 0,
    fragments,
  };
}

function registerImportedAsset(
  clip: OtioClip,
  track: OtioTrack,
  assetRecords: Map<string, ImportedAssetRecord>,
  warnings: MediaExchangeWarning[],
): string | undefined {
  const reference = clip.media_reference;
  if (!reference) {
    warnings.push({
      code: 'missing_media_reference',
      message: `Clip "${clip.name}" has no media_reference and was imported without a source asset.`,
    });
    return undefined;
  }

  const recordKey = reference.target_url;
  const existing = assetRecords.get(recordKey);
  if (existing) {
    return existing.id;
  }

  const metadata = getOpenDirectorMetadata(reference.metadata);
  const assetType = normalizeImportedAssetType(
    metadata.assetType,
    track.kind === 'Audio' ? 'audio' : 'video',
  );

  const assetId = typeof metadata.assetId === 'string' && metadata.assetId.trim()
    ? metadata.assetId
    : generateId();

  assetRecords.set(recordKey, {
    id: assetId,
    name: reference.name || clip.name || 'Imported Asset',
    localPath: fromOtioTargetUrl(reference.target_url),
    duration: reference.available_range
      ? rationalTimeToMs(reference.available_range.duration)
      : undefined,
    type: assetType,
    width: typeof metadata.width === 'number' ? metadata.width : undefined,
    height: typeof metadata.height === 'number' ? metadata.height : undefined,
  });

  return assetId;
}

function resolveTimelineFps(timeline: OtioTimeline): number {
  const stackMetadata = getOpenDirectorMetadata(timeline.tracks.metadata);
  if (typeof stackMetadata.fps === 'number') {
    return normalizeFps(stackMetadata.fps);
  }

  for (const track of timeline.tracks.children) {
    for (const child of track.children) {
      if (isOtioClipItem(child) && child.source_range) {
        return normalizeFps(child.source_range.duration.rate);
      }
      if (isOtioGapItem(child)) {
        return normalizeFps(child.source_range.duration.rate);
      }
    }
  }

  return 30;
}

function resolveTimelineResolution(timeline: OtioTimeline): { width: number; height: number } {
  const metadata = getOpenDirectorMetadata(timeline.metadata);
  const resolution = metadata.resolution;
  if (
    resolution
    && typeof resolution === 'object'
    && typeof (resolution as Record<string, unknown>).width === 'number'
    && typeof (resolution as Record<string, unknown>).height === 'number'
  ) {
    return {
      width: (resolution as Record<string, number>).width,
      height: (resolution as Record<string, number>).height,
    };
  }

  return { width: 1920, height: 1080 };
}

function resolveClipDuration(clip: OtioClip, fps: number): number {
  if (clip.source_range) {
    return rationalTimeToMs(clip.source_range.duration);
  }

  if (clip.media_reference?.available_range) {
    return rationalTimeToMs(clip.media_reference.available_range.duration);
  }

  return Math.round(1000 / normalizeFps(fps));
}

function rationalTimeToMs(time: OtioRationalTime): number {
  const rate = normalizeFps(time.rate);
  return Math.round((time.value / rate) * 1000);
}

function extractTrackId(track: OtioTrack, index: number): string {
  const metadata = getOpenDirectorMetadata(track.metadata);
  return typeof metadata.id === 'string' && metadata.id.trim()
    ? metadata.id
    : `track-${track.kind.toLowerCase()}-${index}`;
}

function extractTrackMuted(track: OtioTrack): boolean {
  const metadata = getOpenDirectorMetadata(track.metadata);
  return metadata.muted === true;
}

function extractStringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const openDirector = getOpenDirectorMetadata(metadata);
  const value = openDirector[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getOpenDirectorMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const openDirector = metadata?.opendirector;
  return openDirector && typeof openDirector === 'object'
    ? openDirector as Record<string, unknown>
    : {};
}

function normalizeImportedAssetType(
  value: unknown,
  fallback: 'video' | 'audio',
): 'video' | 'image' | 'audio' {
  if (value === 'video' || value === 'image' || value === 'audio') {
    return value;
  }
  return fallback;
}

function describeOtioItem(item: OtioUnknownItem): string {
  return typeof item.OTIO_SCHEMA === 'string' && item.OTIO_SCHEMA
    ? item.OTIO_SCHEMA
    : 'unknown';
}

function isOtioGapItem(item: OtioGap | OtioClip | OtioUnknownItem): item is OtioGap {
  return item.OTIO_SCHEMA === 'Gap.1' && isOtioTimeRange(item.source_range);
}

function isOtioClipItem(item: OtioGap | OtioClip | OtioUnknownItem): item is OtioClip {
  if (item.OTIO_SCHEMA !== 'Clip.1') {
    return false;
  }

  return isRecord(item.metadata) && ('media_reference' in item);
}

function isOtioTimeRange(value: unknown): value is OtioTimeRange {
  if (!isRecord(value) || value.OTIO_SCHEMA !== 'TimeRange.1') {
    return false;
  }

  return isOtioRationalTime(value.start_time) && isOtioRationalTime(value.duration);
}

function isOtioRationalTime(value: unknown): value is OtioRationalTime {
  return isRecord(value)
    && value.OTIO_SCHEMA === 'RationalTime.1'
    && typeof value.rate === 'number'
    && typeof value.value === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
