/**
 * Asset types for resource management
 */

import type { AssetType, AssetSource } from './persistence';
import { ASSET_TYPES } from './persistence';

// Re-export for backward compatibility
export type { AssetType, AssetSource };
export { ASSET_TYPES };

/**
 * Asset stored in project
 */
export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  source: AssetSource;              // 'original' (user imported) or 'generated' (AI created)

  // Storage paths
  url: string;                    // Blob URL or file URL for display
  relativePath?: string;          // Relative path within project folder (desktop)
  sourcePath?: string;            // Original import path (for reference)
  generationId?: string;          // Link to generation record if generated

  // Remote asset info
  remoteAssetId?: string;       // Ark Asset API 返回的远端素材 ID
  remoteAssetStatus?: 'Processing' | 'Active' | 'Failed';  // 远端素材状态

  // File info
  thumbnailUrl?: string;
  waveformDataPath?: string;      // Path to binary peak data file (audio only, e.g. Thumbnails/{id}.peak)
  fileSize: number;
  mimeType: string;

  // Media metadata
  width?: number;
  height?: number;
  duration?: number;              // milliseconds
  fps?: number;                   // frames per second
  audioChannels?: number;         // Embedded audio channel count (video/audio assets)
  sampleRate?: number;            // Embedded audio sample rate in Hz (video/audio assets)
  mediaMetadataHydrated?: boolean; // True once a metadata probe has already run for this asset

  // Organization
  tags: string[];
  favorite: boolean;
  usageCount: number;

  projectId?: string;          // For DB persistence only (not serialized to XML)

  createdAt: Date;
  updatedAt: Date;
}

// ── Crop & Trim types ──

/** Normalized crop rectangle [0,1] relative to source dimensions. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Time range in milliseconds. */
export interface TrimRange {
  startMs: number;
  endMs: number;
}

/**
 * Reference to an asset used in generation
 */
export type ImageRole = 'first_frame' | 'last_frame' | 'reference_image';

export interface Reference {
  id: string;
  assetId: string;
  type: 'video' | 'image' | 'audio';
  weight?: number;
  role?: ImageRole;
  cropRect?: CropRect;    // Spatial crop (image + video)
  trimRange?: TrimRange;  // Temporal trim (video + audio)
}

/** Resolve the effective image role, defaulting to 'reference_image' when unset. */
export function getEffectiveImageRole(ref: Reference): ImageRole {
  return ref.role ?? 'reference_image';
}
