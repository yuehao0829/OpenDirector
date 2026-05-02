/**
 * XMEML Import/Export Service
 *
 * Handles file I/O for XMEML (FCP7 XML) exchange between OpenDirector and
 * Adobe Premiere Pro / DaVinci Resolve / other NLEs.
 */

import type { FileSystemAdapter } from '../adapters/types';
import {
  serializeToXmeml,
  parseXmeml,
  type XmemlExportOptions,
  type XmemlExportFragment,
  type XmemlExportAsset,
  type XmemlImportResult,
} from '../utils/xml/xmeml-serializer';
import type { Project, Asset } from '../types';

// ─── Export ───────────────────────────────────────────────────────────────────

export interface XmemlExportParams {
  project: Project;
  fsAdapter: FileSystemAdapter;
  assetPathResolver: (asset: Asset) => string;
}

/**
 * Build XmemlExportOptions from a Project snapshot.
 * Shared by both exportXmeml and exportXmemlToFile.
 */
function buildExportOptions(
  project: Project,
  assetPathResolver: (asset: Asset) => string,
): XmemlExportOptions {
  const { settings, fragments, assets, tracks } = project;
  const fps = settings.fps;

  const exportableFragments = fragments.filter(f => f.sourceAssetId);
  const referencedAssetIds = new Set(exportableFragments.map(f => f.sourceAssetId!));

  // Build name lookup map for O(1) access
  const assetNameMap = new Map(assets.map(a => [a.id, a.name]));

  const exportAssets: XmemlExportAsset[] = [];
  let fileIndex = 0;
  const assetIdToFileId = new Map<string, string>();
  const assetDurationMap = new Map<string, number>();

  for (const asset of assets) {
    if (!referencedAssetIds.has(asset.id)) continue;

    const fileId = `file-${++fileIndex}`;
    assetIdToFileId.set(asset.id, fileId);
    if (asset.duration) {
      assetDurationMap.set(fileId, asset.duration);
    }

    exportAssets.push({
      id: fileId,
      name: asset.name,
      filePath: assetPathResolver(asset),
      duration: asset.duration || 0,
      type: asset.type === 'audio' ? 'audio' as const : 'video' as const,
      width: asset.width,
      height: asset.height,
    });
  }

  const trackTypeMap = new Map(tracks.map(t => [t.id, t.type as 'video' | 'audio']));
  const trackOrderMap = new Map(tracks.map(t => [t.id, t.order]));

  let clipIndex = 0;
  const exportFragments: XmemlExportFragment[] = exportableFragments.map(frag => {
    const fileId = assetIdToFileId.get(frag.sourceAssetId!) || frag.sourceAssetId!;
    return {
      id: `clip-${++clipIndex}`,
      start: frag.start,
      duration: frag.duration,
      trimStart: frag.trimStart,
      sourceDuration: assetDurationMap.get(fileId),
      sourceAssetId: fileId,
      name: frag.prompt || assetNameMap.get(frag.sourceAssetId!) || 'Clip',
      trackType: trackTypeMap.get(frag.trackId) || 'video',
      trackIndex: trackOrderMap.get(frag.trackId) ?? 0,
    };
  });

  return {
    projectName: project.name,
    fps,
    width: settings.resolution.width,
    height: settings.resolution.height,
    assets: exportAssets,
    fragments: exportFragments,
    scenes: project.scenes.map(s => ({
      name: s.name,
      start: s.start,
      duration: s.duration,
    })),
  };
}

function serializeToBuffer(options: XmemlExportOptions): ArrayBuffer {
  const xmlString = serializeToXmeml(options);
  return new TextEncoder().encode(xmlString).buffer as ArrayBuffer;
}

/**
 * Export a project as XMEML file to the project folder.
 */
export async function exportXmeml(params: XmemlExportParams): Promise<void> {
  const options = buildExportOptions(params.project, params.assetPathResolver);
  const buffer = serializeToBuffer(options);
  await params.fsAdapter.writeFile(params.project.folderPath || '', buffer);
}

/**
 * Export XMEML to a specific file path (bypass project folder).
 */
export async function exportXmemlToFile(
  params: XmemlExportParams,
  filePath: string,
): Promise<void> {
  const options = buildExportOptions(params.project, params.assetPathResolver);
  const buffer = serializeToBuffer(options);
  await params.fsAdapter.writeFile(filePath, buffer);
}

// ─── Import ───────────────────────────────────────────────────────────────────

export interface XmemlImportParams {
  filePath: string;
  fsAdapter: FileSystemAdapter;
}

/**
 * Import an XMEML file and convert to OpenDirector data model.
 * After parsing, verifies whether referenced asset files exist on disk.
 */
export async function importXmeml(
  params: XmemlImportParams,
): Promise<XmemlImportResult> {
  const { filePath, fsAdapter } = params;

  const buffer = await fsAdapter.readFile(filePath);
  const xmlString = new TextDecoder('utf-8').decode(buffer);

  const result = parseXmeml(xmlString);

  // Verify asset file existence and collect warnings for missing files
  const existenceWarnings: string[] = [];
  await Promise.allSettled(result.assets.map(async (asset) => {
    if (!asset.localPath) {
      asset.exists = false;
      existenceWarnings.push(`Asset "${asset.name}" has no file path`);
      return;
    }
    try {
      asset.exists = await fsAdapter.exists(asset.localPath);
    } catch {
      asset.exists = false;
    }
    if (!asset.exists) {
      existenceWarnings.push(`Asset file not found: ${asset.localPath}`);
    }
  }));
  result.warnings.push(...existenceWarnings);

  return result;
}
