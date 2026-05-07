/**
 * Project Service
 *
 * Flow-orchestration layer for project lifecycle operations.
 * Extracted from projectStore so the store remains a pure state container.
 *
 * All functions operate on the projectStore via getState()/setState(),
 * and coordinate with project-io, project-hydration, and other services.
 */

import type { Asset } from '../types/asset';
import { Project } from '../types/project';
import { AutosaveTrigger } from '../types/persistence';
import { getPlatformAdapter } from '../adapters';
import type { FileSystemAdapter } from '../adapters';
import { loadProjectFiles, saveProjectFiles, renameProjectFile, createProjectStructure } from './project-io';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_FPS, DEFAULT_PROVIDER, DEFAULT_ASPECT_RATIO } from '../constants';
import { exportOtioToFile, importOtioFromFile } from './otio-io';
import { exportXgesToFile, importXgesFromFile } from './xges-io';
import { exportXmemlToFile, importXmeml } from './xmeml-io';
import { deleteAssetFiles } from './asset-import';
import { cleanupOrphanFiles } from './project-cleanup';
import { hydrateNewProject, hydrateLoadedProject, hydrateImportedProject } from './project-hydration';
import {
  buildImportedProjectFromTimelineData,
  hydrateImportedProjectAssetMetadata,
} from './media-exchange-project';
import {
  hydrateProjectVideoSourceAudioMetadata,
  mergeProjectAssetMetadata,
  persistProjectAssetsFile,
  projectNeedsVideoSourceAudioMetadataHydration,
} from './project-media-metadata';
import { buildProjectTimelineRenderRequest } from './timeline-render';
import { tauriBridge } from './tauri-bridge';
import { buildXgesExportTimeline } from './xges-timeline';
import { useTimelineStore } from '../stores/timelineStore';
import { useAssetStore } from '../stores/assetStore';
import { useGenerationStore } from '../stores/generationStore';
import { withoutDirtyTracking } from '../stores/dirty-tracking';
import { generationToRecord, assetToRecord } from '../utils/xml';
import { mapAssetSnapshots, setSavedSnapshot } from '../stores/undoManager';
import { getTempDir } from '../utils/temp-path';
import { generateId } from '../utils/id';
import { useProjectStore, getProjectOpenCallbacks } from '../stores/projectStore';

// ============================================================================
// Helpers
// ============================================================================

function stripOdpSuffix(name: string): string {
  return name.toLowerCase().endsWith('.odp') ? name.slice(0, -4) : name;
}

function parseSavePath(savePath: string): { folderPath: string; fileName: string; baseName: string } {
  const lastSep = Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\'));
  const chosenFileName = savePath.substring(lastSep + 1);
  const fileName = chosenFileName.toLowerCase().endsWith('.odp')
    ? chosenFileName
    : `${chosenFileName}.odp`;
  const baseName = stripOdpSuffix(fileName) || 'Untitled Project';
  return { folderPath: savePath.substring(0, lastSep), fileName, baseName };
}

function sanitizeProjectName(name: string): string {
  return name
    .trim()
    // Remove illegal characters for Windows/macOS/Linux file names
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    // Remove leading/trailing dots and spaces
    .replace(/^[.\s]+|[.\s]+$/g, '')
    // Collapse consecutive dots (prevent hidden files on Unix)
    .replace(/\.{2,}/g, '.')
    // Replace with fallback if empty
    || 'Untitled Project';
}

type SaveDialogFilter = {
  name: string;
  extensions: string[];
};

const inFlightProjectVideoSourceAudioHydrations = new Map<string, Promise<Project>>();

function selectSingleFilePath(selected: string | string[] | null): string | null {
  return Array.isArray(selected) ? selected[0] ?? null : selected;
}

