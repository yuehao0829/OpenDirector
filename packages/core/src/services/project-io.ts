/**
 * Project File I/O Service
 *
 * Handles reading and writing project files to disk
 */

import type { Project } from '../types/project';
import type { AutosaveSnapshot, AssetSource, AssetType } from '../types/persistence';
import type { ImageRole, Asset } from '../types/asset';
import type { FileSystemAdapter } from '../adapters/types';
import { safeMax } from '../utils/timeline';
import type { GenerationRecord } from '../utils/xml';
import { toPersistableStatus } from '../utils/xml';
import { PROJECT_SUBDIRS } from '../constants';
import { toWebViewUrl } from '../utils/platform';
import { formatFsTimestamp } from '../utils/time';
import { textToArrayBuffer, arrayBufferToText } from '../utils/encoding';
import { generateId } from '../utils/id';
import { generateAssetThumbnail, generateAssetPeakData } from './asset-import';
import {
  serializeProjectFile,
  parseProjectFile,
  serializeTimelineFile,
  parseTimelineFile,
  serializeProjectSettings,
  parseProjectSettings,
  serializeLocalSettings,
  parseLocalSettings,
} from '../utils/xml';
import type {
  ProjectFile,
  TimelineFile,
  ProjectSettingsFile,
  LocalSettingsFile,
  GenerationsFile,
  AssetsFile,
  AssetRecord,
} from '../utils/xml';
import {
  serializeGenerationsFile,
  parseGenerationsFile,
  serializeAssetsFile,
  parseAssetsFile,
} from '../utils/xml';

// ============================================================================
// Constants
// ============================================================================

const PROJECT_FILE = 'Project.odp';
const TIMELINE_FILE = 'Timeline.xml';
const GENERATIONS_FILE = 'Generations.xml';
export const ASSETS_XML_FILENAME = 'Assets.xml';
const PROJECT_SETTINGS_FILE = 'ProjectSettings.xml';
const LOCAL_SETTINGS_FILE = 'LocalSettings.xml';
const AUTOSAVE_DIR = 'Autosave';

// ============================================================================
// Project I/O
// ============================================================================

/**
 * Save all project files to a folder
 */
export async function saveProjectFiles(
  project: Project,
  fs: FileSystemAdapter,
  folderPath: string,
  fileName: string = PROJECT_FILE,
  generations?: GenerationsFile,
  assetsFile?: AssetsFile,
): Promise<void> {
  // Ensure folder exists
  await fs.ensureDir(folderPath);

  // Build and save .odp file
  const projectFile = buildProjectFile(project);

  await fs.writeFile(
    `${folderPath}/${fileName}`,
    textToArrayBuffer(serializeProjectFile(projectFile))
  );

  // Build and save Timeline.xml
  const timelineFile = buildTimelineFile(project);

  await fs.writeFile(
    `${folderPath}/${TIMELINE_FILE}`,
    textToArrayBuffer(serializeTimelineFile(timelineFile))
  );

  // Save ProjectSettings.xml
  const settingsFile: ProjectSettingsFile = {
    video: {
      fps: project.settings.fps,
      resolution: project.settings.resolution,
      aspectRatio: project.settings.defaultAspectRatio,
    },
    generation: {
      defaultProvider: project.settings.defaultProvider,
      defaultDuration: 5000,
      defaultAspectRatio: project.settings.defaultAspectRatio,
    },
  };

  await fs.writeFile(
    `${folderPath}/${PROJECT_SETTINGS_FILE}`,
    textToArrayBuffer(serializeProjectSettings(settingsFile))
  );

  // Save Generations.xml if provided
  if (generations) {
    await fs.writeFile(
      `${folderPath}/${GENERATIONS_FILE}`,
      textToArrayBuffer(serializeGenerationsFile(generations))
    );
  }

  // Save Assets.xml if provided
  if (assetsFile) {
    await fs.writeFile(
      `${folderPath}/${ASSETS_XML_FILENAME}`,
      textToArrayBuffer(serializeAssetsFile(assetsFile))
    );
  }
}

