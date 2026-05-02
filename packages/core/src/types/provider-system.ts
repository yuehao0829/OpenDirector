/**
 * Provider system types — hierarchical provider/model architecture.
 *
 * Layer 1: ProviderTypeDefinition (blueprint) — what a provider *can* do
 * Layer 2: ProviderInstance (user config) — a configured instance referencing a type
 * Layer 3: Fragment.providerSelection — per-fragment selection of instance + model
 */

import type { Asset, Reference } from './asset';
import { getEffectiveImageRole } from './asset';
import { getProviderTypeRegistry } from '../services/service-locator';
import { computeVisibleCropSize } from '../utils/crop';

// ── Constraint Indicator Types ──

/** Total request body size limit (sum of all reference asset sizes) */
export const MAX_TOTAL_REFERENCE_SIZE = 64 * 1024 * 1024; // 64MB

export type ConstraintIndicatorType =
  | 'format_not_supported'    // Format not supported → auto transcode
  | 'pixel_over_limit'        // Pixel/dimension exceeds limit → auto scale
  | 'fps_over_limit'          // Frame rate exceeds limit → auto adjust via media pipeline
  | 'size_over_limit'         // File size exceeds limit → auto compress
  | 'aspect_ratio_over_limit' // Aspect ratio exceeds limit → error, needs manual crop
  | 'duration_over_limit';    // Duration exceeds limit → error, needs manual trim

/** Canonical display order for indicator types — keeps indicator order stable regardless of which violation triggered it. */
const INDICATOR_TYPE_ORDER: ConstraintIndicatorType[] = [
  'format_not_supported',
  'pixel_over_limit',
  'fps_over_limit',
  'size_over_limit',
  'aspect_ratio_over_limit',
  'duration_over_limit',
];

export interface ConstraintIndicator {
  type: ConstraintIndicatorType;
  label: string;
  severity: 'error' | 'warning';
}

export interface ReferenceIndicatorsResult {
  indicators: Map<string, ConstraintIndicator[]>;
  hasErrors: boolean;
}

// ── Constraint Violation (internal) ──

interface ConstraintViolation {
  kind: 'format' | 'size' | 'pixel' | 'duration' | 'aspect_ratio' | 'fps' | 'width' | 'height';
  message: string;
  autoFixable: boolean;
}

// ── Core Enums ──

export type ProviderType = 'generation' | 'asset';

export const BUILTIN_TYPE_IDS = {
  VOLCENGINE: 'volcengine',
  SEEDANCE: 'seedance',
} as const;

// ── Capability Definitions ──

export interface InputRequirements {
  promptRequired: boolean;
  maxPromptLength?: number;
  /** Soft suggestions for prompt — produce warnings instead of blocking errors. */
  promptSuggestions?: Array<{
    type: 'maxChineseChars' | 'maxEnglishWords';
    limit: number;
    message: string;
  }>;
  references: {
    image?: { required: boolean; min?: number; max?: number; description?: string };
    video?: { required: boolean; min?: number; max?: number; description?: string };
    audio?: { required: boolean; min?: number; max?: number; description?: string };
    maxTotal?: number;
  };
  /** Constraints on individual reference assets at generation time (format, dimensions, size). */
  referenceAssetConstraints?: {
    image?: {
      /** Allowed MIME types (e.g. ['image/jpeg', 'image/png']). */
      allowedFormats?: string[];
      /** Min/max width in pixels. */
      widthRange?: { min: number; max: number };
      /** Min/max height in pixels. */
      heightRange?: { min: number; max: number };
      /** Min/max aspect ratio (width/height). */
      aspectRatioRange?: { min: number; max: number };
      /** Max file size per image in bytes. */
      maxFileSize?: number;
    };
    video?: {
      /** Allowed MIME types (e.g. ['video/mp4', 'video/quicktime']). */
      allowedFormats?: string[];
      /** Min/max duration per video in seconds. */
      durationRange?: { min: number; max: number };
      /** Max total duration across all reference videos in seconds. */
      maxTotalDuration?: number;
      /** Min/max width in pixels. */
      widthRange?: { min: number; max: number };
      /** Min/max height in pixels. */
      heightRange?: { min: number; max: number };
      /** Min/max aspect ratio (width/height). */
      aspectRatioRange?: { min: number; max: number };
      /** Min/max total pixel count (width × height). */
      pixelCountRange?: { min: number; max: number };
      /** Max file size per video in bytes. */
      maxFileSize?: number;
      /** Min/max frame rate (FPS). */
      fpsRange?: { min: number; max: number };
    };
    audio?: {
      /** Allowed MIME types (e.g. ['audio/mpeg', 'audio/wav']). */
      allowedFormats?: string[];
      /** Max file size per audio in bytes. */
      maxFileSize?: number;
      /** Min/max duration per audio in seconds. */
      durationRange?: { min: number; max: number };
      /** Max total duration across all reference audios in seconds. */
      maxTotalDuration?: number;
    };
  };
  /** Cross-reference constraints evaluated after per-type checks. */
  crossConstraints?: Array<{
    rule: 'require_non_audio_reference';
    message: string;
  }>;
  extraInputs?: Array<{
    id: string;
    name: string;
    type: 'text' | 'number' | 'boolean' | 'select';
    required: boolean;
    defaultValue?: unknown;
    options?: { value: string; label: string }[];
    description?: string;
  }>;
}

