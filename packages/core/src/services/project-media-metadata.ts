import type { FileSystemAdapter } from '../adapters/types';
import type { Asset } from '../types/asset';
import type { Project } from '../types/project';
import { assetToRecord, serializeAssetsFile } from '../utils/xml';
import { textToArrayBuffer } from '../utils/encoding';
import { resolveProjectAssetPath } from './otio-io';
import { ASSETS_XML_FILENAME } from './project-io';

export async function hydrateProjectVideoSourceAudioMetadata(
  project: Project,
  fs: Pick<FileSystemAdapter, 'getMediaMetadata'>,
): Promise<Project> {
  const referencedAssetIds = new Set(
    project.fragments
      .map((fragment) => fragment.sourceAssetId ?? fragment.resultAssetId)
      .filter((assetId): assetId is string => !!assetId),
  );

  let assetsChanged = false;

  const assets = await Promise.all(project.assets.map(async (asset) => {
    if (!shouldHydrateProjectVideoSourceAudioAsset(asset, referencedAssetIds)) {
      return asset;
    }

    const mediaPath = resolveProjectAssetPath(project, asset);
    if (!mediaPath) {
      return asset;
    }

    try {
      const metadata = await fs.getMediaMetadata(mediaPath);
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
    } catch (error) {
      console.warn(
        `[project-media-metadata] Failed to read media metadata for ${asset.id}:`,
        error,
      );
      return asset;
    }
  }));

  return assetsChanged ? { ...project, assets } : project;
}

export function projectNeedsVideoSourceAudioMetadataHydration(project: Project): boolean {
  const referencedAssetIds = new Set(
    project.fragments
      .map((fragment) => fragment.sourceAssetId ?? fragment.resultAssetId)
      .filter((assetId): assetId is string => !!assetId),
  );

  return project.assets.some((asset) =>
    shouldHydrateProjectVideoSourceAudioAsset(asset, referencedAssetIds),
  );
}

export function mergeProjectAssetMetadata(
  assets: Asset[],
  hydratedAssets: Asset[],
): Asset[] {
  const hydratedAssetById = new Map(hydratedAssets.map((asset) => [asset.id, asset]));
  let assetsChanged = false;

  const mergedAssets = assets.map((asset) => {
    const hydratedAsset = hydratedAssetById.get(asset.id);
    if (!hydratedAsset || areAssetMetadataFieldsEqual(asset, hydratedAsset)) {
      return asset;
    }

    assetsChanged = true;
    return {
      ...asset,
      duration: hydratedAsset.duration,
      width: hydratedAsset.width,
      height: hydratedAsset.height,
      audioChannels: hydratedAsset.audioChannels,
      sampleRate: hydratedAsset.sampleRate,
      mediaMetadataHydrated: hydratedAsset.mediaMetadataHydrated,
    };
  });

  return assetsChanged ? mergedAssets : assets;
}

export async function persistProjectAssetsFile(
  project: Pick<Project, 'assets' | 'folderPath'>,
  fs: Pick<FileSystemAdapter, 'writeFile'>,
): Promise<void> {
  if (!project.folderPath) {
    return;
  }

  await fs.writeFile(
    `${project.folderPath}/${ASSETS_XML_FILENAME}`,
    textToArrayBuffer(
      serializeAssetsFile({
        assets: project.assets.map(assetToRecord),
      }),
    ),
  );
}

function shouldHydrateProjectVideoSourceAudioAsset(
  asset: Asset,
  referencedAssetIds: Set<string>,
): boolean {
  return asset.type === 'video'
    && referencedAssetIds.has(asset.id)
    && asset.audioChannels === undefined
    && asset.mediaMetadataHydrated !== true;
}

export function areAssetMetadataFieldsEqual(left: Asset, right: Asset): boolean {
  return (
    left.duration === right.duration
    && left.width === right.width
    && left.height === right.height
    && left.audioChannels === right.audioChannels
    && left.sampleRate === right.sampleRate
    && left.mediaMetadataHydrated === right.mediaMetadataHydrated
  );
}