/**
 * Load all project files from a folder
 */
export async function loadProjectFiles(
  fs: FileSystemAdapter,
  folderPath: string,
  fileName?: string
): Promise<Partial<Project> & { generations?: GenerationRecord[]; assetRecords?: AssetRecord[] }> {
  const result: Partial<Project> & { generations?: GenerationRecord[]; assetRecords?: AssetRecord[] } = {};

  // Find .odp file: use specified fileName, or detect from folder
  let resolvedFileName: string;
  if (fileName) {
    resolvedFileName = fileName;
  } else {
    resolvedFileName = await findProjectFile(fs, folderPath);
  }

  result.fileName = resolvedFileName;

  // Load .odp file
  const projectPath = `${folderPath}/${resolvedFileName}`;
  let legacyResources: import('../utils/xml').ProjectResource[] | undefined;
  if (await fs.exists(projectPath)) {
    const projectData = await fs.readFile(projectPath);
    const projectFile = parseProjectFile(arrayBufferToText(projectData));

    result.id = projectFile.id;
    result.name = projectFile.name;
    result.createdAt = projectFile.createdAt;
    result.updatedAt = projectFile.updatedAt;
    result.folderPath = folderPath;

    // Keep legacy resources for migration if present
    legacyResources = projectFile.resources;
  }

  // Load Assets.xml — the SSOT for asset data
  const assetsPath = `${folderPath}/${ASSETS_XML_FILENAME}`;
  let assetRecords: AssetRecord[] | undefined;

  if (await fs.exists(assetsPath)) {
    try {
      const assetsData = await fs.readFile(assetsPath);
      const assetsFile = parseAssetsFile(arrayBufferToText(assetsData));
      assetRecords = assetsFile.assets;
      result.assetRecords = assetRecords;
    } catch (_err) {
      // Assets.xml is not required — older projects may store assets in Project.odp
    }
  }

  // Migration: if Assets.xml doesn't exist but Project.odp has <resources>, migrate
  if (!assetRecords && legacyResources && legacyResources.length > 0) {
    assetRecords = legacyResources.map((r) => ({
      id: r.id,
      type: r.type,
      source: r.source,
      name: r.name,
      path: r.path,
      sourcePath: r.sourcePath,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      duration: r.duration,
      width: r.width,
      height: r.height,
      audioChannels: undefined,
      sampleRate: undefined,
      generationId: r.generationId,
      remoteAssetId: r.remoteAssetId,
      remoteAssetStatus: r.remoteAssetStatus as AssetRecord['remoteAssetStatus'],
      tags: r.tags,
      createdAt: r.createdAt.toISOString(),
    }));
    result.assetRecords = assetRecords;
  }

  // Build Asset[] from asset records (legacy resources already converted to AssetRecord[])
  if (assetRecords && assetRecords.length > 0) {
    result.assets = await buildAssetsFromRecords(assetRecords, folderPath, fs);
  }

  // Load Timeline.xml
  const timelinePath = `${folderPath}/${TIMELINE_FILE}`;
  if (await fs.exists(timelinePath)) {
    const timelineData = await fs.readFile(timelinePath);
    const timelineFile = parseTimelineFile(arrayBufferToText(timelineData));

    result.tracks = timelineFile.tracks.map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      order: t.order,
      muted: t.muted,
      locked: t.locked,
    }));

    result.scenes = timelineFile.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      start: s.start,
      duration: s.duration,
      referenceIds: s.referenceRefs,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    result.fragments = timelineFile.fragments.map((f) => ({
      id: f.id,
      trackId: f.trackRef,
      sceneId: f.sceneRef,
      start: f.start,
      duration: f.duration,
      prompt: f.prompt,
      status: f.status,
      references: f.references.map((r) => ({
        id: generateId(),
        assetId: r.assetRef,
        type: r.type,
        weight: r.weight,
        ...(r.role ? { role: r.role as ImageRole } : {}),
        ...(r.cropRect ? { cropRect: r.cropRect } : {}),
        ...(r.trimRange ? { trimRange: r.trimRange } : {}),
      })),
      sourceAssetId: f.sourceAssetRef,
      resultAssetId: f.resultAssetRef,
      trimStart: f.trimStart,
      muted: f.muted,
      linkedAudioFragmentId: f.linkedAudioFragmentRef,
      providerSelection: f.providerInstanceId ? {
        instanceId: f.providerInstanceId,
        modelId: f.providerModelId ?? '',
      } : undefined,
      genParams: f.genParams,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  }

  const settingsPath = `${folderPath}/${PROJECT_SETTINGS_FILE}`;
  if (await fs.exists(settingsPath)) {
    try {
      const settingsData = await fs.readFile(settingsPath);
      const settingsFile = parseProjectSettings(arrayBufferToText(settingsData));

      result.settings = {
        fps: settingsFile.video.fps,
        resolution: settingsFile.video.resolution,
        defaultProvider: settingsFile.generation.defaultProvider,
        defaultAspectRatio: settingsFile.video.aspectRatio,
        providerConfig: {},
      };
    } catch (_err) {
      // settings file is optional — defaults are used when absent
    }
  }

  const generationsPath = `${folderPath}/${GENERATIONS_FILE}`;
  if (await fs.exists(generationsPath)) {
    try {
      const generationsData = await fs.readFile(generationsPath);
      const generationsFile = parseGenerationsFile(arrayBufferToText(generationsData));
      result.generations = generationsFile.generations;
    } catch (_err) {
      // generations file is optional — empty is a valid initial state
    }
  }

  return result;
}

/**
 * Create project folder structure
 */
export async function createProjectStructure(
  fs: FileSystemAdapter,
  folderPath: string
): Promise<void> {
  await fs.ensureDir(folderPath);
  await Promise.all(PROJECT_SUBDIRS.map((subdir) => fs.ensureDir(`${folderPath}/${subdir}`)));
}

// ============================================================================
// Autosave
// ============================================================================

/**
 * Save autosave snapshot
 */
export async function saveAutosaveSnapshot(
  project: Project,
  fs: FileSystemAdapter,
  folderPath: string
): Promise<string> {
  const timestamp = new Date();
  const timestampStr = formatFsTimestamp(timestamp);
  const autosavePath = `${folderPath}/${AUTOSAVE_DIR}/${timestampStr}`;

  await fs.ensureDir(autosavePath);

  // Create snapshot
  const snapshot: AutosaveSnapshot = {
    timestamp,
    timeline: await generateTimelineXml(project),
    project: await generateProjectXml(project),
  };

  await fs.writeFile(
    `${autosavePath}/${PROJECT_FILE}`,
    textToArrayBuffer(snapshot.project)
  );

  await fs.writeFile(
    `${autosavePath}/${TIMELINE_FILE}`,
    textToArrayBuffer(snapshot.timeline)
  );

  return autosavePath;
}

/**
 * Clean up old autosaves, keeping only the most recent N
 */
export async function cleanupAutosaves(
  fs: FileSystemAdapter,
  folderPath: string,
  keepCount: number = 20
): Promise<void> {
  const autosaveDir = `${folderPath}/${AUTOSAVE_DIR}`;

  if (!(await fs.exists(autosaveDir))) return;

  const entries = await fs.listDir(autosaveDir);

  // Filter directories and sort by name (which is timestamp)
  const autosaveDirs = entries
    .filter((e) => e.isDirectory)
    .sort((a, b) => b.name.localeCompare(a.name));

  // Delete all but the most recent keepCount
  const toDelete = autosaveDirs.slice(keepCount);

  for (const dir of toDelete) {
    await fs.removeDir(`${autosaveDir}/${dir.name}`, true);
  }
}

/**
 * List autosave snapshots
 */
export async function listAutosaves(
  fs: FileSystemAdapter,
  folderPath: string
): Promise<{ path: string; timestamp: Date }[]> {
  const autosaveDir = `${folderPath}/${AUTOSAVE_DIR}`;

  if (!(await fs.exists(autosaveDir))) return [];

  const entries = await fs.listDir(autosaveDir);

  return entries
    .filter((e) => e.isDirectory)
    .map((e) => ({
      path: e.path,
      timestamp: parseAutosaveTimestamp(e.name),
    }))
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

// ============================================================================
// Local Settings
// ============================================================================

/**
 * Load local settings (not stored in project folder)
 */
export async function loadLocalSettings(
  fs: FileSystemAdapter,
  folderPath: string
): Promise<LocalSettingsFile | null> {
  const settingsPath = `${folderPath}/${LOCAL_SETTINGS_FILE}`;

  if (!(await fs.exists(settingsPath))) return null;

  const data = await fs.readFile(settingsPath);
  return parseLocalSettings(arrayBufferToText(data));
}

/**
 * Save local settings
 */
export async function saveLocalSettings(
  settings: LocalSettingsFile,
  fs: FileSystemAdapter,
  folderPath: string
): Promise<void> {
  await fs.writeFile(
    `${folderPath}/${LOCAL_SETTINGS_FILE}`,
    textToArrayBuffer(serializeLocalSettings(settings))
  );
}

// ============================================================================
// Project File Utilities
// ============================================================================

/**
 * Find a .odp file in the given folder.
 * Returns the first .odp file found, or 'Project.odp' as fallback.
 */
export async function findProjectFile(
  fs: FileSystemAdapter,
  folderPath: string
): Promise<string> {
  try {
    const entries = await fs.listDir(folderPath);
    const odpFile = entries.find(
      (e) => !e.isDirectory && e.name.toLowerCase().endsWith('.odp')
    );
    if (odpFile) return odpFile.name;
  } catch {
    // Folder may not exist yet or listDir failed
  }
  return PROJECT_FILE;
}

/**
 * Rename the .odp project file on disk.
 */
export async function renameProjectFile(
  fs: FileSystemAdapter,
  folderPath: string,
  oldFileName: string,
  newFileName: string
): Promise<void> {
  const oldPath = `${folderPath}/${oldFileName}`;
  const newPath = `${folderPath}/${newFileName}`;

  if (await fs.exists(oldPath)) {
    await fs.moveFile(oldPath, newPath);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function calculateTimelineDuration(fragments: { start: number; duration: number }[]): number {
  if (fragments.length === 0) return 0;
  return safeMax(fragments.map((f) => f.start + f.duration));
}

function buildTimelineFile(project: Project): TimelineFile {
  return {
    duration: calculateTimelineDuration(project.fragments),
    updatedAt: project.updatedAt,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      type: track.type,
      name: track.name,
      order: track.order,
      muted: track.muted,
      locked: track.locked,
    })),
    scenes: project.scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      start: scene.start,
      duration: scene.duration,
      referenceRefs: scene.referenceIds,
    })),
    fragments: project.fragments.map((fragment) => ({
      id: fragment.id,
      trackRef: fragment.trackId,
      sceneRef: fragment.sceneId,
      start: fragment.start,
      duration: fragment.duration,
      status: toPersistableStatus(fragment.status),
      prompt: fragment.prompt,
      references: fragment.references.map((ref) => ({
        assetRef: ref.assetId,
        type: ref.type,
        weight: ref.weight ?? 0.5,
        ...(ref.role ? { role: ref.role } : {}),
        ...(ref.cropRect ? { cropRect: ref.cropRect } : {}),
        ...(ref.trimRange ? { trimRange: ref.trimRange } : {}),
      })),
      sourceAssetRef: fragment.sourceAssetId,
      resultAssetRef: fragment.resultAssetId,
      trimStart: fragment.trimStart,
      muted: fragment.muted,
      linkedAudioFragmentRef: fragment.linkedAudioFragmentId,
      providerInstanceId: fragment.providerSelection?.instanceId,
      providerModelId: fragment.providerSelection?.modelId,
      genParams: fragment.genParams,
    })),
  };
}

