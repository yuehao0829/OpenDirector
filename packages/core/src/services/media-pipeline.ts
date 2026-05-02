import type { Asset } from '../types/asset';
import type { AssetProcessRequest } from '../types/media-backend';
import type { FileSystemAdapter } from '../adapters/types';
import { tauriBridge } from './tauri-bridge';
import { toWebViewUrl } from '../utils/platform';
import { generateThumbnailForAsset } from './asset-import';

export interface MediaPipelineParams {
  inputPath: string;
  outputDir: string;
  processRequest: Omit<AssetProcessRequest, 'inputPath' | 'outputDir'>;
  assetType: Asset['type'];
  sourceAsset: Asset;
  nameSuffix: string;
  projectPath: string;
  fs: FileSystemAdapter;
}

export interface MediaPipelineResult {
  newAsset: Asset;
}

export async function runMediaPipeline(
  params: MediaPipelineParams,
): Promise<MediaPipelineResult> {
  const {
    inputPath, outputDir, processRequest,
    assetType, sourceAsset, nameSuffix,
    projectPath, fs,
  } = params;

  const result = await tauriBridge.mediaApi.process({
    ...processRequest,
    inputPath,
    outputDir,
  });

  if (!result?.outputPath) {
    throw new Error('Media processing returned no output path');
  }

  const outputFormat = processRequest.outputFormat;
  const ext = resolveExtension(assetType, outputFormat);
  const mimeType = resolveMimeType(assetType, outputFormat);
  const folderName = resolveFolderName(assetType);

  const newAssetId = crypto.randomUUID();
  const destRelativePath = `Assets/${folderName}/${newAssetId}.${ext}`;
  const destAbsolutePath = `${projectPath}/${destRelativePath}`;

  await fs.ensureDir(`${projectPath}/Assets/${folderName}`);
  await fs.moveFile(result.outputPath, destAbsolutePath);

  const fileSize = result.fileSize || await fs.getFileSize(destAbsolutePath);

  const metadataPromise = fs.getMediaMetadata(destAbsolutePath)
    .then(m => ({
      width: m.width,
      height: m.height,
      duration: m.duration,
      fps: m.frameRate,
      audioChannels: m.audioChannels,
      sampleRate: m.sampleRate,
      mediaMetadataHydrated: true,
    }))
    .catch(() => ({
      width: undefined,
      height: undefined,
      duration: undefined,
      fps: undefined,
      audioChannels: undefined,
      sampleRate: undefined,
      mediaMetadataHydrated: false,
    }));

  const thumbnailPromise = generateThumbnailForAsset(
    destAbsolutePath, fs, assetType, projectPath, newAssetId,
  );

  const [metadata, thumbnailResult] = await Promise.all([metadataPromise, thumbnailPromise]);

  return {
    newAsset: {
      id: newAssetId,
      name: `${sourceAsset.name} ${nameSuffix}`,
      type: assetType,
      source: 'original',
      url: toWebViewUrl(destAbsolutePath),
      relativePath: destRelativePath,
      fileSize,
      mimeType,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      fps: metadata.fps,
      audioChannels: metadata.audioChannels,
      sampleRate: metadata.sampleRate,
      mediaMetadataHydrated: metadata.mediaMetadataHydrated,
      thumbnailUrl: thumbnailResult.thumbnailUrl,
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function resolveExtension(assetType: Asset['type'], outputFormat?: string): string {
  if (outputFormat) {
    return outputFormat === 'jpeg' ? 'jpg' : outputFormat;
  }
  switch (assetType) {
    case 'image': return 'jpg';
    case 'video': return 'mp4';
    case 'audio': return 'wav';
    default: return 'mp4';
  }
}

function resolveMimeType(assetType: Asset['type'], outputFormat?: string): string {
  if (outputFormat) {
    return formatMimeType(outputFormat);
  }
  switch (assetType) {
    case 'image': return 'image/jpeg';
    case 'video': return 'video/mp4';
    case 'audio': return 'audio/wav';
    default: return 'video/mp4';
  }
}

function resolveFolderName(assetType: Asset['type']): string {
  switch (assetType) {
    case 'image': return 'Image';
    case 'video': return 'Video';
    case 'audio': return 'Audio';
    default: return 'Video';
  }
}

function formatMimeType(format: string): string {
  switch (format) {
    case 'mp4': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png': return 'image/png';
    default: return 'video/mp4';
  }
}

export function cropRectToAssetProcessParams(
  cropRect: { x: number; y: number; width: number; height: number } | undefined,
): Pick<Omit<AssetProcessRequest, 'inputPath' | 'outputDir'>, 'cropX' | 'cropY' | 'cropW' | 'cropH'> {
  if (!cropRect) return {};
  return {
    cropX: Math.max(0, cropRect.x),
    cropY: Math.max(0, cropRect.y),
    cropW: cropRect.width,
    cropH: cropRect.height,
  };
}
