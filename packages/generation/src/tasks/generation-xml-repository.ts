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

// ── Constants ──

export const GENERATIONS_XML = 'Generations.xml';

export const GENERATED_VIDEO_DIR = 'Generated/Video';
export const GENERATED_IMAGE_DIR = 'Generated/Image';
export const generatedVideoPath = (id: string) => `${GENERATED_VIDEO_DIR}/${id}.mp4`;
export const generatedImagePath = (id: string) => `${GENERATED_IMAGE_DIR}/${id}.jpg`;
export const formatGeneratedAssetName = (id: string) => `generation-${id.slice(0, 8)}.mp4`;
export const formatGeneratedImageName = (id: string) => `generation-${id.slice(0, 8)}.jpg`;
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
  outputType?: 'video' | 'image';
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
  } = params;
  const isImage = outputType === 'image';
  return {
    id: assetId,
    name: isImage ? formatGeneratedImageName(taskId) : formatGeneratedAssetName(taskId),
    type: isImage ? 'image' : 'video',
    source: 'generated',
    url: videoUrl,
    relativePath,
    fileSize,
    mimeType: isImage ? 'image/jpeg' : 'video/mp4',
    thumbnailUrl,
    duration: isImage ? undefined : duration,
    width,
    height,
    audioChannels: isImage ? undefined : audioChannels,
    sampleRate: isImage ? undefined : sampleRate,
    mediaMetadataHydrated: mediaMetadataHydrated ?? (isImage ? undefined : true),
    tags: [],
    favorite: false,
    usageCount: 0,
    projectId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
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
      id: crypto.randomUUID(),
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
    return parseGenerationsFile(new TextDecoder().decode(data));
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
  await fs.writeFile(`${folderPath}/${GENERATIONS_XML}`, new TextEncoder().encode(xml).buffer as ArrayBuffer);
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
          console.warn(`[TaskBridge] updateGenerationsXml: generation ${generationId} not found in XML and updates insufficient to create record — skipping write`);
          return false;
        }
      }

      await writeGenerationsFile(folderPath, file, fs);
      return true;
    });
  } catch (error) {
    console.warn('[TaskBridge] Failed to update Generations.xml:', error);
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
