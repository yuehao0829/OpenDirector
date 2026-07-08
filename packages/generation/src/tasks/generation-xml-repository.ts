/**
 * Generations XML Repository — XML read/write, project write lock,
 * and shared helpers for fragment context, content URL, and provider params.
 */

import { getPlatformAdapter } from '@opendirector/core/adapters';
import type { SeedanceContentItem } from '@opendirector/core/types/ai-video';
import type { ImageRole, Asset } from '@opendirector/core/types/asset';
import type { GenerationParams } from '@opendirector/core/types/generation';
import { getProviderPassword } from '@opendirector/core/types/provider-system';
import {
  serializeGenerationsFile,
  parseGenerationsFile,
  type GenerationRecord,
  type GenerationsFile,
  type GenerationProviderParams,
} from '@opendirector/core/utils/xml';
import { arrayBufferToText, textToArrayBuffer } from '@opendirector/core/utils/encoding';
import { generateId } from '@opendirector/core/utils/id';
import { taskLog } from './task-log';

// ── Constants ──

export const GENERATIONS_XML = 'Generations.xml';

export const GENERATED_VIDEO_DIR = 'Generated/Video';
export const GENERATED_IMAGE_DIR = 'Generated/Image';
export const GENERATED_AUDIO_DIR = 'Generated/Audio';
export const generatedVideoPath = (id: string) => `${GENERATED_VIDEO_DIR}/${id}.mp4`;
export const generatedImagePath = (id: string, extension = 'jpg') => `${GENERATED_IMAGE_DIR}/${id}.${extension}`;
export const generatedAudioPath = (id: string, extension = 'mp3') => `${GENERATED_AUDIO_DIR}/${id}.${extension}`;
export const formatGeneratedAssetName = (id: string) => `generation-${id.slice(0, 8)}.mp4`;
export const formatGeneratedImageName = (id: string, extension = 'jpg') => `generation-${id.slice(0, 8)}.${extension}`;
export const formatGeneratedAudioName = (id: string, extension = 'mp3') => `generation-${id.slice(0, 8)}.${extension}`;
export const fragmentDisplayName = (id: string) => `Fragment ${id.slice(0, 8)}`;