async function chooseImportFile(
  title: string,
  accept: string[],
): Promise<{ adapter: Awaited<ReturnType<typeof getPlatformAdapter>>; filePath: string | null }> {
  const adapter = await getPlatformAdapter();
  const selected = await adapter.fs.selectFile({ title, accept });
  return { adapter, filePath: selectSingleFilePath(selected) };
}

async function chooseExportFile(
  defaultName: string,
  filters: SaveDialogFilter[],
): Promise<{ adapter: Awaited<ReturnType<typeof getPlatformAdapter>>; filePath: string | null }> {
  const adapter = await getPlatformAdapter();
  const filePath = await adapter.fs.saveFile(defaultName, filters);
  return { adapter, filePath };
}

function buildProjectAssetPathResolver(project: Project): (asset: Asset) => string {
  return (asset) => {
    if (project.folderPath && asset.relativePath) {
      return `${project.folderPath}/${asset.relativePath}`;
    }
    if (asset.sourcePath) return asset.sourcePath;
    return asset.url;
  };
}

function buildImportedProjectFromOtio(result: Awaited<ReturnType<typeof importOtioFromFile>>): Project {
  return buildImportedProjectFromTimelineData(result, 'Imported OTIO Project');
}

function buildImportedProjectFromXges(result: Awaited<ReturnType<typeof importXgesFromFile>>): Project {
  return buildImportedProjectFromTimelineData(result, 'Imported XGES Project');
}

function requireSavedProjectFolder(project: Project | null, format: string): string {
  if (!project?.folderPath) {
    throw new Error(`${format} requires a saved project folder`);
  }

  return project.folderPath;
}

function buildProjectSnapshot(currentProject: Project): Project {
  const timelineState = useTimelineStore.getState();
  const assetState = useAssetStore.getState();

  return {
    ...currentProject,
    tracks: timelineState.tracks,
    fragments: timelineState.fragments,
    scenes: timelineState.scenes,
    assets: assetState.assets,
    updatedAt: new Date(),
  };
}

function resolveTimelineRenderOutputFormat(outputPath: string): string {
  const normalizedPath = outputPath.replace(/\\/g, '/');
  const lastDot = normalizedPath.lastIndexOf('.');
  const extension = lastDot >= 0 ? normalizedPath.slice(lastDot + 1).toLowerCase() : '';

  switch (extension) {
    case 'mov':
    case 'wav':
    case 'mp3':
      return extension;
    default:
      return 'mp4';
  }
}

function buildTimelineRenderDefaultName(project: Project): string {
  const hasVideoTrack = project.tracks.some((track) => track.type === 'video');
  const defaultExtension = hasVideoTrack ? 'mp4' : 'wav';
  return `${sanitizeProjectName(project.name)}.${defaultExtension}`;
}

function getProjectVideoSourceAudioHydrationKey(project: Pick<Project, 'id' | 'folderPath'>): string {
  return `${project.id}::${project.folderPath ?? ''}`;
}

async function syncHydratedProjectAssetsToCurrentProject(
  sourceProject: Project,
  hydratedProject: Project,
  fs: Pick<FileSystemAdapter, 'writeFile'>,
): Promise<void> {
  const currentProject = useProjectStore.getState().currentProject;
  if (!currentProject) {
    return;
  }

  if (
    currentProject.id !== sourceProject.id
    || currentProject.folderPath !== sourceProject.folderPath
  ) {
    return;
  }

  const currentAssets = useAssetStore.getState().assets;
  const mergedAssets = mergeProjectAssetMetadata(currentAssets, hydratedProject.assets);
  if (mergedAssets === currentAssets) {
    return;
  }

  const nextProject: Project = {
    ...currentProject,
    assets: mergedAssets,
  };

  withoutDirtyTracking(() => {
    useAssetStore.setState({ assets: mergedAssets });
    useProjectStore.setState({ currentProject: nextProject });
  });

  mapAssetSnapshots((assets) => {
    if (assets === currentAssets) {
      return mergedAssets;
    }

    return mergeProjectAssetMetadata(assets, hydratedProject.assets);
  });

  await persistProjectAssetsFile(nextProject, fs);
}

