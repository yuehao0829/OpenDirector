/**
 * Tauri Platform Adapter
 *
 * Implements platform adapters for Tauri desktop using Rust-side SQLite commands
 * and native file system operations.
 */

import { PlatformAdapter, StorageAdapter, DatabaseAdapter, FileSystemAdapter, FileSelectOptions } from './types';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_FPS, DEFAULT_PROVIDER, DEFAULT_ASPECT_RATIO, PROJECT_SUBDIRS } from '../constants';
import { Project, ProjectMeta } from '../types/project';
import { Asset } from '../types/asset';
import { Generation } from '../types/generation';
import { AutosaveRecord, AutosaveTrigger, AutosaveSnapshot, FileInfo, MediaMetadata, AssetSource, AssetLibraryQuery, AssetType } from '../types/persistence';
import { toWebViewUrl, isTauri } from '../utils/platform';
import { formatFsTimestamp } from '../utils/time';
import { getFileExtension } from '../utils/common';
import { textToArrayBuffer } from '../utils/encoding';
import { invoke } from '../utils/tauri-invoke';
import { generateId } from '../utils/id';
import { t } from '../i18n';

// Row types returned from Rust commands (camelCase, booleans already converted)
interface AssetRow {
  id: string;
  projectId: string;
  name: string;
  type: string;
  source: string;
  relativePath: string;
  fileSize: number;
  mimeType: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  thumbnailPath: string | null;
  tagsJson: string;
  favorite: boolean;
  usageCount: number;
  generationId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GenerationRow {
  id: string;
  projectId: string;
  fragmentId: string | null;
  fragmentName: string | null;
  promptText: string;
  referencesJson: string;
  providerInstanceId: string;
  providerDisplayName: string;
  providerParamsJson: string;
  outputType: string;
  resultAssetId: string | null;
  status: string;
  errorMessage: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  creditsUsed: number | null;
  userRating: number | null;
  isSelected: boolean;
  createdAt: string;
}

interface LibraryAssetRow {
  id: string;
  name: string;
  type: string;
  source: string;
  sourcePath: string | null;
  thumbnailPath: string | null;
  tagsJson: string;
  favorite: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

class TauriStorageAdapter implements StorageAdapter {
  async createProject(name: string, folderPath: string): Promise<Project> {
    const project: Project = {
      id: generateId(),
      name,
      folderPath,
      tracks: [],
      fragments: [],
      scenes: [],
      assets: [],
      settings: {
        fps: DEFAULT_FPS,
        resolution: { ...DEFAULT_PROJECT_SETTINGS.resolution },
        defaultProvider: DEFAULT_PROVIDER,
        defaultAspectRatio: DEFAULT_ASPECT_RATIO,
        providerConfig: {},
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await invoke('db_create_project', {
      input: {
        id: project.id,
        name: project.name,
        folderPath,
        settingsJson: JSON.stringify(project.settings),
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
    });

    return project;
  }

  async saveProject(project: Project): Promise<void> {
    project.updatedAt = new Date();
    await invoke('db_save_project', {
      input: {
        id: project.id,
        name: project.name,
        folderPath: project.folderPath ?? '',
        settingsJson: JSON.stringify(project.settings),
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
    });
  }

  async loadProject(id: string): Promise<Project | null> {
    const row = await invoke<{
      id: string;
      name: string;
      folderPath: string | null;
      settingsJson: string;
      createdAt: string;
      updatedAt: string;
    } | null>('db_load_project', { id });

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      folderPath: row.folderPath || undefined,
      settings: JSON.parse(row.settingsJson),
      tracks: [],
      fragments: [],
      scenes: [],
      assets: [],
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const rows = await invoke<{
      id: string;
      name: string;
      folderPath: string | null;
      createdAt: string;
      updatedAt: string;
      lastOpenedAt: string | null;
    }[]>('db_list_projects');

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      folderPath: row.folderPath || undefined,
      thumbnailUrl: undefined,
      duration: 0,
      fragmentCount: 0,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      lastOpenedAt: row.lastOpenedAt ? new Date(row.lastOpenedAt) : undefined,
    }));
  }

  async deleteProject(id: string): Promise<void> {
    await invoke('db_delete_project', { id });
  }

  // Autosave methods
  async autosave(projectId: string, trigger: AutosaveTrigger): Promise<void> {
    await invoke('db_autosave', {
      id: generateId(),
      projectId,
      savedAt: new Date().toISOString(),
      trigger,
    });
  }

  async listAutosaves(projectId: string): Promise<AutosaveRecord[]> {
    const rows = await invoke<{
      id: string;
      projectId: string;
      savedAt: string;
      trigger: string;
      filePath: string | null;
    }[]>('db_list_autosaves', { projectId });

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      savedAt: new Date(row.savedAt),
      trigger: row.trigger as AutosaveTrigger,
      filePath: row.filePath ?? '',
    }));
  }

