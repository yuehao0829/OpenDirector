/**
 * Reference Auto-Processor – Automatically compress/transcode reference assets
 * before TOS upload when they violate model constraints.
 *
 * All types processed via the shared media pipeline.
 */

import type { Asset, Reference } from '../types/asset';
import type { AssetProcessRequest } from '../types/media-backend';
import type { InputRequirements } from '../types/provider-system';
import { MAX_TOTAL_REFERENCE_SIZE } from '../types/provider-system';
import type { FileSystemAdapter } from '../adapters/types';
import { t } from '../i18n';
import { runMediaPipeline } from './media-pipeline';

/** Common constraint fields that may appear on any reference type. */
interface CommonConstraints {
  widthRange?: { min: number; max: number };
  heightRange?: { min: number; max: number };
  pixelCountRange?: { min: number; max: number };
  fpsRange?: { min: number; max: number };
  durationRange?: { min: number; max: number };
  maxFileSize?: number;
  allowedFormats?: string[];
}

export interface AutoProcessOptions {
  references: Reference[];
  getAsset: (assetId: string) => Asset | undefined;
  requirements: InputRequirements;
  projectPath: string;
  fs: FileSystemAdapter;
}

export interface AutoProcessResult {
  /** Map from old assetId to new assetId */
  assetIdMap: Map<string, string>;
  /** Newly created assets to register in the store */
  newAssets: Asset[];
}

interface ProcessingPlan {
  reference: Reference;
  asset: Asset;
  needsTranscode: boolean;
  targetFormat?: string;
  needsCompress: boolean;
  maxFileSize?: number;
  needsScale: boolean;
  maxWidth?: number;
  maxHeight?: number;
  needsFpsAdjust: boolean;
  targetFps?: number;
}

/**
 * Analyze references against requirements and auto-process (compress/transcode/scale)
 * those that can be automatically fixed. Returns an assetIdMap for replacement.
 */