export async function ensureProjectVideoSourceAudioMetadata(project: Project): Promise<Project> {
  if (!projectNeedsVideoSourceAudioMetadataHydration(project)) {
    return project;
  }

  const key = getProjectVideoSourceAudioHydrationKey(project);
  let hydrationPromise = inFlightProjectVideoSourceAudioHydrations.get(key);
  let createdHydrationPromise = false;

  if (!hydrationPromise) {
    createdHydrationPromise = true;
    hydrationPromise = (async () => {
      const adapter = await getPlatformAdapter();
      const hydratedProject = await hydrateProjectVideoSourceAudioMetadata(project, adapter.fs);

      if (hydratedProject !== project) {
        try {
          await syncHydratedProjectAssetsToCurrentProject(project, hydratedProject, adapter.fs);
        } catch (_error) {
          // metadata hydration is best-effort
        }
      }

      return hydratedProject;
    })();

    inFlightProjectVideoSourceAudioHydrations.set(key, hydrationPromise);
    void hydrationPromise.finally(() => {
      if (inFlightProjectVideoSourceAudioHydrations.get(key) === hydrationPromise) {
        inFlightProjectVideoSourceAudioHydrations.delete(key);
      }
    });
  }

  const hydratedProject = await hydrationPromise;
  const mergedAssets = mergeProjectAssetMetadata(project.assets, hydratedProject.assets);
  const mergedProject = mergedAssets === project.assets
    ? project
    : {
        ...project,
        assets: mergedAssets,
      };

  const stillNeedsHydration = projectNeedsVideoSourceAudioMetadataHydration(mergedProject);
  if (!stillNeedsHydration) {
    return mergedProject;
  }

  if (mergedProject !== project || !createdHydrationPromise) {
    return ensureProjectVideoSourceAudioMetadata(mergedProject);
  }

  return mergedProject;
}

export function scheduleProjectVideoSourceAudioMetadataHydration(project: Project): void {
  if (!projectNeedsVideoSourceAudioMetadataHydration(project)) {
    return;
  }

  void ensureProjectVideoSourceAudioMetadata(project).catch(() => { /* best-effort */ });
}

// ============================================================================
// Project Lifecycle
// ============================================================================

/**
 * Ensure a project exists — if none is open, create a temp one.
 */
export function ensureProject(): void {
  const { currentProject } = useProjectStore.getState();
  if (currentProject !== null) return;
  hydrateNewProject({ name: 'Untitled Project', folderPath: undefined, isTemp: true });
  void setupTempFolder().catch(() => { /* best-effort: temp folder is not critical */ });
}

/**
 * Create temp folder for an unsaved project.
 */
export async function setupTempFolder(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject || currentProject.folderPath) return;
  const adapter = await getPlatformAdapter();

  const tempDir = await getTempDir();
  const tempProjectPath = `${tempDir}/OpenDirector/unsaved-${currentProject.id}`;
  await createProjectStructure(adapter.fs, tempProjectPath);

  useProjectStore.setState({ currentProject: { ...currentProject, folderPath: tempProjectPath } });
}

/**
 * Clean up the temp folder for the current project (if it's a temp project).
 */
export async function cleanupTempFolder(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject?.isTemp || !currentProject.folderPath) return;
  const adapter = await getPlatformAdapter();
  try { await adapter.fs.removeDir(currentProject.folderPath, true); } catch { /* ignore */ }
}

/**
 * Create a new project with the given name and optional folder path.
 */
export async function createProject(name: string, folderPath?: string): Promise<Project> {
  useProjectStore.setState({ isLoading: true });

  try {
    const project = hydrateNewProject({ name, folderPath });
    useProjectStore.setState({ isLoading: false });
    return project;
  } catch (error) {
    useProjectStore.setState({ isLoading: false });
    throw error;
  }
}

