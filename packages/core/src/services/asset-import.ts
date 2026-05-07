/**
 * Asset Import Service
 *
 * Handles importing assets into projects
 */

import type { Asset } from '../types/asset';
import type { AssetType, AssetSource } from '../types/persistence';
import type { MediaMetadata } from '../types/persistence';
import type { FileSystemAdapter } from '../adapters/types';
import { toWebViewUrl } from '../utils/platform';
import { getFileExtension } from '../utils/common';
import { generateId } from '../utils/id';

const IMPORT_METADATA_RETRY_DELAYS_MS = [0, 120, 300, 700] as const;
const IMPORT_THUMBNAIL_RETRY_DELAYS_MS = [0, 150, 400] as const;

// ============================================================================
// Types
// ============================================================================

export interface ImportOptions {
  projectPath: string;
  source?: AssetSource;
  copyToProject?: boolean;
}

export interface ImportProgress {
  total: number;
  completed: number;
  current: string;
  status: 'pending' | 'importing' | 'completed' | 'error';
  error?: string;
}

export interface ImportResult {
  asset: Asset;
  originalPath: string;
}

export interface ImportBatchOptions extends ImportOptions {
  onAssetImported?: ImportedAssetCallback;
}

type ProgressCallback = (progress: ImportProgress) => void;
type ImportedAssetCallback = (result: ImportResult) => void | Promise<void>;

// ============================================================================
// Asset Import
// ============================================================================

/**
 * Import a single asset file into the project
 */