  async restoreAutosave(_projectId: string, _autosaveId: string): Promise<void> {
    // Autosave restore is not yet implemented; this is a no-op
  }

  async clearAutosaves(projectId: string, keepCount?: number): Promise<void> {
    await invoke('db_clear_autosaves', { projectId, keepCount: keepCount ?? 20 });
  }

  // Preferences
  async getPreference<T>(key: string): Promise<T | null> {
    const value = await invoke<string | null>('db_get_preference', { key });
    if (value === null) return null;
    return JSON.parse(value) as T;
  }

  async setPreference<T>(key: string, value: T): Promise<void> {
    await invoke('db_set_preference', { key, value: JSON.stringify(value) });
  }
}

class TauriDatabaseAdapter implements DatabaseAdapter {
  // Asset methods
  async saveAsset(asset: Asset): Promise<void> {
    const isAudio = asset.type === 'audio';
    await invoke('db_save_asset', {
      input: {
        id: asset.id,
        projectId: asset.projectId ?? '',
        name: asset.name,
        type: asset.type,
        source: asset.source,
        relativePath: asset.relativePath ?? '',
        fileSize: asset.fileSize,
        mimeType: asset.mimeType,
        duration: asset.duration ?? null,
        width: asset.width != null ? Math.round(asset.width) : null,
        height: asset.height != null ? Math.round(asset.height) : null,
        thumbnailPath: isAudio ? (asset.waveformDataPath ?? null) : (asset.thumbnailUrl ?? null),
        tagsJson: JSON.stringify(asset.tags),
        favorite: asset.favorite,
        usageCount: asset.usageCount,
        generationId: asset.generationId ?? null,
        createdAt: asset.createdAt.toISOString(),
        updatedAt: asset.updatedAt.toISOString(),
      },
    });
  }

  async getAsset(id: string): Promise<Asset | null> {
    const row = await invoke<AssetRow | null>('db_get_asset', { id });

    if (!row) return null;
    return this.rowToAsset(row);
  }

  async getAssetsByProject(projectId: string): Promise<Asset[]> {
    const rows = await invoke<AssetRow[]>('db_get_assets_by_project', { projectId });
    return rows.map((row) => this.rowToAsset(row));
  }

  async getAssetsBySource(projectId: string, source: AssetSource): Promise<Asset[]> {
    const rows = await invoke<AssetRow[]>('db_get_assets_by_source', { projectId, source });
    return rows.map((row) => this.rowToAsset(row));
  }

  async searchAssets(projectId: string, query: string): Promise<Asset[]> {
    const rows = await invoke<AssetRow[]>('db_search_assets', { projectId, query });
    return rows.map((row) => this.rowToAsset(row));
  }

  async deleteAsset(id: string): Promise<void> {
    await invoke('db_delete_asset', { id });
  }