/**
 * Create a new project with a save-file dialog.
 * Shows the system "Save As" dialog first; only creates the project
 * after the user confirms a location. Returns undefined if cancelled.
 */
export async function newProject(): Promise<void> {
  useProjectStore.setState({ isLoading: true });

  try {
    const adapter = await getPlatformAdapter();
    const fs = adapter.fs;
    if (!fs) throw new Error('File system not available');

    const savePath = await fs.saveFile('Untitled Project.odp');
    if (!savePath) {
      useProjectStore.setState({ isLoading: false });
      return;
    }

    const { folderPath, fileName, baseName } = parseSavePath(savePath);

    const project = hydrateNewProject({ name: baseName, folderPath, fileName });

    await Promise.all([
      createProjectStructure(fs, folderPath),
      saveProjectFiles(project, fs, folderPath, fileName),
    ]);

    setSavedSnapshot();
    useProjectStore.setState({ lastSavedAt: new Date(), isLoading: false });
  } catch (error) {
    useProjectStore.setState({ isLoading: false });
    throw error;
  }
}

/**
 * Open a project from a folder path (or .odp file path).
 */
export async function openProjectFromFolder(filePath: string): Promise<void> {
  useProjectStore.setState({ isLoading: true });

  try {
    const adapter = await getPlatformAdapter();

    // If user selected a .odp file
    let folderPath = filePath;
    let fileName: string | undefined;
    if (stripOdpSuffix(filePath) !== filePath) {
      const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      folderPath = filePath.substring(0, lastSep);
      fileName = filePath.substring(lastSep + 1);
    }

    // Load project files from disk
    const loaded = await loadProjectFiles(adapter.fs, folderPath, fileName);

    // Build full Project with defaults for missing fields
    const project: Project = {
      id: loaded.id ?? generateId(),
      name: loaded.name ?? 'Untitled Project',
      folderPath,
      fileName: loaded.fileName,
      tracks: loaded.tracks ?? [],
      fragments: loaded.fragments ?? [],
      scenes: loaded.scenes ?? [],
      assets: loaded.assets ?? [],
      settings: {
        fps: loaded.settings?.fps ?? DEFAULT_FPS,
        resolution: loaded.settings?.resolution ?? { ...DEFAULT_PROJECT_SETTINGS.resolution },
        defaultProvider: loaded.settings?.defaultProvider ?? DEFAULT_PROVIDER,
        defaultAspectRatio: loaded.settings?.defaultAspectRatio ?? DEFAULT_ASPECT_RATIO,
        providerConfig: loaded.settings?.providerConfig ?? {},
      },
      createdAt: loaded.createdAt ?? new Date(),
      updatedAt: loaded.updatedAt ?? new Date(),
    };

    hydrateLoadedProject(project, loaded.generations ?? []);

    // Notify project-open callbacks (e.g. restoreProjectGenerations)
    const callbacks = getProjectOpenCallbacks();
    await Promise.allSettled(
      callbacks.map((cb) => cb(project)),
    );

    // If callbacks modified stores (e.g. restored succeeded tasks), save to persist fragment changes
    const { isDirty } = useProjectStore.getState();
    if (isDirty) {
      await saveProject();
    }

    const openedProject = useProjectStore.getState().currentProject;
    if (openedProject) {
      scheduleProjectVideoSourceAudioMetadataHydration(buildProjectSnapshot(openedProject));
    }

    useProjectStore.setState({
      isDirty: false,
      lastSavedAt: new Date(),
      isLoading: false,
    });
  } catch (error) {
    useProjectStore.setState({ isLoading: false });
    throw error;
  }
}

/**
 * Show an open-file dialog and open the selected project.
 */