export async function importAsset(
  sourcePath: string,
  fs: FileSystemAdapter,
  options: ImportOptions,
  onProgress?: ProgressCallback
): Promise<ImportResult> {
  const { projectPath, source, copyToProject = true } = options;

  onProgress?.({
    total: 1,
    completed: 0,
    current: sourcePath,
    status: 'importing',
  });

  try {
    // Determine asset type from file extension
    const assetType = detectAssetType(sourcePath);
    if (!assetType) {
      throw new Error(`Unsupported file type: ${sourcePath}`);
    }

    // Determine source if not provided
    const assetSource = source ?? 'original';

    // Get file info
    const fileName = sourcePath.split(/[/\\]/).pop() ?? 'unknown';
    const fileExt = getFileExtension(fileName);

    // Generate asset ID
    const assetId = generateId();

    // Copy file to project folder (if enabled)
    let relativePath: string;
    let absolutePath: string;
    let fileSize = 0;

    if (copyToProject) {
      const folderName = assetType.charAt(0).toUpperCase() + assetType.slice(1);

      relativePath = `Assets/${folderName}/${assetId}.${fileExt}`;
      absolutePath = `${projectPath}/${relativePath}`;

      // copyFile creates parent dirs and returns file size
      fileSize = await fs.copyFile(sourcePath, absolutePath);
    } else {
      relativePath = sourcePath;
      absolutePath = sourcePath;
    }

    // Get media metadata
    const metadata = await getAssetMetadata(absolutePath, fs, assetType, fileSize);

    // Convert path to a WebView-accessible URL.
    const webviewUrl = toWebViewUrl(absolutePath);

    // Create asset record
    const asset: Asset = {
      id: assetId,
      name: fileName,
      type: assetType,
      source: assetSource,
      url: webviewUrl,
      relativePath,
      sourcePath,
      fileSize: metadata.fileSize,
      mimeType: metadata.mimeType,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      fps: metadata.frameRate,
      audioChannels: metadata.audioChannels,
      sampleRate: metadata.sampleRate,
      mediaMetadataHydrated: metadata.mediaMetadataHydrated,
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Return asset immediately (without thumbnail)
    // Thumbnail will be generated asynchronously and applied later

    onProgress?.({
      total: 1,
      completed: 1,
      current: sourcePath,
      status: 'completed',
    });

    return { asset, originalPath: sourcePath };
  } catch (error) {
    onProgress?.({
      total: 1,
      completed: 0,
      current: sourcePath,
      status: 'error',
      error: String(error),
    });
    throw error;
  }
}

/**
 * Generate thumbnail for an already-imported asset and return the updated fields.
 * Returns `{ thumbnailUrl, waveformDataPath }` on success.
 * - video/image: thumbnailUrl is set to the WebView URL of the thumbnail image.
 * - audio: waveformDataPath is set to the absolute path of the .peak file.
 */
export async function generateThumbnailForAsset(
  absolutePath: string,
  fs: FileSystemAdapter,
  type: AssetType,
  projectPath: string,
  assetId: string,
  options?: {
    durationMs?: number;
  },
): Promise<{ thumbnailUrl: string | undefined; waveformDataPath: string | undefined }> {
  try {
    if (type === 'audio') {
      const peakPath = await generateAssetPeakData(absolutePath, fs, projectPath, assetId);
      return { thumbnailUrl: undefined, waveformDataPath: peakPath ?? undefined };
    }

    const thumbnailPath = await generateAssetThumbnail(
      absolutePath,
      fs,
      type,
      projectPath,
      assetId,
      options?.durationMs,
    );
    return {
      thumbnailUrl: thumbnailPath ? toWebViewUrl(thumbnailPath) : undefined,
      waveformDataPath: undefined,
    };
  } catch (error) {
    // thumbnails are optional — the asset is still usable without one
  }
  return { thumbnailUrl: undefined, waveformDataPath: undefined };
}

/**
 * Finish the async portion of an imported asset before exposing it to the UI.
 * This keeps drag/drop and thumbnails aligned with the final imported metadata.
 */
export async function completeImportedAsset(
  asset: Asset,
  absolutePath: string,
  fs: FileSystemAdapter,
  projectPath: string,
): Promise<Asset> {
  let completedAsset = asset;

  if (shouldRefreshImportedAssetMetadata(asset)) {
    const refreshedFields = await refreshImportedAssetMetadata(
      completedAsset,
      fs,
      projectPath,
      absolutePath,
    );
    if (Object.keys(refreshedFields).length > 0) {
      completedAsset = {
        ...completedAsset,
        ...refreshedFields,
      };
    }
  }

  const { thumbnailUrl, waveformDataPath } = await generateThumbnailForAsset(
    absolutePath,
    fs,
    completedAsset.type,
    projectPath,
    completedAsset.id,
    {
      durationMs: completedAsset.duration,
    },
  );

  if (!thumbnailUrl && !waveformDataPath) {
    return completedAsset;
  }

  return {
    ...completedAsset,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(waveformDataPath ? { waveformDataPath } : {}),
  };
}

export async function refreshImportedAssetMetadata(
  asset: Asset,
  fs: Pick<FileSystemAdapter, 'getMediaMetadata'>,
  projectPath?: string,
  absolutePath?: string,
): Promise<Partial<Asset>> {
  const resolvedAbsolutePath = absolutePath ?? resolveImportedAssetAbsolutePath(asset, projectPath);
  if (!resolvedAbsolutePath) {
    return {};
  }

  const metadata = await readImportedAssetMetadataWithRetry(
    resolvedAbsolutePath,
    fs,
    asset.type,
  );
  return metadata ? mapMediaMetadataToAssetFields(metadata) : {};
}

export function resolveImportedAssetAbsolutePath(
  asset: Pick<Asset, 'relativePath' | 'sourcePath'>,
  projectPath?: string,
): string | undefined {
  if (asset.relativePath) {
    if (isAbsoluteImportedAssetPath(asset.relativePath)) {
      return asset.relativePath;
    }

    if (projectPath) {
      return `${projectPath}/${asset.relativePath}`;
    }
  }

  return asset.sourcePath ?? undefined;
}

function isAbsoluteImportedAssetPath(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/.test(path);
}

/**
 * Import multiple asset files into the project
 */
export async function importMultipleAssets(
  sourcePaths: string[],
  fs: FileSystemAdapter,
  options: ImportBatchOptions,
  onProgress?: ProgressCallback
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  const total = sourcePaths.length;
  const { onAssetImported, ...importOptions } = options;

  for (let i = 0; i < sourcePaths.length; i++) {
    const sourcePath = sourcePaths[i]!;

    onProgress?.({
      total,
      completed: i,
      current: sourcePath,
      status: 'importing',
    });

    try {
      const result = await importAsset(sourcePath, fs, {
        ...importOptions,
        copyToProject: importOptions.copyToProject ?? true,
      });
      results.push(result);

      if (onAssetImported) {
        try {
          await onAssetImported(result);
        } catch (_error) {
          // callback failure must not block the batch import
        }
      }
    } catch (_error) {
      // Continue with other files
    }
  }

  onProgress?.({
    total,
    completed: total,
    current: '',
    status: 'completed',
  });

  return results;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect asset type from file path
 */
export function detectAssetType(path: string): AssetType | null {
  const ext = getFileExtension(path);

  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

  if (ext && videoExts.includes(ext)) return 'video';
  if (ext && imageExts.includes(ext)) return 'image';
  if (ext && audioExts.includes(ext)) return 'audio';

  return null;
}

/**
 * Get asset metadata
 */
async function getAssetMetadata(
  path: string,
  fs: FileSystemAdapter,
  _type: AssetType,
  knownFileSize: number = 0
): Promise<{
  fileSize: number;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  frameRate?: number;
  audioChannels?: number;
  sampleRate?: number;
  mediaMetadataHydrated: boolean;
}> {
  // Use known file size from copy, fallback to stat
  let fileSize = knownFileSize;
  if (!fileSize) {
    fileSize = await fs.getFileSize(path);
  }

  // Get MIME type from extension
  const ext = getFileExtension(path);
  const mimeType = getMimeType(ext);

  // Get media-specific metadata
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;
  let frameRate: number | undefined;
  let audioChannels: number | undefined;
  let sampleRate: number | undefined;
  let mediaMetadataHydrated = false;

  try {
    const metadata = await fs.getMediaMetadata(path);
    width = metadata.width;
    height = metadata.height;
    duration = metadata.duration;
    frameRate = metadata.frameRate;
    audioChannels = metadata.audioChannels;
    sampleRate = metadata.sampleRate;
    mediaMetadataHydrated = hasMeaningfulMediaMetadata(metadata);
  } catch (_error) {
    // metadata is optional — we fall back to whatever partial data we have
  }
  return {
    fileSize,
    mimeType,
    width,
    height,
    duration,
    frameRate,
    audioChannels,
    sampleRate,
    mediaMetadataHydrated,
  };
}

function hasMeaningfulMediaMetadata(metadata: MediaMetadata): boolean {
  return (metadata.duration ?? 0) > 0
    || (metadata.width ?? 0) > 0
    || (metadata.height ?? 0) > 0
    || (metadata.frameRate ?? 0) > 0
    || (metadata.audioChannels ?? 0) > 0
    || (metadata.sampleRate ?? 0) > 0;
}

function mapMediaMetadataToAssetFields(metadata: MediaMetadata): Partial<Asset> {
  const updates: Partial<Asset> = {};

  if ((metadata.duration ?? 0) > 0) {
    updates.duration = metadata.duration;
  }
  if ((metadata.width ?? 0) > 0) {
    updates.width = metadata.width;
  }
  if ((metadata.height ?? 0) > 0) {
    updates.height = metadata.height;
  }
  if ((metadata.frameRate ?? 0) > 0) {
    updates.fps = metadata.frameRate;
  }
  if ((metadata.audioChannels ?? 0) > 0) {
    updates.audioChannels = metadata.audioChannels;
  }
  if ((metadata.sampleRate ?? 0) > 0) {
    updates.sampleRate = metadata.sampleRate;
  }
  if (hasMeaningfulMediaMetadata(metadata)) {
    updates.mediaMetadataHydrated = true;
  }

  return updates;
}

function hasRequiredImportedMetadata(type: AssetType, metadata: MediaMetadata): boolean {
  switch (type) {
    case 'video':
      return (metadata.duration ?? 0) > 0
        && (metadata.width ?? 0) > 0
        && (metadata.height ?? 0) > 0;
    case 'audio':
      return (metadata.duration ?? 0) > 0
        && (metadata.audioChannels ?? 0) > 0
        && (metadata.sampleRate ?? 0) > 0;
    case 'image':
      return (metadata.width ?? 0) > 0
        && (metadata.height ?? 0) > 0;
    default:
      return false;
  }
}

function mergeImportedMediaMetadata(
  current: MediaMetadata | undefined,
  next: MediaMetadata,
): MediaMetadata {
  if (!current) {
    return { ...next };
  }

  return {
    duration: current.duration ?? next.duration,
    width: current.width ?? next.width,
    height: current.height ?? next.height,
    frameRate: current.frameRate ?? next.frameRate,
    audioChannels: current.audioChannels ?? next.audioChannels,
    sampleRate: current.sampleRate ?? next.sampleRate,
  };
}

async function readImportedAssetMetadataWithRetry(
  absolutePath: string,
  fs: Pick<FileSystemAdapter, 'getMediaMetadata'>,
  type: AssetType,
): Promise<MediaMetadata | undefined> {
  let bestMetadata: MediaMetadata | undefined;

  for (const delayMs of IMPORT_METADATA_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await wait(delayMs);
    }

    try {
      const metadata = await fs.getMediaMetadata(absolutePath);
      bestMetadata = mergeImportedMediaMetadata(bestMetadata, metadata);
      if (hasRequiredImportedMetadata(type, bestMetadata)) {
        return bestMetadata;
      }
    } catch {
      // transient I/O errors are expected during import — retry loop handles them
    }
  }

  if (bestMetadata && hasMeaningfulMediaMetadata(bestMetadata)) {
    return bestMetadata;
  }

  return undefined;
}

function shouldRefreshImportedAssetMetadata(asset: Asset): boolean {
  switch (asset.type) {
    case 'video':
      return asset.mediaMetadataHydrated !== true
        || (asset.duration ?? 0) <= 0
        || (asset.width ?? 0) <= 0
        || (asset.height ?? 0) <= 0;
    case 'audio':
      return asset.mediaMetadataHydrated !== true
        || (asset.duration ?? 0) <= 0
        || (asset.audioChannels ?? 0) <= 0
        || (asset.sampleRate ?? 0) <= 0;
    case 'image':
      return asset.mediaMetadataHydrated !== true
        || (asset.width ?? 0) <= 0
        || (asset.height ?? 0) <= 0;
    default:
      return false;
  }
}

/**
 * Get MIME type from extension
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    // Video
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    m4v: 'video/mp4',
    wmv: 'video/x-ms-wmv',
    // Image
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    aac: 'audio/aac',
  };

  return mimeTypes[ext] ?? 'application/octet-stream';
}

/**
 * Generate thumbnail for asset (video/image only)
 */
export async function generateAssetThumbnail(
  path: string,
  fs: FileSystemAdapter,
  type: AssetType,
  projectPath: string,
  assetId: string,
  durationMs?: number,
): Promise<string | undefined> {
  const thumbnailDir = `${projectPath}/Thumbnails`;
  await fs.ensureDir(thumbnailDir);

  if (type === 'video') {
    const outputPath = `${thumbnailDir}/${assetId}.jpg`;

    for (const timeSec of buildVideoThumbnailTimeCandidates(durationMs)) {
      for (const delayMs of IMPORT_THUMBNAIL_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await wait(delayMs);
        }

        try {
          return await fs.generateThumbnail(path, outputPath, timeSec);
        } catch {
          // thumbnail generation can fail transiently — the retry loop continues
        }
      }
    }

    // all attempts exhausted
    return undefined;
  }

  try {
    if (type === 'image') {
      const outputPath = `${thumbnailDir}/${assetId}.jpg`;
      const thumbnailPath = await fs.generateImageThumbnail(path, 512, outputPath);
      return thumbnailPath;
    }
  } catch (error) {
    // image thumbnails are optional — fall back to no thumbnail
  }

  return undefined;
}