export function buildGeneratedAsset(params: {
  taskId: string;
  assetId: string;
  relativePath: string;
  fileSize: number;
  videoUrl: string;
  thumbnailUrl: string | undefined;
  duration: number | undefined;
  width: number | undefined;
  height: number | undefined;
  audioChannels?: number;
  sampleRate?: number;
  mediaMetadataHydrated?: boolean;
  projectId: string;
  outputType?: 'video' | 'image' | 'audio';
  mimeType?: string;
  fileExtension?: string;
}): Asset {
  const {
    assetId,
    taskId,
    relativePath,
    fileSize,
    videoUrl,
    thumbnailUrl,
    duration,
    width,
    height,
    audioChannels,
    sampleRate,
    mediaMetadataHydrated,
    projectId,
    outputType = 'video',
    mimeType,
    fileExtension,
  } = params;
  const isImage = outputType === 'image';
  const isAudio = outputType === 'audio';
  const imageExtension = fileExtension ?? mimeTypeToExtension(mimeType) ?? 'jpg';
  return {
    id: assetId,
    name: isImage
      ? formatGeneratedImageName(taskId, imageExtension)
      : isAudio
        ? formatGeneratedAudioName(taskId)
        : formatGeneratedAssetName(taskId),
    type: isImage ? 'image' : isAudio ? 'audio' : 'video',
    source: 'generated',
    url: videoUrl,
    relativePath,
    fileSize,
    mimeType: isImage ? (mimeType ?? 'image/jpeg') : isAudio ? (mimeType ?? 'audio/mpeg') : 'video/mp4',
    thumbnailUrl,
    duration: isImage ? undefined : duration,
    width,
    height,
    audioChannels: isImage ? undefined : audioChannels,
    sampleRate: isImage ? undefined : sampleRate,
    // Mark hydrated only when we actually obtained media metadata. If the completion-time
    // probe failed (duration undefined), leave it unhydrated so project load re-probes
    // instead of permanently caching an asset with no duration (which breaks GES preview
    // and exports). Images have no media streams, so they stay undefined.
    mediaMetadataHydrated:
      mediaMetadataHydrated ?? (isImage ? undefined : duration !== undefined),
    tags: [],
    favorite: false,
    usageCount: 0,
    projectId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function mimeTypeToExtension(mimeType: string | undefined): string | undefined {
  switch (mimeType) {
    case 'image/png':
    case 'png':
      return 'png';
    case 'image/webp':
    case 'webp':
      return 'webp';
    case 'image/jpeg':
    case 'jpeg':
    case 'jpg':
      return 'jpg';
    case 'audio/mpeg':
    case 'mp3':
      return 'mp3';
    case 'audio/wav':
    case 'wav':
      return 'wav';
    case 'audio/pcm':
    case 'pcm':
      return 'pcm';
    case 'audio/flac':
    case 'flac':
      return 'flac';
    default:
      return undefined;
  }
}

// ── Shared platform adapters ──

let cachedFs: Awaited<ReturnType<typeof getPlatformAdapter>>['fs'] | null = null;
let cachedDb: Awaited<ReturnType<typeof getPlatformAdapter>>['db'] | null = null;

export async function getFs() {
  if (!cachedFs) {
    const adapter = await getPlatformAdapter();
    cachedFs = adapter.fs ?? null;
  }
  return cachedFs;
}

export async function getDb() {
  if (!cachedDb) {
    const adapter = await getPlatformAdapter();
    cachedDb = adapter.db ?? null;
  }
  return cachedDb;
}

/** Extract the encrypted password from a provider instance config. */
export { getProviderPassword };

// ── Content URL helpers ──

export function getContentUrl(item: SeedanceContentItem): string {
  return item.image_url?.url ?? item.video_url?.url ?? item.audio_url?.url ?? '';
}

export function setContentUrl(item: SeedanceContentItem, url: string): void {
  if (item.type === 'video_url') item.video_url = { url };
  else if (item.type === 'audio_url') item.audio_url = { url };
  else item.image_url = { url };
}

// ── Path helpers ──

export function extractProjectPath(filePath: string): string | undefined {
  const marker = '/Generated/';
  const idx = filePath.lastIndexOf(marker);
  if (idx < 0) return undefined;
  return filePath.substring(0, idx);
}

export function resolveLocalFilePath(
  url: string,
  assets: Array<{ id: string; sourcePath?: string; relativePath?: string }>,
  folderPath: string,
): string | null {
  const asset = assets.find((a) => a.id === url);
  if (asset) {
    if (asset.sourcePath) return asset.sourcePath;
    if (asset.relativePath) return `${folderPath}/${asset.relativePath}`;
    return null;
  }
  if (!url.includes('://')) return url;
  return null;
}

// ── Fragment context ──

export interface FragmentContext {
  fragmentName?: string;
}

export function resolveFragmentContext(
  fragmentId: string,
): FragmentContext {
  return { fragmentName: fragmentDisplayName(fragmentId) };
}

// ── Provider params ──

/**
 * Build clean providerParams for XML storage — only includes provider-relevant
 * fields, not the full GenerationParams (which would duplicate prompt/references).
 */
export function buildProviderParams(modelId: string, params: GenerationParams, modelName?: string): GenerationProviderParams {
  return {
    model: modelId,
    ...(modelName ? { modelName } : {}),
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    generateAudio: params.generateAudio,
    generateWatermark: params.generateWatermark,
    style: params.style,
    negativePrompt: params.negativePrompt,
    imageSize: params.imageSize,
    imageQuality: params.imageQuality,
    imageOutputFormat: params.imageOutputFormat,
    imageBackground: params.imageBackground,
    imageModeration: params.imageModeration,
    imageOutputCompression: params.imageOutputCompression,
    // TTS (MiniMax)
    voiceId: params.voiceId,
    speed: params.speed,
    emotion: params.emotion,
    audioFormat: params.audioFormat,
    sampleRate: params.sampleRate,
  };
}

/**
 * Extract GenerationParams from a GenerationRecord's providerParams.
 * Used by restoreProcessingRecord to reconstruct task params from XML records.
 */
export function recordToParams(record: GenerationRecord): GenerationParams {
  const pp = record.providerParams;
  return {
    prompt: record.prompt,
    references: record.references.map((r) => ({
      id: generateId(),
      assetId: r.assetId,
      type: r.type,
      weight: r.weight,
      ...(r.role ? { role: r.role as ImageRole } : {}),
    })),
    duration: (pp.duration as number) ?? 5,
    aspectRatio: (pp.aspectRatio as string) ?? '16:9',
    resolution: pp.resolution as string | undefined,
    generateAudio: pp.generateAudio as boolean | undefined,
    generateWatermark: pp.generateWatermark as boolean | undefined,
    style: pp.style as string | undefined,
    negativePrompt: pp.negativePrompt as string | undefined,
    imageSize: pp.imageSize as string | undefined,
    imageQuality: pp.imageQuality as string | undefined,
    imageOutputFormat: pp.imageOutputFormat as string | undefined,
    imageBackground: pp.imageBackground as string | undefined,
    imageModeration: pp.imageModeration as string | undefined,
    imageOutputCompression: pp.imageOutputCompression as number | undefined,
    // TTS (MiniMax)
    voiceId: pp.voiceId as string | undefined,
    speed: pp.speed as number | undefined,
    emotion: pp.emotion as string | undefined,
    audioFormat: pp.audioFormat as string | undefined,
    sampleRate: pp.sampleRate as string | undefined,
  };
}

// ============================================================================
// Generations.xml read / write
// ============================================================================

/** Read and parse Generations.xml, returning undefined if missing or invalid. */
export async function readGenerationsFile(
  folderPath: string,
  fs: NonNullable<Awaited<ReturnType<typeof getPlatformAdapter>>['fs']>,
): Promise<GenerationsFile | undefined> {
  try {
    const data = await fs.readFile(`${folderPath}/${GENERATIONS_XML}`);
    return parseGenerationsFile(arrayBufferToText(data));
  } catch {
    return undefined;
  }
}

/** Write a GenerationsFile to disk. */
export async function writeGenerationsFile(
  folderPath: string,
  file: GenerationsFile,
  fs: NonNullable<Awaited<ReturnType<typeof getPlatformAdapter>>['fs']>,
): Promise<void> {
  const xml = serializeGenerationsFile(file);
  await fs.writeFile(`${folderPath}/${GENERATIONS_XML}`, textToArrayBuffer(xml));
}

// ── Per-folder write lock ──

const projectWriteLocks = new Map<string, Promise<void>>();

export async function withProjectWriteLock<T>(folderPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectWriteLocks.get(folderPath) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  projectWriteLocks.set(folderPath, next);
  await prev;
  try { return await fn(); }
  finally {
    resolve();
    // Clean up if no subsequent lock was queued
    if (projectWriteLocks.get(folderPath) === next) {
      projectWriteLocks.delete(folderPath);
    }
  }
}

export async function updateGenerationsXml(
  folderPath: string | undefined,
  generationId: string,
  updates: Partial<GenerationRecord>,
): Promise<boolean> {
  try {
    if (!folderPath) return false;

    return await withProjectWriteLock(folderPath, async () => {
      const fs = await getFs();
      if (!fs) return false;

      const file = (await readGenerationsFile(folderPath, fs)) ?? { generations: [] };

      const existingIdx = file.generations.findIndex((g) => g.id === generationId);
      if (existingIdx >= 0) {
        file.generations[existingIdx] = { ...file.generations[existingIdx], ...updates };
      } else {
        // No existing record — if updates contain enough fields to create a new record, append it
        if (updates.status && updates.prompt !== undefined && updates.providerInstanceId !== undefined) {
          const newRecord: GenerationRecord = {
            id: generationId,
            status: updates.status,
            prompt: updates.prompt,
            references: updates.references ?? [],
            providerInstanceId: updates.providerInstanceId,
            providerDisplayName: updates.providerDisplayName ?? '',
            providerParams: updates.providerParams ?? {},
            outputType: updates.outputType ?? 'video',
            isSelected: updates.isSelected ?? false,
            createdAt: updates.createdAt ?? new Date().toISOString(),
            ...updates,
          };
          file.generations.unshift(newRecord);
        } else {
          taskLog.warn(folderPath, 'gen_xml_not_found', 'Generation not found in XML and updates insufficient to create record', { generationId });
          return false;
        }
      }

      await writeGenerationsFile(folderPath, file, fs);
      return true;
    });
  } catch (error) {
    taskLog.warn(folderPath, 'gen_xml_write', 'Failed to update Generations.xml', { error: String(error) });
    return false;
  }
}

export async function readGenerationFromXml(
  folderPath: string,
  generationId: string,
  fs: NonNullable<Awaited<ReturnType<typeof getPlatformAdapter>>['fs']>,
): Promise<GenerationRecord | undefined> {
  const file = await readGenerationsFile(folderPath, fs);
  return file?.generations.find((g) => g.id === generationId);
}