export async function openProjectDialog(): Promise<void> {
  let adapter: Awaited<ReturnType<typeof getPlatformAdapter>>;
  adapter = await getPlatformAdapter();

  let filePath: string | null = null;
  const selected = await adapter.fs.selectFile({
    title: '打开工程',
    accept: ['.odp'],
  });
  filePath = selectSingleFilePath(selected);

  if (filePath) {
    await openProjectFromFolder(filePath);
  }
}

/**
 * Save the current project to disk.
 * If the project is temp/unsaved, shows a Save As dialog.
 */
export async function saveProject(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  useProjectStore.setState({ isLoading: true });

  try {
    // Sync latest data from timelineStore and assetStore
    const project = buildProjectSnapshot(currentProject);

    const adapter = await getPlatformAdapter();
    const fs = adapter.fs;
    if (!fs) throw new Error('File system not available');

    const isTemp = !!project.isTemp;
    const oldFolderPath = project.folderPath;

    if (!project.folderPath || isTemp) {
      // Save As: use native save-file dialog (user picks location + types filename)
      const defaultName = `${sanitizeProjectName(project.name)}.odp`;
      const savePath = await fs.saveFile(defaultName);
      if (!savePath) {
        useProjectStore.setState({ isLoading: false });
        return;
      }

      const { folderPath, fileName, baseName } = parseSavePath(savePath);
      project.folderPath = folderPath;
      project.fileName = fileName;
      project.name = baseName;

      await createProjectStructure(fs, folderPath);

      if (isTemp && oldFolderPath) {
        const migrateDirs = ['Generated', 'Thumbnails'];
        for (const dir of migrateDirs) {
          try {
            const srcDir = `${oldFolderPath}/${dir}`;
            const files = await fs.listDir(srcDir);
            for (const file of files) {
              if (file.isDirectory) continue;
              const destFile = `${project.folderPath}/${dir}/${file.name}`;
              try { await fs.copyFile(file.path, destFile); } catch { /* skip */ }
            }
          } catch {
            // Source dir may not exist — skip
          }
        }
        // Cleanup temp folder after migration
        try { await fs.removeDir(oldFolderPath, true); } catch { /* ignore */ }
      }
      if (isTemp) project.isTemp = false;
    }

    const assetsFile = {
      assets: project.assets.map(assetToRecord),
    };

    await saveProjectFiles(
      project,
      fs,
      project.folderPath,
      project.fileName,
      { generations: useGenerationStore.getState().generations
        .filter((g) => g.projectId === project.id)
        .map(generationToRecord) },
      assetsFile,
    );

    // Delete physical files for assets that were removed since last save
    const pendingDeletions = useAssetStore.getState().pendingDeletions;
    if (pendingDeletions.length > 0) {
      for (const asset of pendingDeletions) {
        try {
          await deleteAssetFiles(asset, fs, project.folderPath);
        } catch (_error) {
          // file may have been cleaned up by a concurrent save
        }
      }
      useAssetStore.getState().clearPendingDeletions();
    }

    // Orphan cleanup: delete files on disk not referenced by any asset
    await cleanupOrphanFiles(fs, project.folderPath, project.assets);

    setSavedSnapshot();
    useProjectStore.setState({
      currentProject: project,
      isDirty: false,
      lastSavedAt: new Date(),
      isLoading: false,
    });
  } catch (error) {
    useProjectStore.setState({ isLoading: false });
    throw error;
  }
}

/**
 * Save the current project under a new name/folder.
 */
export async function saveProjectAs(name: string, folderPath: string): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  useProjectStore.setState({ isLoading: true });

  try {
    // Strip .odp suffix if present
    const cleanName = stripOdpSuffix(name);
    const safeName = sanitizeProjectName(cleanName);

    const newProject: Project = {
      ...currentProject,
      id: generateId(),
      name: safeName,
      folderPath,
      fileName: `${safeName}.odp`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    useProjectStore.setState({
      currentProject: newProject,
      isDirty: false,
      lastSavedAt: new Date(),
      isLoading: false,
    });
  } catch (error) {
    useProjectStore.setState({ isLoading: false });
    throw error;
  }
}

