import type { FileSystemAdapter } from '../adapters/types';
import type { Asset } from '../types/asset';
import type { Project } from '../types/project';
import { assetToRecord, serializeAssetsFile } from '../utils/xml';
import { textToArrayBuffer } from '../utils/encoding';
import { resolveProjectAssetPath } from './otio-io';
import { ASSETS_XML_FILENAME } from './project-io';

const REQUIRED_FIELDS_BY_TYPE: Partial<Record<Asset['type'], (keyof Asset)[]>> = {
  video: ['audioChannels'],
  audio: ['duration'],
};

export function buildReferencedAssetIds(project: Project): Set<string> {
  return new Set(
    project.fragments
      .map((fragment) => fragment.sourceAssetId ?? fragment.resultAssetId)
      .filter((assetId): assetId is string => !!assetId),
  );
}

export async function hydrateProjectVideoSourceAudioMetadata(
  project: Project,
  fs: Pick<FileSystemAdapter, 'getMediaMetadata'>,
  referencedAssetIds: Set<string> = buildReferencedAssetIds(project),
): Promise<Project> {
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

export function projectNeedsVideoSourceAudioMetadataHydration(
  project: Project,
  referencedAssetIds: Set<string> = buildReferencedAssetIds(project),
): boolean {
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

/**
 * Whether an asset's media metadata still needs to be hydrated on project load.
 *
 * - Video assets: re-probe when audio channels are missing (needed for mixing/export).
 * - Audio assets (e.g. MiniMax TTS output): re-probe when duration is missing (drives
 *   preview/export and GES clip sizing). A dragged-in wav that already carries duration
 *   is left alone even if channels are absent.
 *
 * Generated assets can be persisted before their metadata was probed (the probe ran at
 * completion time and may have failed transiently); re-hydrating on load fills the gaps.
 */
function shouldHydrateProjectVideoSourceAudioAsset(
  asset: Asset,
  referencedAssetIds: Set<string>,
): boolean {
  if (!referencedAssetIds.has(asset.id) || asset.mediaMetadataHydrated === true) {
    return false;
  }
  const required = REQUIRED_FIELDS_BY_TYPE[asset.type];
  return required ? required.some((field) => asset[field] === undefined) : false;
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
