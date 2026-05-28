/**
 * Generation types for AI content generation
 */

// FragmentStatus is also used in timeline.ts Fragment interface
// This type is re-exported from types/index.ts

import type { Reference, ImageRole } from './asset';
import type { AssetType } from './persistence';
import type { GenerationResultInfo } from '../utils/xml/generations-xml';

// ── Global Generation Parameter SSOT ──

/**
 * All available options for generation parameters — the single source of truth.
 * Providers select a subset via their CapabilityParams; the settings UI shows all options.
 */
export const GLOBAL_GENERATION_OPTIONS = {
  resolution: ['480p', '720p', '1080p'] as const,
  aspectRatios: ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'] as const,
  enableAudio: true,
  enableMusic: true,
  enableSubtitle: true,
  enableWatermark: true,
  enableWebSearch: true,
} as const;

/** Default generation parameter values (used in settings and new fragment creation) */
export const DEFAULT_GENERATION_PARAMS: GenerationParamDefaults = {
  resolution: '720p',
  aspectRatio: '16:9',
  enableAudio: true,
  enableMusic: false,
  enableSubtitle: false,
  enableWatermark: false,
  enableWebSearch: false,
};

const RESOLUTION_HEIGHTS: Record<string, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
};

const ASPECT_RATIO_NUMBERS: Record<string, [number, number]> = {
  '16:9': [16, 9],
  '21:9': [21, 9],
  '4:3': [4, 3],
  '1:1': [1, 1],
  '3:4': [3, 4],
  '9:16': [9, 16],
};

/** Round up to the nearest even number (H.264 requires even dimensions). */
function toEven(n: number): number {
  return (n + 1) & ~1;
}

/**
 * Convert a generation resolution label (e.g. `'1080p'`) and aspect ratio
 * (e.g. `'16:9'`) to pixel dimensions.  Falls back to 1920×1080 for
 * unrecognised values or `'adaptive'` ratio.
 */
export function generationResolutionToPixels(
  resolution: string,
  aspectRatio: string,
): { width: number; height: number } {
  const shortSide = RESOLUTION_HEIGHTS[resolution] ?? 1080;
  const ratio = ASPECT_RATIO_NUMBERS[aspectRatio];

  if (!ratio) {
    return { width: 1920, height: 1080 };
  }

  const [rw, rh] = ratio;
  const landscape = rw >= rh;

  if (landscape) {
    const height = shortSide;
    const width = toEven(Math.round((height * rw) / rh));
    return { width, height };
  }

  const width = shortSide;
  const height = toEven(Math.round((width * rh) / rw));
  return { width, height };
}

/** Persisted generation parameter defaults (no duration — duration is per-fragment) */
export interface GenerationParamDefaults {
  resolution: string;
  aspectRatio: string;
  enableAudio: boolean;
  enableMusic: boolean;
  enableSubtitle: boolean;
  enableWatermark: boolean;
  enableWebSearch: boolean;
}

/**
 * Generation request parameters
 */
export interface GenerationParams {
  prompt: string;
  references: Reference[];
  duration: number;
  aspectRatio: string;
  resolution?: string;
  generateAudio?: boolean;
  generateWatermark?: boolean;
  style?: string;
  negativePrompt?: string;
}

/**
 * Reference used in generation
 */
export interface GenerationReference {
  assetId: string;
  type: 'video' | 'image' | 'audio';
  weight: number;
  role?: ImageRole;
}

/**
 * Generation result from provider
 */
export interface GenerationResult {
  id: string;
  status: 'success' | 'failed';
  videoUrl?: string;
  thumbnailUrl?: string;
  duration: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

/**
 * Generation status enum
 */
export type GenerationStatus = 'pending' | 'recovering' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';

export function isActiveGenerationStatus(status: GenerationStatus): boolean {
  return status === 'pending' || status === 'processing' || status === 'recovering';
}

/**
 * Full generation record (stored in database and Generations.xml)
 */
export interface Generation {
  id: string;
  projectId: string;

  // Association info
  fragmentId?: string;
  fragmentName?: string;     // Denormalized: fragment may be deleted, name kept for display

  // Request content
  promptText: string;
  references: GenerationReference[];
  // Provider info
  providerInstanceId: string;
  providerDisplayName: string;
  providerParams: Record<string, unknown>;

  // Result
  outputType: AssetType;           // Intended output type (video/image/audio) — set at creation, independent of success/failure
  resultAssetId?: string;
  status: GenerationStatus;
  /** Runtime progress (0–100), not persisted to XML */
  progress?: number;
  errorMessage?: string;
  providerTaskId?: string;

  // Continuous generation fields (persisted to XML for crash/restart recovery)
  /** Whether this generation uses continuous (chained) generation */
  continuousMode?: boolean;
  /** Per-segment durations in seconds (e.g. [15, 15, 7]) */
  continuousPlan?: number[];
  /** Which segment is currently running (0-indexed) */
  currentSegmentIndex?: number;
  /** Root task ID for the continuous chain — shared by all segments */
  continuousGroupId?: string;
  /** Persisted last-frame image asset ID (survives restart, unlike remote URL) */
  lastFrameAssetId?: string;
  /** Composite video asset ID (concatenation of all completed segments) */
  compositeAssetId?: string;
  /** When true, first_frame was demoted to reference_image due to API conflict */
  firstFrameAsReference?: boolean;

  result?: GenerationResultInfo;

  // Metadata
  queuedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  creditsUsed?: number;
  userRating?: number;
  isSelected: boolean;

  createdAt: Date;
}

