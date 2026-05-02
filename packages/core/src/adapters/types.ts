/**
 * Platform adapter type definitions
 */

import type { Project, ProjectMeta } from '../types/project';
import type { Asset } from '../types/asset';
import type { Generation } from '../types/generation';
import type {
  AutosaveRecord,
  AutosaveTrigger,
  AutosaveSnapshot,
  FileInfo,
  MediaMetadata,
  AssetType,
  AssetSource,
  AssetLibraryQuery,
} from '../types/persistence';

export interface StorageAdapter {
  // Projects
  createProject(name: string, folderPath: string): Promise<Project>;
  saveProject(project: Project): Promise<void>;
  loadProject(id: string): Promise<Project | null>;
  listProjects(): Promise<ProjectMeta[]>;
  deleteProject(id: string): Promise<void>;

  // Autosave
  autosave(projectId: string, trigger: AutosaveTrigger): Promise<void>;
  listAutosaves(projectId: string): Promise<AutosaveRecord[]>;
  restoreAutosave(projectId: string, autosaveId: string): Promise<void>;
  clearAutosaves(projectId: string, keepCount?: number): Promise<void>;

  // Preferences
  getPreference<T>(key: string): Promise<T | null>;
  setPreference<T>(key: string, value: T): Promise<void>;
}

export interface DatabaseAdapter {
  // Assets
  saveAsset(asset: Asset): Promise<void>;
  getAsset(id: string): Promise<Asset | null>;
  getAssetsByProject(projectId: string): Promise<Asset[]>;
  getAssetsBySource(projectId: string, source: AssetSource): Promise<Asset[]>;
  searchAssets(projectId: string, query: string): Promise<Asset[]>;
  deleteAsset(id: string): Promise<void>;

  // Generation history
  createGeneration(generation: Generation): Promise<void>;
  updateGeneration(id: string, updates: Partial<Generation>): Promise<void>;
  getGeneration(id: string): Promise<Generation | null>;
  getGenerationsByProject(projectId: string): Promise<Generation[]>;
  getGenerationsByFragment(fragmentId: string): Promise<Generation[]>;
  deleteGeneration(id: string): Promise<void>;
  deleteGenerationsByFragment(fragmentId: string): Promise<void>;

  // Project lookup
  getProjectsByFolderPath(folderPath: string): Promise<string | null>;

  // Global asset library
  addToLibrary(asset: Asset, sourcePath: string): Promise<void>;
  getLibraryAssets(query: AssetLibraryQuery): Promise<Asset[]>;
  removeFromLibrary(id: string): Promise<void>;
}

export interface FileSystemAdapter {
  // Basic file operations
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, data: ArrayBuffer | Blob): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  copyFile(src: string, dest: string): Promise<number>;
  moveFile(src: string, dest: string): Promise<void>;
  getFileSize(path: string): Promise<number>;

  // Directory operations
  createDir(path: string): Promise<void>;
  removeDir(path: string, recursive?: boolean): Promise<void>;
  listDir(path: string): Promise<FileInfo[]>;
  ensureDir(path: string): Promise<void>;

  // Selectors
  selectFile(options?: FileSelectOptions): Promise<string | string[] | null>;
  selectFolder(): Promise<string | null>;
  saveFile(defaultPath?: string, filters?: FileFilter[]): Promise<string | null>;

  // Project folder operations
  createProjectFolder(name: string, parentPath: string): Promise<string>;
  importAssetToProject(
    projectPath: string,
    sourcePath: string,
    type: AssetType,
    source: AssetSource
  ): Promise<string>;

  // Thumbnail
  generateThumbnail(videoPath: string, outputPath?: string, timeSec?: number): Promise<string>;
  generateImageThumbnail(imagePath: string, maxSize?: number, outputPath?: string): Promise<string>;
  generateAudioPeakData(audioPath: string, outputPath: string, peaks?: number): Promise<string>;

  // Metadata
  getMediaMetadata(path: string): Promise<MediaMetadata>;

  // Autosave
  saveAutosaveSnapshot(projectPath: string, snapshot: AutosaveSnapshot): Promise<string>;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface FileSelectOptions {
  accept?: string[];
  multiple?: boolean;
  title?: string;
  filters?: FileFilter[];
}

export interface PlatformAdapter {
  storage: StorageAdapter;
  db: DatabaseAdapter;
  fs: FileSystemAdapter;
  platform: 'macos' | 'windows' | 'linux';
}
