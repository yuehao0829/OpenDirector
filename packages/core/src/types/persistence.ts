/**
 * Persistence types for autosave and project management
 */

// ============================================================================
// Type Definitions (must come first)
// ============================================================================

/**
 * Asset type enum - file type classification
 */
export type AssetType = 'video' | 'image' | 'audio';

/**
 * Canonical asset-type tuple (image → video → audio) — the single source of
 * truth for iteration order. Reuse this instead of re-declaring the tuple,
 * so adding a type (or changing order) only touches one place.
 */
export const ASSET_TYPES = ['image', 'video', 'audio'] as const;

/**
 * Asset source enum - where the asset comes from
 */
export type AssetSource = 'original' | 'generated';

/**
 * File category for filtering in Asset Panel
 */
export type FileCategory = 'all' | AssetType;

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Autosave record stored in database
 */
export interface AutosaveRecord {
  id: string;
  projectId: string;
  savedAt: Date;
  trigger: AutosaveTrigger;
  filePath: string;  // Relative path to autosave folder
}

/**
 * Trigger type for autosave
 */
export type AutosaveTrigger = 'timer' | 'before_close' | 'before_risky';

/**
 * Snapshot data for autosave
 */
export interface AutosaveSnapshot {
  timestamp: Date;
  timeline: string;   // Timeline.xml content
  project: string;    // Project.odp content
}

/**
 * File info returned by file system operations
 */
export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: Date;
}

/**
 * Media metadata extracted from video/audio files
 */
export interface MediaMetadata {
  duration?: number;      // milliseconds
  width?: number;
  height?: number;
  frameRate?: number;
  audioChannels?: number;
  sampleRate?: number;
}

/**
 * Project folder options for creation
 */
export interface ProjectFolderOptions {
  name: string;
  parentPath: string;
}

/**
 * Asset import options
 */
export interface AssetImportOptions {
  projectPath: string;
  sourcePath: string;
  type: AssetType;
  source: AssetSource;
}

/**
 * Asset library query options
 */
export interface AssetLibraryQuery {
  type?: AssetType;
  source?: AssetSource;
  search?: string;
  favorite?: boolean;
  limit?: number;
  offset?: number;
}