/**
 * Export the current project as XMEML (FCP7 XML, Premiere compatible).
 */
export async function exportXmeml(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  const project = buildProjectSnapshot(currentProject);
  const { adapter, filePath } = await chooseExportFile(
    `${sanitizeProjectName(project.name)}.xml`,
    [{ name: 'XML', extensions: ['xml'] }],
  );
  if (!filePath) return;

  await exportXmemlToFile(
    {
      project,
      fsAdapter: adapter.fs,
      assetPathResolver: buildProjectAssetPathResolver(project),
    },
    filePath,
  );
}

export async function exportOtioProject(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  const project = buildProjectSnapshot(currentProject);
  const { adapter, filePath } = await chooseExportFile(
    `${sanitizeProjectName(project.name)}.otio.json`,
    [{ name: 'OTIO JSON', extensions: ['json'] }],
  );
  if (!filePath) return;

  await exportOtioToFile(
    {
      project,
      fsAdapter: adapter.fs,
      assetPathResolver: buildProjectAssetPathResolver(project),
    },
    filePath,
  );
}

export async function importOtioProject(): Promise<void> {
  const { adapter, filePath } = await chooseImportFile('导入 OTIO', ['.otio', '.otio.json', '.json']);
  if (!filePath) return;

  const result = await importOtioFromFile({
    filePath,
    fsAdapter: adapter.fs,
  });

  const project = await hydrateImportedProjectAssetMetadata(
    buildImportedProjectFromOtio(result),
    adapter.fs,
  );
  hydrateImportedProject(project);
}

export async function exportXgesProject(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) {
    throw new Error('XGES export requires a saved project folder');
  }
  const project = buildProjectSnapshot(currentProject);
  const projectPath = requireSavedProjectFolder(project, 'XGES export');

  const { filePath } = await chooseExportFile(
    `${sanitizeProjectName(project.name)}.xges`,
    [{ name: 'XGES', extensions: ['xges'] }],
  );
  if (!filePath) return;

  await exportXgesToFile({
    projectPath,
    outputPath: filePath,
    timeline: buildXgesExportTimeline({
      project,
      assetPathResolver: buildProjectAssetPathResolver(project),
    }),
  });
}

export async function importXgesProject(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) {
    throw new Error('XGES import requires a saved project folder');
  }
  const projectPath = requireSavedProjectFolder(currentProject, 'XGES import');
  const adapter = await getPlatformAdapter();

  const { filePath } = await chooseImportFile('导入 XGES', ['.xges']);
  if (!filePath) return;

  const result = await importXgesFromFile({
    filePath,
    projectPath,
  });

  const project = await hydrateImportedProjectAssetMetadata(
    buildImportedProjectFromXges(result),
    adapter.fs,
  );
  hydrateImportedProject(project);
}

export async function exportTimelineRenderProject(): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  useProjectStore.setState({ isLoading: true });

  try {
    let project = buildProjectSnapshot(currentProject);
    const { filePath } = await chooseExportFile(
      buildTimelineRenderDefaultName(project),
      [
        { name: 'MP4 Video', extensions: ['mp4'] },
        { name: 'QuickTime MOV', extensions: ['mov'] },
        { name: 'WAV Audio', extensions: ['wav'] },
        { name: 'MP3 Audio', extensions: ['mp3'] },
      ],
    );
    if (!filePath) {
      useProjectStore.setState({ isLoading: false });
      return;
    }

    project = await ensureProjectVideoSourceAudioMetadata(project);

    await tauriBridge.mediaApi.render(buildProjectTimelineRenderRequest({
      project,
      outputPath: filePath,
      outputFormat: resolveTimelineRenderOutputFormat(filePath),
      assetPathResolver: buildProjectAssetPathResolver(project),
    }));

    useProjectStore.setState({ isLoading: false });
  } catch (error) {
    useProjectStore.setState({ isLoading: false });
    throw error;
  }
}