function buildProjectFile(project: Project): ProjectFile {
  return {
    version: '1.0',
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function generateTimelineXml(project: Project): string {
  return serializeTimelineFile(buildTimelineFile(project));
}

function generateProjectXml(project: Project): string {
  return serializeProjectFile(buildProjectFile(project));
}

/**
 * Ensure a thumbnail exists for an asset (video/image only).
 * Returns the webview URL if available, undefined if generation fails.
 */
async function ensureThumbnail(
  folderPath: string,
  assetId: string,
  type: AssetType,
  assetPath: string,
  fs: FileSystemAdapter
): Promise<string | undefined> {
  if (type === 'audio') return undefined;

  const thumbnailDiskPath = `${folderPath}/Thumbnails/${assetId}.jpg`;

  // Fast path: thumbnail already exists
  if (await fs.exists(thumbnailDiskPath)) {
    return toWebViewUrl(thumbnailDiskPath);
  }

  // Slow path: regenerate from source asset
  if (!assetPath) return undefined;

  try {
    const regeneratedPath = await generateAssetThumbnail(assetPath, fs, type, folderPath, assetId);
    return regeneratedPath ? toWebViewUrl(regeneratedPath) : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Ensure a peak data file exists for an audio asset.
 * Returns the absolute path if available, undefined if not found or generation fails.
 */
async function ensureWaveformPeakData(
  folderPath: string,
  assetId: string,
  assetPath: string,
  fs: FileSystemAdapter
): Promise<string | undefined> {
  const peakDiskPath = `${folderPath}/Thumbnails/${assetId}.peak`;

  // Fast path: peak data file already exists
  if (await fs.exists(peakDiskPath)) {
    return peakDiskPath;
  }

  // Slow path: regenerate from source audio file
  if (!assetPath) return undefined;

  try {
    const regeneratedPath = await generateAssetPeakData(assetPath, fs, folderPath, assetId);
    return regeneratedPath ?? undefined;
  } catch (_error) {
    return undefined;
  }
}

function parseAutosaveTimestamp(name: string): Date {
  try {
    return new Date(name);
  } catch {
    return new Date(0);
  }
}

async function buildAssetsFromRecords(
  records: AssetRecord[],
  folderPath: string,
  fs: FileSystemAdapter,
): Promise<Asset[]> {
  return Promise.all(records.map(async (r) => {
    const relativeAssetPath = r.path ? `${folderPath}/${r.path}` : undefined;
    const sourceAssetPath = r.sourcePath || undefined;
    const mediaPath = relativeAssetPath ?? sourceAssetPath ?? '';
    let thumbnailUrl: string | undefined;
    let waveformDataPath: string | undefined;

    if (r.type === 'audio') {
      waveformDataPath = await ensureWaveformPeakData(folderPath, r.id, mediaPath, fs);
    } else {
      thumbnailUrl = await ensureThumbnail(folderPath, r.id, r.type, mediaPath, fs);
    }

    return {
      id: r.id,
      name: r.name,
      type: r.type,
      source: r.source as AssetSource,
      url: resolvePersistedAssetUrl(relativeAssetPath, sourceAssetPath),
      relativePath: r.path,
      sourcePath: r.sourcePath,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      duration: r.duration,
      width: r.width,
      height: r.height,
      audioChannels: r.audioChannels,
      sampleRate: r.sampleRate,
      mediaMetadataHydrated: r.mediaMetadataHydrated,
      generationId: r.generationId,
      remoteAssetId: r.remoteAssetId,
      remoteAssetStatus: r.remoteAssetStatus as Asset['remoteAssetStatus'],
      tags: r.tags,
      favorite: false,
      usageCount: 0,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.createdAt),
      thumbnailUrl,
      waveformDataPath,
    };
  }));
}

function resolvePersistedAssetUrl(
  relativeAssetPath?: string,
  sourceAssetPath?: string,
): string {
  if (relativeAssetPath) {
    return toWebViewUrl(relativeAssetPath);
  }

  if (sourceAssetPath) {
    return toWebViewUrl(sourceAssetPath);
  }

  return '';
}