export function resolveVideoThumbnailTimeSec(durationMs?: number): number {
  const normalizedDurationMs = durationMs ?? 0;
  if (normalizedDurationMs > 0) {
    return Math.min(1, Math.max(0.05, normalizedDurationMs / 2000));
  }

  return 0.1;
}

function buildVideoThumbnailTimeCandidates(durationMs?: number): number[] {
  const normalizedDurationMs = durationMs ?? 0;
  const maxSeekTime = normalizedDurationMs > 0
    ? Math.max(0, normalizedDurationMs / 1000 - 0.05)
    : undefined;
  const candidates = [
    resolveVideoThumbnailTimeSec(durationMs),
    maxSeekTime,
    0.05,
    0,
    maxSeekTime !== undefined ? Math.min(0.25, maxSeekTime) : 0.25,
    maxSeekTime !== undefined ? Math.min(0.5, maxSeekTime) : 0.5,
    maxSeekTime !== undefined ? Math.min(1, maxSeekTime) : 1,
  ];

  const seen = new Set<number>();
  const uniqueCandidates: number[] = [];
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate) || candidate === undefined || candidate < 0) {
      continue;
    }
    const rounded = Number(candidate.toFixed(3));
    if (seen.has(rounded)) {
      continue;
    }
    seen.add(rounded);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate peak data file for an audio asset.
 * Output: {projectPath}/Thumbnails/{assetId}.peak
 */
