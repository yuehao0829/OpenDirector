/**
 * Provider system types — hierarchical provider/model architecture.
 *
 * Layer 1: ProviderTypeDefinition (blueprint) — what a provider *can* do
 * Layer 2: ProviderInstance (user config) — a configured instance referencing a type
 * Layer 3: Fragment.providerSelection — per-fragment selection of instance + model
 */

import type { Asset, Reference } from './asset';
import { ASSET_TYPES, getEffectiveImageRole } from './asset';
import { getProviderTypeRegistry } from '../services/service-locator';
import { computeVisibleCropSize } from '../utils/crop';
import { t as translate } from '../i18n';
import type { ParamLayoutItem } from './param-layout';

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
  OPENAI_IMAGE: 'openai-image',
  MINIMAX: 'minimax',
  SEEDAUDIO: 'seed-audio',
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
  /**
   * Declarative reference-marker format — how references are cited inside the
   * prompt. Each provider's server expects a different token shape (e.g.
   * Seedance `[图片1]`/`[Image 1]`, SeedAudio `@音频1`/`@Audio1`); declaring it
   * here lets the UI drive mention insertion / rendering / renumbering from one
   * source instead of hardcoding `[类型N]`.
   *
   * A template uses `{{type}}` (type name) and `{{index}}` (1-based ordinal).
   * `templateKey` is an i18n key resolved by the UI via `t()` so the template
   * (and its spacing) can vary by language; `template` is a literal fallback for
   * non-i18n use. Omit both to default to `'[{{type}}{{index}}]'`.
   *
   * Type names localize automatically from i18n (`common.image/video/audio`)
   * when `typeNames` is omitted. Declare `typeNames` only when a server requires
   * a fixed literal token regardless of UI language.
   */
  referenceMarker?: {
    /** i18n key resolving to the per-language template (preferred for i18n). */
    templateKey?: string;
    /** Literal template (no i18n). Used when `templateKey` is absent/unresolved. */
    template?: string;
    /** Fixed cross-language type-name overrides; omit for localized names. */
    typeNames?: { image?: string; video?: string; audio?: string };
    /** Reference types that can be cited in the prompt via a marker. Defaults
     *  to all supported reference types. E.g. SeedAudio's image is a
     *  voice-cloning source (passed out-of-band), not a prompt citation, so it
     *  declares `['audio']` to keep the mention UI from offering `@图片N`. */
    mentionableTypes?: Array<'image' | 'video' | 'audio'>;
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
    rule: 'require_non_audio_reference' | 'forbid_image_audio_mix';
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
    errors.push(translate('generation.validation.promptRequired'));
  }
  if (requirements.maxPromptLength && prompt.length > requirements.maxPromptLength) {
    errors.push(translate('generation.validation.promptTooLong', { actual: prompt.length, max: requirements.maxPromptLength }));
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
      errors.push(translate('generation.validation.needReference', { type: refType }));
    }
    if (constraint.min !== undefined && count < constraint.min) {
      errors.push(translate('generation.validation.referenceCountTooLow', { type: refType, count, min: constraint.min }));
    }
    if (constraint.max !== undefined && count > constraint.max) {
      errors.push(translate('generation.validation.referenceCountTooHigh', { type: refType, count, max: constraint.max }));
    }
  }

  // Total reference count check
  if (requirements.references.maxTotal !== undefined) {
    if (references.length > requirements.references.maxTotal) {
      errors.push(translate('generation.validation.totalReferencesTooHigh', { count: references.length, max: requirements.references.maxTotal }));
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
        errors.push(translate('generation.validation.totalVideoDurationTooHigh', { actual: totalDurationSec.toFixed(1), max: vidConstraints.maxTotalDuration }));
      }
    }

    const audioConstraints = requirements.referenceAssetConstraints.audio;
    if (audioConstraints?.maxTotalDuration) {
      const totalDurationSec = totalAudioDurationMs / 1000;
      if (totalDurationSec > audioConstraints.maxTotalDuration) {
        errors.push(translate('generation.validation.totalAudioDurationTooHigh', { actual: totalDurationSec.toFixed(1), max: audioConstraints.maxTotalDuration }));
      }
    }

    if (totalRefSize > MAX_TOTAL_REFERENCE_SIZE) {
      warnings.push(translate('generation.validation.totalReferenceSizeTooHigh', {
        actual: (totalRefSize / 1024 / 1024).toFixed(1),
        max: MAX_TOTAL_REFERENCE_SIZE / 1024 / 1024,
      }));
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
      } else if (cc.rule === 'forbid_image_audio_mix') {
        // Some providers (e.g. SeedAudio voice cloning) treat image and audio
        // references as mutually exclusive cloning sources — mixing them is
        // rejected by the API. Block it here rather than silently dropping one.
        const hasImage = references.some((r) => r.type === 'image');
        const hasAudio = references.some((r) => r.type === 'audio');
        if (hasImage && hasAudio) {
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
      errors.push(translate('generation.validation.imageRoleConflict'));
    }
    if (lastFrameCount > 0 && firstFrameCount === 0) {
      errors.push(translate('generation.validation.lastFrameNeedsFirstFrame'));
    }
    if (firstFrameCount > 1) {
      errors.push(translate('generation.validation.oneFirstFrameOnly'));
    }
    if (lastFrameCount > 1) {
      errors.push(translate('generation.validation.oneLastFrameOnly'));
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
        message: translate('generation.validation.formatUnsupported', { label, actual: asset.mimeType, expected: c.allowedFormats.join(', ') }),
        autoFixable: true,
      });
    }
  }

  if (c.widthRange && asset.width !== undefined) {
    if (asset.width < c.widthRange.min) {
      violations.push({
        kind: 'width',
        message: translate('generation.validation.widthTooSmall', { label, actual: asset.width, min: c.widthRange.min }),
        autoFixable: false, // Cannot upscale reliably
      });
    }
    if (asset.width > c.widthRange.max) {
      violations.push({
        kind: 'width',
        message: translate('generation.validation.widthTooLarge', { label, actual: asset.width, max: c.widthRange.max }),
        autoFixable: true,
      });
    }
  }

  if (c.heightRange && asset.height !== undefined) {
    if (asset.height < c.heightRange.min) {
      violations.push({
        kind: 'height',
        message: translate('generation.validation.heightTooSmall', { label, actual: asset.height, min: c.heightRange.min }),
        autoFixable: false,
      });
    }
    if (asset.height > c.heightRange.max) {
      violations.push({
        kind: 'height',
        message: translate('generation.validation.heightTooLarge', { label, actual: asset.height, max: c.heightRange.max }),
        autoFixable: true,
      });
    }
  }

  if (c.aspectRatioRange && asset.width && asset.height) {
    const ratio = asset.width / asset.height;
    if (ratio < c.aspectRatioRange.min) {
      violations.push({
        kind: 'aspect_ratio',
        message: translate('generation.validation.aspectRatioTooSmall', { label, actual: ratio.toFixed(2), min: c.aspectRatioRange.min }),
        autoFixable: false,
      });
    }
    if (ratio > c.aspectRatioRange.max) {
      violations.push({
        kind: 'aspect_ratio',
        message: translate('generation.validation.aspectRatioTooLarge', { label, actual: ratio.toFixed(2), max: c.aspectRatioRange.max }),
        autoFixable: false,
      });
    }
  }

  if (c.maxFileSize && asset.fileSize) {
    if (asset.fileSize > c.maxFileSize) {
      violations.push({
        kind: 'size',
        message: translate('generation.validation.fileTooLarge', {
          label,
          actual: (asset.fileSize / 1024 / 1024).toFixed(1),
          max: (c.maxFileSize / 1024 / 1024).toFixed(0),
        }),
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
        message: translate('generation.validation.durationTooShort', { label, actual: durationSec.toFixed(1), min: vc.durationRange.min }),
        autoFixable: false,
      });
    }
    if (durationSec > vc.durationRange.max) {
      violations.push({
        kind: 'duration',
        message: translate('generation.validation.durationTooLong', { label, actual: durationSec.toFixed(1), max: vc.durationRange.max }),
        autoFixable: false,
      });
    }
  }

  if (vc.pixelCountRange && asset.width && asset.height) {
    const pixels = asset.width * asset.height;
    if (pixels < vc.pixelCountRange.min) {
      violations.push({
        kind: 'pixel',
        message: translate('generation.validation.pixelsTooFew', { label, actual: pixels, min: vc.pixelCountRange.min }),
        autoFixable: false,
      });
    }
    if (pixels > vc.pixelCountRange.max) {
      violations.push({
        kind: 'pixel',
        message: translate('generation.validation.pixelsTooMany', { label, actual: pixels, max: vc.pixelCountRange.max }),
        autoFixable: true,
      });
    }
  }

  if (vc.fpsRange && asset.fps !== undefined) {
    if (asset.fps < vc.fpsRange.min) {
      violations.push({
        kind: 'fps',
        message: translate('generation.validation.fpsTooLow', { label, actual: asset.fps, min: vc.fpsRange.min }),
        autoFixable: false,
      });
    }
    if (asset.fps > vc.fpsRange.max) {
      violations.push({
        kind: 'fps',
        message: translate('generation.validation.fpsTooHigh', { label, actual: asset.fps, max: vc.fpsRange.max }),
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
    case 'size_over_limit': return severity === 'error' ? translate('generation.indicator.sizeError') : translate('generation.indicator.sizeWarning');
    case 'aspect_ratio_over_limit': return translate('generation.indicator.aspectRatio');
    case 'pixel_over_limit': return severity === 'error' ? translate('generation.indicator.pixelError') : translate('generation.indicator.pixelWarning');
    case 'fps_over_limit': return severity === 'error' ? translate('generation.indicator.fpsError') : translate('generation.indicator.fpsWarning');
    case 'format_not_supported': return severity === 'error' ? translate('generation.indicator.formatError') : translate('generation.indicator.formatWarning');
    case 'duration_over_limit': return translate('generation.indicator.duration');
  }
}

/** Parameters available for a specific model (drives UI controls) */
export interface CapabilityParams {
  outputType?: 'video' | 'image' | 'audio';
  resolution?: string[];
  aspectRatios?: string[];
  imageSizes?: string[];
  imageQuality?: string[];
  imageOutputFormats?: string[];
  imageBackgrounds?: string[];
  imageModeration?: string[];
  durationRange?: { min: number; max: number; step: number };
  enableAudio?: boolean;
  enableMusic?: boolean;
  enableSubtitle?: boolean;
  enableWatermark?: boolean;
  enableWebSearch?: boolean;
  /** TTS — selectable voice IDs (static defaults; cloud-fetched voices merge in at runtime). */
  voiceIds?: Array<{ value: string; label: string; labelEn?: string }>;
  /** TTS — selectable emotions. */
  emotions?: string[];
  /** TTS — selectable audio formats (mp3/wav/pcm/flac/opus). */
  audioFormats?: string[];
  /** TTS — selectable sample rates (flat list; used when sampleRateByFormat is absent). */
  sampleRates?: string[];
  /** TTS — sample rates keyed by audio format ('default' = fallback). When present,
   *  the UI shows only rates valid for the currently selected audioFormat. */
  sampleRateByFormat?: Record<string, string[]>;
  /** TTS — speed slider bounds. */
  speedRange?: { min: number; max: number; step: number };
  /** TTS — volume slider bounds. */
  volumeRange?: { min: number; max: number; step: number };
  /** TTS — pitch slider bounds (semitones). */
  pitchRange?: { min: number; max: number; step: number };
  /** TTS — selectable bitrates (only effective for mp3 format). */
  bitrates?: number[];
  /** TTS — selectable channel counts [1, 2]. */
  channels?: number[];
  // TTS 高级参数 (MiniMax)
  /** TTS — 支持的小语种增强列表，如 ["auto", "Chinese", "English"]。 */
  languageBoostOptions?: string[];
  /** TTS — 音高调整范围 [-100, 100]。 */
  voiceModifyPitchRange?: { min: number; max: number; step: number };
  /** TTS — 强度调整范围 [-100, 100]。 */
  voiceModifyIntensityRange?: { min: number; max: number; step: number };
  /** TTS — 音色调整范围 [-100, 100]。 */
  voiceModifyTimbreRange?: { min: number; max: number; step: number };
  /** TTS — 可选音效列表。 */
  voiceModifySoundEffects?: Array<{ value: string; label: string }>;
  /** TTS — 是否支持发音词典。 */
  supportsPronunciationDict?: boolean;
  /** TTS — 是否支持 AIGC 水印。 */
  supportsAigcWatermark?: boolean;
  /** TTS — 是否支持英语规范化。 */
  supportsEnglishNormalization?: boolean;
  /**
   * Which param valueKeys to show in the inspector summary bar (Panel header).
   * When undefined, all supported params are shown (Seedance / GPT Image behavior).
   * When set, only the listed valueKeys appear — e.g. MiniMax TTS shows only
   * the essentials: ['voiceId', 'emotion', 'audioFormat', 'channel', 'sampleRate'].
   */
  summaryFields?: string[];
  /**
   * Declarative parameter layout — defined by the provider. The array order
   * determines display order. When present, the UI uses this instead of
   * hardcoded layout logic.
   */
  paramLayout?: ParamLayoutItem[];
  /**
   * Audio formats that support voice_modify (pitch/intensity/timbre/sound effects).
   * Per MiniMax API docs: mp3, wav, flac only — pcm/opus/etc. return param errors.
   * When set, voice_modify params are only visible when the selected format
   * is in this list. When undefined, defaults to ['mp3', 'wav', 'flac'].
   */
  voiceModifyFormats?: string[];
}

export function isImageModel(params: CapabilityParams): boolean {
  if (params.outputType === 'image') return true;
  if ((params.imageSizes?.length ?? 0) > 0) return true;
  return false;
}

export function isAudioModel(params: CapabilityParams): boolean {
  if (params.outputType === 'audio') return true;
  if ((params.voiceIds?.length ?? 0) > 0) return true;
  return false;
}

/** The reference types a model supports: `max` undefined (treated as unlimited
 *  — matching `validateInputRequirements`, which only enforces an upper bound
 *  when `max` is defined) or explicitly > 0; only an explicit `max: 0` means
 *  unsupported. Empty when no model is selected or the model supports no
 *  references. */
export function supportedReferenceTypes(req?: InputRequirements): Set<'image' | 'video' | 'audio'> {
  const refs = req?.references;
  if (!refs) return new Set();
  return new Set(
    ASSET_TYPES.filter((key) => {
      const c = refs[key];
      return !!c && (c.max === undefined || c.max > 0);
    }),
  );
}

/** Whether a model's InputRequirements allow any reference asset at all
 *  (image / video / audio). Used to gate the reference-assets panel — e.g. an
 *  audio fragment shows the panel for SeedAudio (audio/image cloning refs) but
 *  not for MiniMax (no references). Returns false when requirements are absent
 *  (no model selected / undeclared) — callers fall back to track-type heuristics. */
export function supportsAnyReference(req?: InputRequirements): boolean {
  return supportedReferenceTypes(req).size > 0;
}

// ── Reference Marker (declarative prompt citation format) ──

/**
 * Resolved reference-marker config — no optionals. `template` always has
 * `{{type}}`/`{{index}}` placeholders; `typeNames` is fully populated;
 * `mentionableTypes` lists the types that may be cited in the prompt.
 */
export interface ReferenceMarkerConfig {
  template: string;
  typeNames: { image: string; video: string; audio: string };
  mentionableTypes: ReadonlyArray<'image' | 'video' | 'audio'>;
}

/**
 * Resolve a model's `InputRequirements.referenceMarker` into a complete
 * `ReferenceMarkerConfig`.
 *
 * - `template`: a declared `templateKey` is resolved via the module's own
 *   `translate()` (this file already depends on i18n — see
 *   `validateInputRequirements`); falls back to the literal `template`, then to
 *   `'[{{type}}{{index}}]'`. i18next returns the key itself when the entry is
 *   missing, which is treated as unresolved.
 * - `typeNames`: provider-declared values win; gaps filled from
 *   `fallbackTypeNames` (the UI passes localized `common.*` names; the default
 *   uses `translate('common.*')` so the function is callable in isolation).
 * - `mentionableTypes`: declared value, else all types (`ASSET_TYPES`).
 */
export function resolveReferenceMarker(
  req?: InputRequirements,
  fallbackTypeNames: { image: string; video: string; audio: string } = {
    image: translate('common.image'),
    video: translate('common.video'),
    audio: translate('common.audio'),
  },
): ReferenceMarkerConfig {
  const declared = req?.referenceMarker;
  let template: string | undefined;
  if (declared?.templateKey) {
    const resolved = translate(declared.templateKey);
    template = resolved && resolved !== declared.templateKey ? resolved.trim() : undefined;
  }
  template = template || declared?.template?.trim() || '[{{type}}{{index}}]';
  const declaredNames = declared?.typeNames ?? {};
  return {
    template,
    typeNames: {
      image: declaredNames.image ?? fallbackTypeNames.image,
      video: declaredNames.video ?? fallbackTypeNames.video,
      audio: declaredNames.audio ?? fallbackTypeNames.audio,
    },
    mentionableTypes: declared?.mentionableTypes ?? ASSET_TYPES,
  };
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
  type: 'text' | 'url' | 'password' | 'hidden' | 'select';
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
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