  private rowToAsset(row: AssetRow): Asset {
    const isAudio = row.type === 'audio';
    return {
      id: row.id,
      name: row.name,
      type: row.type as AssetType,
      source: row.source as AssetSource,
      url: '',
      relativePath: row.relativePath || undefined,
      thumbnailUrl: isAudio ? undefined : (row.thumbnailPath ? toWebViewUrl(row.thumbnailPath) : undefined),
      waveformDataPath: isAudio ? row.thumbnailPath || undefined : undefined,
      fileSize: row.fileSize,
      mimeType: row.mimeType,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      duration: row.duration ?? undefined,
      generationId: row.generationId ?? undefined,
      tags: JSON.parse(row.tagsJson || '[]'),
      favorite: row.favorite,
      usageCount: row.usageCount,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  // Generation methods
  async createGeneration(generation: Generation): Promise<void> {
    await invoke('db_create_generation', {
      input: {
        id: generation.id,
        projectId: generation.projectId,
        fragmentId: generation.fragmentId ?? null,
        fragmentName: generation.fragmentName ?? null,
        promptText: generation.promptText,
        referencesJson: JSON.stringify(generation.references),
        providerInstanceId: generation.providerInstanceId,
        providerDisplayName: generation.providerDisplayName,
        providerParamsJson: JSON.stringify(generation.providerParams),
        outputType: generation.outputType,
        resultAssetId: generation.resultAssetId ?? null,
        status: generation.status,
        errorMessage: generation.errorMessage ?? null,
        queuedAt: generation.queuedAt?.toISOString() ?? null,
        startedAt: generation.startedAt?.toISOString() ?? null,
        completedAt: generation.completedAt?.toISOString() ?? null,
        creditsUsed: generation.creditsUsed ?? null,
        userRating: generation.userRating ?? null,
        isSelected: generation.isSelected,
        createdAt: generation.createdAt.toISOString(),
      },
    });
  }

  async updateGeneration(id: string, updates: Partial<Generation>): Promise<void> {
    const updateObj: Record<string, unknown> = {};
    const updateableFields: (keyof Generation)[] = [
      'status', 'errorMessage', 'resultAssetId', 'startedAt', 'completedAt',
      'creditsUsed', 'userRating', 'isSelected',
    ];

    for (const field of updateableFields) {
      if (field in updates) {
        const value = updates[field];
        updateObj[field] = value instanceof Date ? value.toISOString() : value;
      }
    }

    await invoke('db_update_generation', {
      input: { id, updates: updateObj },
    });
  }

  async getGeneration(id: string): Promise<Generation | null> {
    const row = await invoke<GenerationRow | null>('db_get_generation', { id });

    if (!row) return null;
    return this.rowToGeneration(row);
  }

  async getGenerationsByProject(projectId: string): Promise<Generation[]> {
    const rows = await invoke<GenerationRow[]>('db_get_generations_by_project', { projectId });
    return rows.map((row) => this.rowToGeneration(row));
  }

  async getGenerationsByFragment(fragmentId: string): Promise<Generation[]> {
    const rows = await invoke<GenerationRow[]>('db_get_generations_by_fragment', { fragmentId });
    return rows.map((row) => this.rowToGeneration(row));
  }

  async deleteGeneration(id: string): Promise<void> {
    await invoke('db_delete_generation', { id });
  }

  async deleteGenerationsByFragment(fragmentId: string): Promise<void> {
    await invoke('db_delete_generations_by_fragment', { fragmentId });
  }

  async getProjectsByFolderPath(folderPath: string): Promise<string | null> {
    return invoke<string | null>('db_get_project_by_folder_path', { folderPath });
  }

  private rowToGeneration(row: GenerationRow): Generation {
    return {
      id: row.id,
      projectId: row.projectId,
      fragmentId: row.fragmentId ?? undefined,
      fragmentName: row.fragmentName ?? undefined,
      promptText: row.promptText,
      references: JSON.parse(row.referencesJson || '[]'),
      providerInstanceId: row.providerInstanceId ?? '',
      providerDisplayName: row.providerDisplayName ?? '',
      providerParams: JSON.parse(row.providerParamsJson || '{}'),
      outputType: row.outputType as AssetType,
      resultAssetId: row.resultAssetId ?? undefined,
      status: row.status as Generation['status'],
      errorMessage: row.errorMessage ?? undefined,
      queuedAt: row.queuedAt ? new Date(row.queuedAt) : undefined,
      startedAt: row.startedAt ? new Date(row.startedAt) : undefined,
      completedAt: row.completedAt ? new Date(row.completedAt) : undefined,
      creditsUsed: row.creditsUsed ?? undefined,
      userRating: row.userRating ?? undefined,
      isSelected: row.isSelected,
      createdAt: new Date(row.createdAt),
    };
  }

  // Asset library methods
  async addToLibrary(asset: Asset, sourcePath: string): Promise<void> {
    await invoke('db_add_to_library', {
      input: {
        id: asset.id,
        name: asset.name,
        type: asset.type,
        source: asset.source,
        sourcePath,
        thumbnailPath: asset.thumbnailUrl ?? null,
        tagsJson: JSON.stringify(asset.tags),
        favorite: asset.favorite,
        usageCount: asset.usageCount,
        createdAt: asset.createdAt.toISOString(),
        updatedAt: asset.updatedAt.toISOString(),
      },
    });
  }

  async getLibraryAssets(query: AssetLibraryQuery): Promise<Asset[]> {
    const rows = await invoke<LibraryAssetRow[]>('db_get_library_assets', {
      query: {
        type: query.type,
        source: query.source,
        search: query.search,
        favorite: query.favorite,
        limit: query.limit,
        offset: query.offset,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type as AssetType,
      source: row.source as AssetSource,
      url: '',
      sourcePath: row.sourcePath ?? undefined,
      thumbnailUrl: row.thumbnailPath ?? undefined,
      fileSize: 0,
      mimeType: '',
      tags: JSON.parse(row.tagsJson || '[]'),
      favorite: row.favorite,
      usageCount: row.usageCount,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  async removeFromLibrary(id: string): Promise<void> {
    await invoke('db_remove_from_library', { id });
  }
}

class TauriFileSystemAdapter implements FileSystemAdapter {
  async readFile(path: string): Promise<ArrayBuffer> {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const data = await readFile(path);
    return data.buffer;
  }

  async writeFile(path: string, data: ArrayBuffer | Blob): Promise<void> {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    await writeFile(path, new Uint8Array(buffer));
  }

  async deleteFile(path: string): Promise<void> {
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { exists } = await import('@tauri-apps/plugin-fs');
      return await exists(path);
    } catch {
      return false;
    }
  }

  async copyFile(src: string, dest: string): Promise<number> {
    const result = await invoke<{ fileSize: number }>('copy_asset_file', { fromPath: src, toPath: dest });
    return result.fileSize;
  }

  async getFileSize(path: string): Promise<number> {
    const { stat } = await import('@tauri-apps/plugin-fs');
    const info = await stat(path);
    return info.size;
  }

  async moveFile(src: string, dest: string): Promise<void> {
    const { rename } = await import('@tauri-apps/plugin-fs');
    await rename(src, dest);
  }

  async createDir(path: string): Promise<void> {
    return this.ensureDir(path);
  }

  async removeDir(path: string, recursive?: boolean): Promise<void> {
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(path, { recursive });
  }

  async listDir(path: string): Promise<FileInfo[]> {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');
    const entries = await readDir(path);
    const results: FileInfo[] = [];
    for (const entry of entries) {
      results.push({
        name: entry.name,
        path: await join(path, entry.name),
        isDirectory: entry.isDirectory,
        size: 0,
        modifiedAt: new Date(),
      });
    }
    return results;
  }

  async ensureDir(path: string): Promise<void> {
    const { mkdir } = await import('@tauri-apps/plugin-fs');
    await mkdir(path, { recursive: true });
  }

  async selectFile(options?: FileSelectOptions): Promise<string | string[] | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const filters = options?.filters ?? options?.accept?.map((ext) => ({
      name: ext,
      extensions: [ext.replace('.', '')],
    }));
    const result = await open({
      multiple: options?.multiple ?? false,
      title: options?.title,
      filters,
    });
    if (result === null) return null;
    if (options?.multiple && Array.isArray(result)) return result;
    if (Array.isArray(result)) return result[0] ?? null;
    return result;
  }

  async selectFolder(): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true });
    if (result === null || Array.isArray(result)) return null;
    return result;
  }

  async saveFile(defaultPath?: string, filters?: import('./types').FileFilter[]): Promise<string | null> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({
      defaultPath,
      filters: filters ?? [{ name: t('common.fileFilters.project'), extensions: ['odp'] }],
    });
  }