export async function autoProcessReferences(options: AutoProcessOptions): Promise<AutoProcessResult> {
  const { references, getAsset, requirements, projectPath, fs } = options;
  const assetIdMap = new Map<string, string>();
  const newAssets: Asset[] = [];

  const constraints = requirements.referenceAssetConstraints;
  if (!constraints) return { assetIdMap, newAssets };

  // Build processing plans and accumulate total size in one pass
  const plans: ProcessingPlan[] = [];
  const plansByReferenceId = new Map<string, ProcessingPlan>();
  const refAssets: Array<{ ref: Reference; asset: Asset }> = [];
  let totalSize = 0;

  for (const ref of references) {
    const asset = getAsset(ref.assetId);
    if (!asset) continue;
    totalSize += asset.fileSize ?? 0;
    if (!asset.relativePath) continue;
    refAssets.push({ ref, asset });

    const typeConstraints = ref.type === 'image'
      ? constraints.image
      : ref.type === 'video'
        ? constraints.video
        : ref.type === 'audio'
          ? constraints.audio
          : undefined;
    if (!typeConstraints) continue;

    const plan: ProcessingPlan = { reference: ref, asset, needsTranscode: false, needsCompress: false, needsScale: false, needsFpsAdjust: false };

    if (typeConstraints.allowedFormats?.length && asset.mimeType && !typeConstraints.allowedFormats.includes(asset.mimeType)) {
      plan.needsTranscode = true;
      plan.targetFormat = determineTargetFormat(ref.type, typeConstraints.allowedFormats);
    }

    if (typeConstraints.maxFileSize && asset.fileSize && asset.fileSize > typeConstraints.maxFileSize) {
      plan.needsCompress = true;
      plan.maxFileSize = typeConstraints.maxFileSize;
    }

    const common = typeConstraints as unknown as CommonConstraints;
    const widthRange = common.widthRange;
    const heightRange = common.heightRange;
    const pixelCountRange = common.pixelCountRange;

    // Collect all candidate maxWidth/maxHeight from individual constraints,
    // then pick the tightest. This keeps resize requests explicit and stable.
    const candidatesW: number[] = [];
    const candidatesH: number[] = [];

    if (widthRange?.max && asset.width && asset.width > widthRange.max) {
      candidatesW.push(widthRange.max);
    }
    if (heightRange?.max && asset.height && asset.height > heightRange.max) {
      candidatesH.push(heightRange.max);
    }
    if (pixelCountRange?.max && asset.width && asset.height && asset.width * asset.height > pixelCountRange.max) {
      const ratio = asset.width / asset.height;
      const maxH = Math.floor(Math.sqrt(pixelCountRange.max / ratio));
      const maxW = Math.floor(maxH * ratio);
      candidatesW.push(maxW);
      candidatesH.push(maxH);
    }

    if (candidatesW.length > 0 || candidatesH.length > 0) {
      plan.needsScale = true;
      const tightestW = candidatesW.length > 0 ? Math.min(...candidatesW) : asset.width;
      const tightestH = candidatesH.length > 0 ? Math.min(...candidatesH) : asset.height;
      if (tightestW != null) plan.maxWidth = tightestW;
      if (tightestH != null) plan.maxHeight = tightestH;
    }

    const fpsRange = common.fpsRange;
    if (fpsRange?.max && asset.fps && asset.fps > fpsRange.max) {
      plan.needsFpsAdjust = true;
      plan.targetFps = fpsRange.max;
    }

    if (plan.needsTranscode || plan.needsCompress || plan.needsScale || plan.needsFpsAdjust) {
      plans.push(plan);
      plansByReferenceId.set(ref.id, plan);
    }
  }

  // Total size check — if total > 64MB, mark largest files for compression
  if (totalSize > MAX_TOTAL_REFERENCE_SIZE) {
    const sorted = [...refAssets].sort((a, b) => (b.asset.fileSize ?? 0) - (a.asset.fileSize ?? 0));

    let budget = MAX_TOTAL_REFERENCE_SIZE;
    for (const { ref, asset } of sorted) {
      if (budget <= 0) break;
      const fileSize = asset.fileSize ?? 0;
      if (fileSize <= 0) continue;

      const existingPlan = plansByReferenceId.get(ref.id);

      if (fileSize > budget) {
        const targetMaxSize = Math.min(budget, fileSize * 0.7);
        if (existingPlan) {
          if (!existingPlan.maxFileSize || targetMaxSize < existingPlan.maxFileSize) {
            existingPlan.maxFileSize = targetMaxSize;
          }
          existingPlan.needsCompress = true;
        } else {
          const plan = {
            reference: ref,
            asset,
            needsTranscode: false,
            needsCompress: true,
            maxFileSize: targetMaxSize,
            needsScale: false,
            needsFpsAdjust: false,
          };
          plans.push(plan);
          plansByReferenceId.set(ref.id, plan);
        }
        budget = 0;
      } else {
        budget -= fileSize;
      }
    }
  }

  // Execute processing plans in parallel (each processes a different asset).
  // De-duplicate against a process cache keyed by (source asset id + size +
  // processing signature): regenerating with the same over-limit reference
  // reuses the prior processed asset instead of re-transcoding and orphaning
  // duplicate files. Cached entries are validated via getAsset (the processed
  // asset may have been deleted by the user).
  const results = await Promise.allSettled(
    plans.map(async (plan) => {
      const cacheKey = `${plan.asset.id}:${plan.asset.fileSize ?? 0}:${planSignature(plan)}`;
      const cachedId = processCache.get(cacheKey);
      if (cachedId) {
        const cached = getAsset(cachedId);
        if (cached) {
          return { plan, newAsset: cached };
        }
        processCache.delete(cacheKey);
      }
      const newAsset = await processViaMediaPipeline(plan, projectPath, fs);
      processCache.set(cacheKey, newAsset.id);
      // Bound the cache so many distinct assets don't grow it without limit.
      if (processCache.size > 64) {
        const firstKey = processCache.keys().next().value;
        if (firstKey !== undefined) processCache.delete(firstKey);
      }
      return { plan, newAsset };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      assetIdMap.set(result.value.plan.asset.id, result.value.newAsset.id);
      newAssets.push(result.value.newAsset);
    } else {
      // individual reference processing failures are non-blocking — the batch continues
    }
  }

  return { assetIdMap, newAssets };
}

/** Build a stable signature of a processing plan's transformation parameters. */
function planSignature(plan: ProcessingPlan): string {
  const tr = plan.reference.trimRange;
  return [
    plan.needsTranscode ? `t:${plan.targetFormat ?? ''}` : '',
    plan.needsCompress ? `c:${plan.maxFileSize ?? ''}` : '',
    plan.needsScale ? `s:${plan.maxWidth ?? ''}x${plan.maxHeight ?? ''}` : '',
    plan.needsFpsAdjust ? `f:${plan.targetFps ?? ''}` : '',
    tr ? `tr:${tr.startMs ?? 0}-${tr.endMs ?? 0}` : '',
  ].join('|');
}

/** Reuse processed assets across regenerations: cacheKey → processedAssetId. */
const processCache = new Map<string, string>();

function determineTargetFormat(type: string, allowedFormats: string[]): string {
  if (type === 'video') {
    if (allowedFormats.includes('video/mp4')) return 'mp4';
    if (allowedFormats.includes('video/quicktime')) return 'mov';
    return 'mp4';
  }
  if (type === 'audio') {
    if (allowedFormats.includes('audio/mpeg')) return 'mp3';
    if (allowedFormats.includes('audio/wav')) return 'wav';
    return 'mp3';
  }
  if (type === 'image') {
    if (allowedFormats.includes('image/jpeg')) return 'jpeg';
    if (allowedFormats.includes('image/png')) return 'png';
    return 'jpeg';
  }
  return 'mp4';
}

async function processViaMediaPipeline(
  plan: ProcessingPlan,
  projectPath: string,
  fs: FileSystemAdapter,
): Promise<Asset> {
  const { asset, reference } = plan;
  if (!asset.relativePath) {
    throw new Error(`Asset ${asset.id} has no relativePath, cannot process`);
  }

  const inputPath = `${projectPath}/${asset.relativePath}`;
  const outputDir = `${projectPath}/Generated/Temp`;

  const isImage = asset.type === 'image';
  const outputFormat = plan.needsTranscode && plan.targetFormat
    ? plan.targetFormat
    : undefined;

  const mediaParams: Omit<AssetProcessRequest, 'inputPath' | 'outputDir'> = {
    trimStartMs: reference.trimRange?.startMs ?? undefined,
    trimEndMs: reference.trimRange?.endMs ?? undefined,
    maxWidth: plan.needsScale ? plan.maxWidth : undefined,
    maxHeight: plan.needsScale ? plan.maxHeight : undefined,
    maxFileSize: plan.needsCompress ? plan.maxFileSize : undefined,
    outputFormat: isImage ? 'jpeg' : outputFormat,
  };

  const suffixKey = plan.needsTranscode
    ? 'assetProcessing.transcodeSuffix'
    : plan.needsCompress
    ? 'assetProcessing.compressSuffix'
    : plan.needsScale
    ? 'assetProcessing.scaleSuffix'
    : 'assetProcessing.processSuffix';
  const suffix = t(suffixKey);

  const { newAsset } = await runMediaPipeline({
    inputPath,
    outputDir,
    processRequest: mediaParams,
    assetType: asset.type,
    sourceAsset: asset,
    nameSuffix: suffix,
    projectPath,
    fs,
  });

  return newAsset;
}