export async function generateAssetPeakData(
  path: string,
  fs: FileSystemAdapter,
  projectPath: string,
  assetId: string
): Promise<string | undefined> {
  const thumbnailDir = `${projectPath}/Thumbnails`;
  await fs.ensureDir(thumbnailDir);

  try {
    const outputPath = `${thumbnailDir}/${assetId}.peak`;
    return await fs.generateAudioPeakData(path, outputPath);
  } catch (_error) {
    // waveform peak data is optional — audio playback works without it
  }

  return undefined;
}

/**
 * Get supported file extensions
 */
export function getSupportedExtensions(): string[] {
  return [
    // Video
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv',
    // Image
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg',
    // Audio
    'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac',
  ];
}

/**
 * Check if file is supported
 */
export function isSupportedFile(path: string): boolean {
  return detectAssetType(path) !== null;
}

/**
 * Check if an asset's physical files exist on disk.
 * Returns true if the imported source file is missing from the project folder.
 */
export async function isAssetOffline(
  asset: Asset,
  projectPath: string,
  fs: FileSystemAdapter
): Promise<boolean> {
  // No relative path means no physical file to check
  if (!asset.relativePath) return false;

  // Only check the source file in the project folder.
  // Thumbnails and peak data are optional (generated asynchronously),
  // so their absence does not mean the asset is offline.
  const sourceExists = await fs.exists(`${projectPath}/${asset.relativePath}`);
  return !sourceExists;
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('not found') || message.includes('no such file');
}

async function deleteFileIfPresent(fs: FileSystemAdapter, path: string): Promise<void> {
  try {
    await fs.deleteFile(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Delete physical files associated with an asset (source file, thumbnail, peak data).
 */
export async function deleteAssetFiles(
  asset: Asset,
  fs: FileSystemAdapter,
  projectPath: string
): Promise<void> {
  // 1. Delete source file
  if (asset.relativePath) {
    const filePath = `${projectPath}/${asset.relativePath}`;
    await deleteFileIfPresent(fs, filePath);
  }

  // 2. Delete thumbnail (video/image)
  if (asset.type !== 'audio') {
    const thumbPath = `${projectPath}/Thumbnails/${asset.id}.jpg`;
    await deleteFileIfPresent(fs, thumbPath);
  }

  // 3. Delete audio peak data
  if (asset.type === 'audio') {
    const peakPath = `${projectPath}/Thumbnails/${asset.id}.peak`;
    await deleteFileIfPresent(fs, peakPath);
  }
}