/**
 * Import a project from XMEML (FCP7 XML).
 */
export async function importXmemlProject(): Promise<void> {
  const { adapter, filePath } = await chooseImportFile('导入 XML', ['.xml']);
  if (!filePath) return;

  const result = await importXmeml({ filePath, fsAdapter: adapter.fs });

  // Create a new project from the imported data
  const project: Project = {
    id: generateId(),
    name: 'Imported Project',
    tracks: result.tracks.map((t) => ({
      id: `track-${t.type}-${t.order}`,
      type: t.type,
      name: t.type === 'video' ? `视频轨道 ${t.order + 1}` : `音频轨道 ${t.order + 1}`,
      muted: false,
      locked: false,
      order: t.order,
    })),
    fragments: result.tracks.flatMap((t) =>
      t.fragments.map((f) => ({
        id: generateId(),
        trackId: `track-${t.type}-${t.order}`,
        start: f.start,
        duration: f.duration,
        prompt: f.name,
        references: [],
        status: 'completed' as const,
        sourceAssetId: f.sourceAssetId,
        trimStart: f.trimStart,
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    ),
    scenes: [],
    assets: result.assets.map((a) => ({
      id: a.id,
      name: a.name,
      type: (a.hasVideo ? 'video' : a.hasAudio ? 'audio' : 'video') as 'video' | 'image' | 'audio',
      source: 'original' as const,
      url: a.localPath,
      sourcePath: a.localPath,
      generationId: undefined,
      thumbnailUrl: undefined,
      waveformDataPath: undefined,
      fileSize: 0,
      mimeType: '',
      duration: a.duration,
      audioChannels: a.hasAudio ? 2 : undefined,
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    settings: {
      fps: result.fps,
      resolution: { width: result.width, height: result.height },
      defaultProvider: DEFAULT_PROVIDER,
      defaultAspectRatio: `${result.width}:${result.height}`,
      providerConfig: {},
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  hydrateImportedProject(project);
}

/**
 * Update project name and rename the .odp file on disk if the project is saved.
 */
export async function updateProjectName(name: string): Promise<void> {
  const { currentProject } = useProjectStore.getState();
  if (!currentProject) return;

  // Derive clean name (strip .odp suffix if user typed it)
  const cleanName = stripOdpSuffix(name);

  const oldFileName = currentProject.fileName;
  const newFileName = `${sanitizeProjectName(cleanName)}.odp`;

  useProjectStore.setState({
    currentProject: {
      ...currentProject,
      name: cleanName,
      fileName: newFileName,
      updatedAt: new Date(),
    },
    isDirty: true,
  });

  // If project is saved, rename the .odp file on disk
  if (currentProject.folderPath && oldFileName && oldFileName !== newFileName) {
    try {
      const adapter = await getPlatformAdapter();
      await renameProjectFile(adapter.fs, currentProject.folderPath, oldFileName, newFileName);
      // Re-save with new filename, including generations and assets
      const project = { ...useProjectStore.getState().currentProject!, fileName: newFileName };
      const assetState = useAssetStore.getState();
      const assetsFile = { assets: assetState.assets.map(assetToRecord) };
      await saveProjectFiles(project, adapter.fs, currentProject.folderPath, newFileName, {
        generations: useGenerationStore.getState().generations
          .filter((g) => g.projectId === project.id)
          .map(generationToRecord),
      }, assetsFile);
    } catch (_error) {
      // rename is best-effort — the project remains functional under its old name
    }
  }
}

export async function triggerAutosave(trigger: AutosaveTrigger): Promise<void> {
  const { currentProject, isDirty, autosaveEnabled } = useProjectStore.getState();

  if (!currentProject || !isDirty) return;
  if (trigger === 'timer' && !autosaveEnabled) return;

  useProjectStore.setState({ lastSavedAt: new Date() });
}
