import { DEFAULT_PROVIDER } from '../constants';
import { generateId } from '../utils/id';
import type { FileSystemAdapter } from '../adapters/types';
import type {
  ImportedTimelineAsset,
  ImportedTimelineFragment,
  ImportedTimelineTrack,
} from '../types/media-exchange';
import type { Asset } from '../types/asset';
import type { Project } from '../types/project';
import { areAssetMetadataFieldsEqual } from './project-media-metadata';

export interface ImportedTimelineProjectData {
  projectName?: string;
  fps: number;
  width: number;
  height: number;
  assets: ImportedTimelineAsset[];
  tracks: ImportedTimelineTrack[];
}

export function buildImportedProjectFromTimelineData(
  data: ImportedTimelineProjectData,
  fallbackProjectName: string,
): Project {
  const now = new Date();
  const assetTypeById = new Map(data.assets.map((asset) => [asset.id, asset.type]));

  return {
    id: generateId(),
    name: data.projectName || fallbackProjectName,
    tracks: data.tracks.map((track) => ({
      id: track.id,
      type: track.type,
      name: track.name,
      muted: track.muted,
      locked: false,
      order: track.order,
    })),
    fragments: data.tracks.flatMap((track) =>
      track.fragments.map((fragment) => ({
        id: fragment.id || generateId(),
        trackId: track.id,
        start: fragment.start,
        duration: fragment.duration,
        prompt: fragment.name,
        references: buildImportedFragmentReferences(fragment, assetTypeById),
        status: 'completed' as const,
        sourceAssetId: fragment.sourceAssetId,
        trimStart: fragment.trimStart,
        createdAt: now,
        updatedAt: now,
      })),
    ),
    scenes: [],
    assets: data.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      source: 'original' as const,
      url: asset.localPath,
      sourcePath: asset.localPath,
      generationId: undefined,
      thumbnailUrl: undefined,
      waveformDataPath: undefined,
      fileSize: 0,
      mimeType: '',
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      audioChannels: asset.audioChannels,
      sampleRate: asset.sampleRate,
      mediaMetadataHydrated: asset.mediaMetadataHydrated,
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    })),
    settings: {
      fps: data.fps,
      resolution: { width: data.width, height: data.height },
      defaultProvider: DEFAULT_PROVIDER,
      defaultAspectRatio: `${data.width}:${data.height}`,
      providerConfig: {},
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function hydrateImportedProjectAssetMetadata(
  project: Project,
  fs: Pick<FileSystemAdapter, 'getMediaMetadata'>,
): Promise<Project> {
  let assetsChanged = false;

  const assets = await Promise.all(project.assets.map(async (asset) => {
    if (!shouldHydrateImportedAssetMetadata(asset)) {
      return asset;
    }

    try {
      const mediaPath = asset.sourcePath ?? asset.url;
      const metadata = await fs.getMediaMetadata(mediaPath!);
      const hydratedAsset: Asset = {
        ...asset,
        duration: asset.duration ?? metadata.duration,
        width: asset.width ?? metadata.width,
        height: asset.height ?? metadata.height,
        audioChannels: asset.audioChannels ?? metadata.audioChannels,
        sampleRate: asset.sampleRate ?? metadata.sampleRate,
        mediaMetadataHydrated: true,
      };

      if (!areAssetMetadataFieldsEqual(asset, hydratedAsset)) {
        assetsChanged = true;
      }

      return hydratedAsset;
    } catch (_error) {
      // metadata is optional for imported assets — the asset is usable without it
      return asset;
    }
  }));

  return assetsChanged ? { ...project, assets } : project;
}

function buildImportedFragmentReferences(
  fragment: ImportedTimelineFragment,
  assetTypeById: Map<string, ImportedTimelineAsset['type']>,
) {
  if (!fragment.crop || !fragment.sourceAssetId) {
    return [];
  }

  return [{
    id: generateId(),
    assetId: fragment.sourceAssetId,
    type: assetTypeById.get(fragment.sourceAssetId) ?? 'video',
    cropRect: fragment.crop,
  }];
}

function shouldHydrateImportedAssetMetadata(asset: Asset): boolean {
  const mediaPath = asset.sourcePath ?? asset.url;
  if (!mediaPath) {
    return false;
  }

  return (asset.type === 'video' || asset.type === 'audio')
    && asset.mediaMetadataHydrated !== true;
}