/** Compute effective asset dimensions/duration/size accounting for crop/trim. */
function computeEffectiveAsset(asset: Asset, ref: Reference): Asset {
  if (!ref.cropRect && !ref.trimRange) return asset;
  const effective = { ...asset };
  if (ref.cropRect && asset.width && asset.height) {
    const { visibleW, visibleH } = computeVisibleCropSize(ref.cropRect);
    effective.width = Math.round(asset.width * visibleW);
    effective.height = Math.round(asset.height * visibleH);
    effective.fileSize = Math.round(asset.fileSize * visibleW * visibleH);
  }
  if (ref.trimRange && asset.duration !== undefined) {
    effective.duration = ref.trimRange.endMs - ref.trimRange.startMs;
  }
  return effective;
}

/**
 * Validate input (prompt + references) against model InputRequirements.
 * Used by the UI before submitting a generation task.
 */
export function validateInputRequirements(
  input: {
    prompt?: string;
    references?: Reference[];
    /** Asset metadata lookup by assetId, used for reference asset constraint checks. */
    getAsset?: (assetId: string) => Asset | undefined;
  },
  requirements?: InputRequirements,
): { valid: boolean; errors: string[]; promptWarnings: string[]; warnings: string[] } {
  if (!requirements) return { valid: true, errors: [], promptWarnings: [], warnings: [] };

  const errors: string[] = [];
  const promptWarnings: string[] = [];
  const warnings: string[] = [];
  const prompt = input.prompt?.trim() ?? '';
  const references = input.references ?? [];

  // Prompt checks
  if (requirements.promptRequired && !prompt) {
    errors.push('提示词不能为空');
  }
  if (requirements.maxPromptLength && prompt.length > requirements.maxPromptLength) {
    errors.push(`提示词长度超出限制: ${prompt.length} > ${requirements.maxPromptLength}`);
  }

  // Prompt suggestion checks (warnings, not blocking)
  if (requirements.promptSuggestions) {
    for (const suggestion of requirements.promptSuggestions) {
      if (suggestion.type === 'maxChineseChars') {
        const chineseChars = prompt.match(/[\u4e00-\u9fff]/g);
        if (chineseChars && chineseChars.length > suggestion.limit) {
          promptWarnings.push(suggestion.message);
        }
      } else if (suggestion.type === 'maxEnglishWords') {
        const englishWords = prompt.match(/[a-zA-Z]+(?:['-][a-zA-Z]+)*/g);
        if (englishWords && englishWords.length > suggestion.limit) {
          promptWarnings.push(suggestion.message);
        }
      }
    }
  }

  // Per-type reference checks
  const typeCounts: Record<string, number> = {};
  for (const ref of references) {
    typeCounts[ref.type] = (typeCounts[ref.type] ?? 0) + 1;
  }

  for (const [refType, constraint] of Object.entries(requirements.references)) {
    if (typeof constraint !== 'object' || constraint === null) continue;
    const count = typeCounts[refType] ?? 0;
    if (constraint.required && count === 0) {
      errors.push(`需要至少一个${refType}参考素材`);
    }
    if (constraint.min !== undefined && count < constraint.min) {
      errors.push(`${refType}参考素材数量不足: ${count} < ${constraint.min}`);
    }
    if (constraint.max !== undefined && count > constraint.max) {
      errors.push(`${refType}参考素材数量超出限制: ${count} > ${constraint.max}`);
    }
  }

  // Total reference count check
  if (requirements.references.maxTotal !== undefined) {
    if (references.length > requirements.references.maxTotal) {
      errors.push(`参考素材总数超出限制: ${references.length} > ${requirements.references.maxTotal}`);
    }
  }

  // Reference asset constraints: total duration and total size checks
  if (requirements.referenceAssetConstraints && input.getAsset) {
    let totalVideoDurationMs = 0;
    let totalAudioDurationMs = 0;
    let totalRefSize = 0;

    for (const ref of references) {
      const asset = input.getAsset(ref.assetId);
      if (!asset) continue;
      const effectiveAsset = computeEffectiveAsset(asset, ref);

      if (ref.type === 'video' && effectiveAsset.duration !== undefined) {
        totalVideoDurationMs += effectiveAsset.duration;
      }
      if (ref.type === 'audio' && effectiveAsset.duration !== undefined) {
        totalAudioDurationMs += effectiveAsset.duration;
      }
      if (effectiveAsset.fileSize) {
        totalRefSize += effectiveAsset.fileSize;
      }
    }

    const vidConstraints = requirements.referenceAssetConstraints.video;
    if (vidConstraints?.maxTotalDuration) {
      const totalDurationSec = totalVideoDurationMs / 1000;
      if (totalDurationSec > vidConstraints.maxTotalDuration) {
        errors.push(`参考视频总时长超出限制: ${totalDurationSec.toFixed(1)}s > ${vidConstraints.maxTotalDuration}s`);
      }
    }

    const audioConstraints = requirements.referenceAssetConstraints.audio;
    if (audioConstraints?.maxTotalDuration) {
      const totalDurationSec = totalAudioDurationMs / 1000;
      if (totalDurationSec > audioConstraints.maxTotalDuration) {
        errors.push(`参考音频总时长超出限制: ${totalDurationSec.toFixed(1)}s > ${audioConstraints.maxTotalDuration}s`);
      }
    }

    if (totalRefSize > MAX_TOTAL_REFERENCE_SIZE) {
      warnings.push(`参考素材总体积超限: ${(totalRefSize / 1024 / 1024).toFixed(1)}MB > ${MAX_TOTAL_REFERENCE_SIZE / 1024 / 1024}MB，将从最大文件开始压缩`);
    }
  }

  // Cross-reference constraints (only apply when references are present)
  if (requirements.crossConstraints && references.length > 0) {
    for (const cc of requirements.crossConstraints) {
      if (cc.rule === 'require_non_audio_reference') {
        const nonAudioCount = references.filter((r) => r.type !== 'audio').length;
        if (nonAudioCount === 0) {
          errors.push(cc.message);
        }
      }
    }
  }

  // Image role mutual exclusion validation
  const imageRefs = references.filter((r) => r.type === 'image');
  if (imageRefs.some((r) => r.role && r.role !== 'reference_image')) {
    let firstFrameCount = 0;
    let lastFrameCount = 0;
    let refImageCount = 0;
    for (const r of imageRefs) {
      const effectiveRole = getEffectiveImageRole(r);
      if (effectiveRole === 'first_frame') firstFrameCount++;
      else if (effectiveRole === 'last_frame') lastFrameCount++;
      else refImageCount++;
    }

    if ((firstFrameCount > 0 || lastFrameCount > 0) && refImageCount > 0) {
      errors.push('首帧/尾帧与参考图不能同时使用');
    }
    if (lastFrameCount > 0 && firstFrameCount === 0) {
      errors.push('指定尾帧需要先指定首帧图片');
    }
    if (firstFrameCount > 1) {
      errors.push('只能指定一张首帧图片');
    }
    if (lastFrameCount > 1) {
      errors.push('只能指定一张尾帧图片');
    }
  }

  return { valid: errors.length === 0, errors, promptWarnings, warnings };
}

/**
 * Classify media constraint violations into structured results.
 * Returns violations with autoFixable flag to distinguish errors from warnings.
 */
function classifyMediaConstraints(
  label: string,
  asset: Asset,
  c: { allowedFormats?: string[]; widthRange?: { min: number; max: number }; heightRange?: { min: number; max: number }; aspectRatioRange?: { min: number; max: number }; maxFileSize?: number } & Record<string, unknown>,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  if (c.allowedFormats?.length) {
    if (asset.mimeType && !c.allowedFormats.includes(asset.mimeType)) {
      violations.push({
        kind: 'format',
        message: `「${label}」格式不支持: ${asset.mimeType}，需要: ${c.allowedFormats.join('、')}`,
        autoFixable: true,
      });
    }
  }

  if (c.widthRange && asset.width !== undefined) {
    if (asset.width < c.widthRange.min) {
      violations.push({
        kind: 'width',
        message: `「${label}」宽度过小: ${asset.width}px < ${c.widthRange.min}px`,
        autoFixable: false, // Cannot upscale reliably
      });
    }
    if (asset.width > c.widthRange.max) {
      violations.push({
        kind: 'width',
        message: `「${label}」宽度过大: ${asset.width}px > ${c.widthRange.max}px`,
        autoFixable: true,
      });
    }
  }

  if (c.heightRange && asset.height !== undefined) {
    if (asset.height < c.heightRange.min) {
      violations.push({
        kind: 'height',
        message: `「${label}」高度过小: ${asset.height}px < ${c.heightRange.min}px`,
        autoFixable: false,
      });
    }
    if (asset.height > c.heightRange.max) {
      violations.push({
        kind: 'height',
        message: `「${label}」高度过大: ${asset.height}px > ${c.heightRange.max}px`,
        autoFixable: true,
      });
    }
  }

  if (c.aspectRatioRange && asset.width && asset.height) {
    const ratio = asset.width / asset.height;
    if (ratio < c.aspectRatioRange.min) {
      violations.push({
        kind: 'aspect_ratio',
        message: `「${label}」宽高比过小: ${ratio.toFixed(2)} < ${c.aspectRatioRange.min}，建议裁剪或调整`,
        autoFixable: false,
      });
    }
    if (ratio > c.aspectRatioRange.max) {
      violations.push({
        kind: 'aspect_ratio',
        message: `「${label}」宽高比过大: ${ratio.toFixed(2)} > ${c.aspectRatioRange.max}，建议裁剪或调整`,
        autoFixable: false,
      });
    }
  }

  if (c.maxFileSize && asset.fileSize) {
    if (asset.fileSize > c.maxFileSize) {
      violations.push({
        kind: 'size',
        message: `「${label}」文件过大: ${(asset.fileSize / 1024 / 1024).toFixed(1)}MB > ${(c.maxFileSize / 1024 / 1024).toFixed(0)}MB，建议压缩`,
        autoFixable: true,
      });
    }
  }

  // Video-only checks
  const vc = c as { durationRange?: { min: number; max: number }; pixelCountRange?: { min: number; max: number }; fpsRange?: { min: number; max: number } };
  if (vc.durationRange && asset.duration !== undefined) {
    const durationSec = asset.duration / 1000;
    if (durationSec < vc.durationRange.min) {
      violations.push({
        kind: 'duration',
        message: `「${label}」时长过短: ${durationSec.toFixed(1)}s < ${vc.durationRange.min}s`,
        autoFixable: false,
      });
    }
    if (durationSec > vc.durationRange.max) {
      violations.push({
        kind: 'duration',
        message: `「${label}」时长过长: ${durationSec.toFixed(1)}s > ${vc.durationRange.max}s`,
        autoFixable: false,
      });
    }
  }

  if (vc.pixelCountRange && asset.width && asset.height) {
    const pixels = asset.width * asset.height;
    if (pixels < vc.pixelCountRange.min) {
      violations.push({
        kind: 'pixel',
        message: `「${label}」画面像素不足: ${pixels} < ${vc.pixelCountRange.min}，建议调整分辨率`,
        autoFixable: false,
      });
    }
    if (pixels > vc.pixelCountRange.max) {
      violations.push({
        kind: 'pixel',
        message: `「${label}」画面像素过多: ${pixels} > ${vc.pixelCountRange.max}，建议调整分辨率`,
        autoFixable: true,
      });
    }
  }

  if (vc.fpsRange && asset.fps !== undefined) {
    if (asset.fps < vc.fpsRange.min) {
      violations.push({
        kind: 'fps',
        message: `「${label}」帧率过低: ${asset.fps}fps < ${vc.fpsRange.min}fps`,
        autoFixable: false,
      });
    }
    if (asset.fps > vc.fpsRange.max) {
      violations.push({
        kind: 'fps',
        message: `「${label}」帧率过高: ${asset.fps}fps > ${vc.fpsRange.max}fps`,
        autoFixable: true,
      });
    }
  }

  return violations;
}

/**
 * Compute per-reference constraint indicators for UI display.
 * Returns a Map keyed by reference.id with constraint indicators and an overall hasErrors flag.
 */
export function computeReferenceIndicators(
  input: {
    references: Reference[];
    getAsset: (assetId: string) => Asset | undefined;
  },
  requirements?: InputRequirements,
): ReferenceIndicatorsResult {
  const indicators = new Map<string, ConstraintIndicator[]>();
  let hasErrors = false;

  if (!requirements?.referenceAssetConstraints) {
    return { indicators, hasErrors: false };
  }

  for (const ref of input.references) {
    const constraints = ref.type === 'image'
      ? requirements.referenceAssetConstraints.image
      : ref.type === 'video'
        ? requirements.referenceAssetConstraints.video
        : ref.type === 'audio'
          ? requirements.referenceAssetConstraints.audio
          : undefined;
    if (!constraints) continue;

    const asset = input.getAsset(ref.assetId);
    if (!asset) continue;

    const effectiveAsset = computeEffectiveAsset(asset, ref);

    const refIndicators: ConstraintIndicator[] = [];
    const violations = classifyMediaConstraints(asset.name ?? ref.assetId, effectiveAsset, constraints);

    for (const v of violations) {
      const indicatorType = violationToIndicatorType(v.kind);
      if (!indicatorType) continue;

      const severity = v.autoFixable ? 'warning' : 'error';
      if (severity === 'error') hasErrors = true;

      // Deduplicate: if same type already exists with same or higher severity, skip
      const existing = refIndicators.find(i => i.type === indicatorType);
      if (existing) {
        // Upgrade severity from warning to error if needed
        if (severity === 'error' && existing.severity === 'warning') {
          existing.severity = 'error';
          existing.label = indicatorLabel(indicatorType, 'error');
        }
        continue;
      }

      refIndicators.push({
        type: indicatorType,
        label: indicatorLabel(indicatorType, severity),
        severity,
      });
    }

    if (refIndicators.length > 0) {
      refIndicators.sort((a, b) => {
        // Errors before warnings, then by canonical type order
        if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
        return INDICATOR_TYPE_ORDER.indexOf(a.type) - INDICATOR_TYPE_ORDER.indexOf(b.type);
      });
      indicators.set(ref.id, refIndicators);
    }
  }

  return { indicators, hasErrors };
}

function violationToIndicatorType(kind: ConstraintViolation['kind']): ConstraintIndicatorType | null {
  switch (kind) {
    case 'format': return 'format_not_supported';
    case 'size': return 'size_over_limit';
    case 'pixel': return 'pixel_over_limit';
    case 'width':
    case 'height': return 'pixel_over_limit';
    case 'duration': return 'duration_over_limit';
    case 'fps': return 'fps_over_limit';
    case 'aspect_ratio': return 'aspect_ratio_over_limit';
    default: return null;
  }
}

function indicatorLabel(type: ConstraintIndicatorType, severity: 'error' | 'warning'): string {
  switch (type) {
    case 'size_over_limit': return severity === 'error' ? '体积超限' : '体积超限，将自动压缩';
    case 'aspect_ratio_over_limit': return '宽高比超限，需手动裁剪';
    case 'pixel_over_limit': return severity === 'error' ? '像素过少' : '像素过多，将自动缩放';
    case 'fps_over_limit': return severity === 'error' ? '帧率过低' : '帧率过高，将自动调整';
    case 'format_not_supported': return severity === 'error' ? '格式不支持' : '格式不支持，将自动转码';
    case 'duration_over_limit': return '时长超限，需手动截取';
  }
}

/** Parameters available for a specific model (drives UI controls) */
export interface CapabilityParams {
  resolution?: string[];
  aspectRatios?: string[];
  durationRange?: { min: number; max: number; step: number };
  enableAudio?: boolean;
  enableMusic?: boolean;
  enableSubtitle?: boolean;
  enableWatermark?: boolean;
  enableWebSearch?: boolean;
}

// ── Model Definitions ──

export interface ModelVariant {
  modelId: string;           // 'seedance-2.0' / 'seedance-2.0-fast' (kebab-case)
  name: string;              // 'Seedance 2.0' / 'Seedance 2.0 Fast' (Title Case)
  shortName?: string;        // Compact display first line (e.g. 'Seedance' for 'Seedance 2.0 Fast')
  familyId: string;          // → ModelFamily.id
  baseUrl?: string;          // endpoint at model level
  inputRequirements?: InputRequirements;
  params?: CapabilityParams;
  metadata?: {
    speedFactor?: number;
    description?: string;
    recommended?: boolean;
    /** Vendor-specific model identifier (e.g. Ark API model field) */
    arkModelId?: string;
    [key: string]: unknown;
  };
}

export interface ModelFamily {
  id: string;                // 'seedance-2' (model family with version)
  name: string;              // 'Seedance 2'
  models: ModelVariant[];
}

// ── Field Definitions (declarative form-driven UI) ──

export interface CredentialFieldDef {
  key: string;
  label: string;
  type: 'text' | 'url' | 'password' | 'hidden';
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  description?: string;
  /** true = 放入高级选项折叠区 */
  advanced?: boolean;
  /** Section grouping for provider config UI */
  section?: 'common' | 'tos' | 'asset';
}

export interface ModelConfigFieldDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'number';
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  description?: string;
}

// ── Provider Type Definition (Blueprint) ──

export interface ProviderTypeDefinition {
  typeId: string;            // 'seedance' (vendor/platform identifier)
  name: string;              // 'Seedance'
  providerType: ProviderType;
  builtIn: boolean;
  modelFamilies: ModelFamily[];
  configSchema?: Record<string, unknown>;
  description?: string;
  icon?: string;
  /** Declarative credential fields for the provider config dialog */
  credentialFields?: CredentialFieldDef[];
  /** Per-model config fields (applied to each model variant) */
  modelConfigFields?: ModelConfigFieldDef[];
}

// ── Provider Instance (User Config) ──

export interface ProviderInstance {
  instanceId: string;         // 'seedance-1', 'seedance-2'
  typeId: string;            // → ProviderTypeDefinition.typeId
  displayName: string;       // "我的 Seedance - 工作"
  order: number;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ── Fragment-Level Provider Selection ──

export interface FragmentProviderSelection {
  instanceId: string;
  modelId: string;
}

// ── Project-Level Provider Config ──

export interface ProjectProviderConfig {
  assetProviderInstanceId?: string;
}

/** Extract the encrypted password from a provider instance config. */
export function getProviderPassword(instance: ProviderInstance | undefined): string {
  return (instance?.config as Record<string, string>)?._encPassword ?? '';
}

/** Get enabled asset provider instances from the store. */
export function getAvailableAssetProviders(instances: ProviderInstance[]): ProviderInstance[] {
  const assetTypeDefs = getProviderTypeRegistry().getByType('asset');
  const typeIds = new Set(assetTypeDefs.map((d) => d.typeId));
  return instances.filter((inst) => inst.enabled && typeIds.has(inst.typeId));
}

/** Get asset provider instances fully configured for upload (TOS storage + Asset Group). */
export function getUploadReadyProviders(instances: ProviderInstance[]): ProviderInstance[] {
  const available = getAvailableAssetProviders(instances);
  return available.filter((inst) => {
    const config = inst.config as Record<string, unknown>;
    return !!(config.asset_group_id && config.tos_endpoint && config.tos_bucket);
  });
}
