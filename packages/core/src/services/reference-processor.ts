/**
 * Reference Processor – Apply crop/trim to reference assets.
 *
 * All types processed via the shared media pipeline:
 * 1. Backend crops/pads images, or trims/crops video/audio
 * 2. Writes the processed file to the project directory
 * 3. Creates a new Asset record
 */

import type { Asset, Reference } from '../types/asset';
import type { FileSystemAdapter } from '../adapters/types';
import { t } from '../i18n';
import type { AssetProcessRequest } from '../types/media-backend';
import { runMediaPipeline, cropRectToAssetProcessParams } from './media-pipeline';

export interface ApplyReferenceOptions {
  asset: Asset;
  reference: Reference;
  projectPath: string;
  targetAspectRatio?: string | null;
  fs: FileSystemAdapter;
}

export interface ApplyReferenceResult {
  newAsset: Asset;
}

/**
 * Apply crop/trim to a reference and produce a new physical file + Asset.
 */
export async function applyReference(
  options: ApplyReferenceOptions,
): Promise<ApplyReferenceResult> {
  const { asset, reference, projectPath, fs, targetAspectRatio } = options;

  if (!asset.relativePath) {
    throw new Error(`Asset ${asset.id} has no relativePath, cannot process`);
  }

  const inputPath = `${projectPath}/${asset.relativePath}`;
  const outputDir = `${projectPath}/Assets/Processed`;

  const arParam = targetAspectRatio && targetAspectRatio !== 'adaptive'
    ? targetAspectRatio
    : undefined;

  const mediaParams: Omit<AssetProcessRequest, 'inputPath' | 'outputDir'> = {
    ...cropRectToAssetProcessParams(reference.cropRect),
    targetAspectRatio: arParam,
  };

  if (asset.type === 'image') {
    mediaParams.outputFormat = 'jpeg';
    return runMediaPipeline({
      inputPath, outputDir, processRequest: mediaParams,
      assetType: 'image', sourceAsset: asset, nameSuffix: t('assetProcessing.cropSuffix'),
      projectPath, fs,
    });
  }

  // Video/Audio: include trim range
  mediaParams.trimStartMs = reference.trimRange?.startMs ?? undefined;
  mediaParams.trimEndMs = reference.trimRange?.endMs ?? undefined;

  return runMediaPipeline({
    inputPath, outputDir, processRequest: mediaParams,
    assetType: asset.type, sourceAsset: asset, nameSuffix: t('assetProcessing.trimSuffix'),
    projectPath, fs,
  });
}