  async createProjectFolder(name: string, parentPath: string): Promise<string> {
    const projectPath = `${parentPath}/${name}`;
    await this.ensureDir(projectPath);
    await Promise.all(PROJECT_SUBDIRS.map((subdir) => this.ensureDir(`${projectPath}/${subdir}`)));
    return projectPath;
  }

  async importAssetToProject(
    projectPath: string,
    sourcePath: string,
    type: AssetType,
    _source: AssetSource
  ): Promise<string> {
    const assetId = generateId();
    const ext = getFileExtension(sourcePath);
    const destPath = `${projectPath}/Assets/${type.charAt(0).toUpperCase() + type.slice(1)}/${assetId}.${ext}`;
    await this.copyFile(sourcePath, destPath);
    return destPath;
  }

  async generateThumbnail(videoPath: string, outputPath?: string, timeSec?: number): Promise<string> {
    return invoke<string>('generate_video_thumbnail', { videoPath, outputPath, timeSec: timeSec ?? 1 });
  }

  async generateImageThumbnail(imagePath: string, maxSize?: number, outputPath?: string): Promise<string> {
    return invoke<string>('generate_image_thumbnail', { imagePath, maxSize: maxSize ?? 512, outputPath });
  }

  async generateAudioPeakData(audioPath: string, outputPath: string, peaks?: number): Promise<string> {
    return invoke<string>('generate_audio_peakdata', { audioPath, outputPath, peaks: peaks ?? 4096 });
  }

  async getMediaMetadata(path: string): Promise<MediaMetadata> {
    const result = await invoke<{ duration_ms: number | null; width: number | null; height: number | null; frame_rate: number | null; channels: number | null; sample_rate: number | null }>('get_media_metadata', { path });
    return {
      duration: result.duration_ms ?? undefined,
      width: result.width ?? undefined,
      height: result.height ?? undefined,
      frameRate: result.frame_rate ?? undefined,
      audioChannels: result.channels ?? undefined,
      sampleRate: result.sample_rate ?? undefined,
    };
  }

  async saveAutosaveSnapshot(projectPath: string, snapshot: AutosaveSnapshot): Promise<string> {
    const timestamp = formatFsTimestamp(snapshot.timestamp);
    const autosavePath = `${projectPath}/Autosave/${timestamp}`;
    await this.ensureDir(autosavePath);

    const projectBuffer = textToArrayBuffer(snapshot.project);
    const timelineBuffer = textToArrayBuffer(snapshot.timeline);

    await this.writeFile(`${autosavePath}/Project.odp`, projectBuffer);
    await this.writeFile(`${autosavePath}/Timeline.xml`, timelineBuffer);

    return autosavePath;
  }
}

export async function getTauriPlatformAdapter(): Promise<PlatformAdapter> {
  // Detect actual platform via Tauri OS plugin
  let platform: 'macos' | 'windows' | 'linux' = 'linux';
  try {
    const tauriOs = await import('@tauri-apps/' + 'plugin-os') as { platform: () => Promise<string> };
    const os = await tauriOs.platform();
    if (os === 'macos' || os === 'windows' || os === 'linux') {
      platform = os;
    }
  } catch {
    // OS plugin unavailable — leave as neutral fallback
  }

  return {
    storage: new TauriStorageAdapter(),
    db: new TauriDatabaseAdapter(),
    fs: new TauriFileSystemAdapter(),
    platform,
  };
}

// Cache the adapter — reuse the same instance
let _adapterCache: Promise<PlatformAdapter> | null = null;

export async function getPlatformAdapter(): Promise<PlatformAdapter> {
  if (!_adapterCache) {
    _adapterCache = _createPlatformAdapter();
  }
  return _adapterCache;
}

async function _createPlatformAdapter(): Promise<PlatformAdapter> {
  if (!isTauri()) {
    throw new Error('OpenDirector requires the Tauri desktop environment');
  }
  return getTauriPlatformAdapter();
}
