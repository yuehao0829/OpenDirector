/**
 * XMEML Import/Export Service
 *
 * Handles file I/O for XMEML (FCP7 XML) exchange between OpenDirector and
 * Adobe Premiere Pro / DaVinci Resolve / other NLEs.
 */

import type { FileSystemAdapter } from '../adapters/types';
import { textToArrayBuffer, arrayBufferToText } from '../utils/encoding';
import {
  serializeToXmeml,
  parseXmeml,
  type XmemlExportOptions,
  type XmemlExportFragment,
  type XmemlExportAsset,
  type XmemlImportResult,
} from '../utils/xml/xmeml-serializer';
import type { Project, Asset, Fragment } from '../types';

// ─── Export ───────────────────────────────────────────────────────────────────

export interface XmemlExportParams {
  project: Project;
  fsAdapter: FileSystemAdapter;
  assetPathResolver: (asset: Asset) => string;
}

/**
 * Build XmemlExportOptions from a Project snapshot.
 * Probes audio metadata for video assets to determine if they have embedded audio tracks.
 */
async function buildExportOptions(
  project: Project,
  fsAdapter: FileSystemAdapter,
  assetPathResolver: (asset: Asset) => string,
): Promise<XmemlExportOptions> {
  const { settings, fragments, assets, tracks } = project;
  const fps = settings.fps;

  const exportableFragments: Fragment[] = [];
  const referencedAssetIds = new Set<string>();
  const assetNameMap = new Map<string, string>();
  const assetPathCache = new Map<string, string>();
  const assetById = new Map(assets.map(a => [a.id, a]));

  for (const asset of assets) {
    assetNameMap.set(asset.id, asset.name);
  }

  for (const frag of fragments) {
    if (!frag.sourceAssetId) continue;
    exportableFragments.push(frag);
    referencedAssetIds.add(frag.sourceAssetId);
  }

  for (const assetId of referencedAssetIds) {
    const asset = assetById.get(assetId);
    if (asset) {
      assetPathCache.set(assetId, assetPathResolver(asset));
    }
  }

  // Probe audio metadata for referenced video assets that haven't been hydrated
  const audioProbeResults = new Map<string, { audioChannels?: number; sampleRate?: number }>();

  const assetsToProbe = assets.filter(
    a => referencedAssetIds.has(a.id) && a.type !== 'audio' && !a.mediaMetadataHydrated,
  );

  await Promise.all(assetsToProbe.map(async (asset) => {
    const mediaPath = assetPathCache.get(asset.id);
    if (!mediaPath) return;

    try {
      const metadata = await fsAdapter.getMediaMetadata(mediaPath);
      const channels = metadata.audioChannels ?? 0;
      if (channels > 0) {
        audioProbeResults.set(asset.id, {
          audioChannels: channels,
          sampleRate: metadata.sampleRate,
        });
      }
    } catch {
      // probe failed — treat as no audio
    }
  }));

  function assetHasAudio(asset: Asset): boolean {
    if (asset.type === 'audio') return true;
    const probe = audioProbeResults.get(asset.id);
    if (probe) return probe.audioChannels !== undefined && probe.audioChannels > 0;
    return (asset.audioChannels ?? 0) > 0;
  }

  function resolveAssetAudioChannels(asset: Asset): number | undefined {
    if (asset.type === 'audio') return asset.audioChannels;
    return audioProbeResults.get(asset.id)?.audioChannels ?? asset.audioChannels;
  }

  function resolveAssetSampleRate(asset: Asset): number | undefined {
    if (asset.type === 'audio') return asset.sampleRate;
    return audioProbeResults.get(asset.id)?.sampleRate ?? asset.sampleRate;
  }

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
      filePath: assetPathCache.get(asset.id)!,
      duration: asset.duration || 0,
      type: asset.type === 'audio' ? 'audio' : 'video',
      hasAudio: assetHasAudio(asset),
      width: asset.width,
      height: asset.height,
      audioChannels: resolveAssetAudioChannels(asset),
      sampleRate: resolveAssetSampleRate(asset),
    });
  }

  const trackTypeMap = new Map(tracks.map(t => [t.id, t.type as 'video' | 'audio']));
  const trackOrderMap = new Map(tracks.map(t => [t.id, t.order]));

  let clipIndex = 0;
  const exportFragments: XmemlExportFragment[] = [];
  const linkedAudioFragments: XmemlExportFragment[] = [];

  // Allocate linked audio track indices starting after existing audio tracks
  const maxAudioOrder = tracks
    .filter(t => t.type === 'audio')
    .reduce((max, t) => Math.max(max, t.order), -1);
  let linkedAudioTrackSeed = maxAudioOrder + 1;
  const videoTrackAudioIndices = new Map<number, number>();

  for (const frag of exportableFragments) {
    const fileId = assetIdToFileId.get(frag.sourceAssetId!) || frag.sourceAssetId!;
    const exportFrag: XmemlExportFragment = {
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
    exportFragments.push(exportFrag);

    // Premiere Pro requires separate clipitems in the <audio> section to play audio;
    // clipitems in the <video> section are video-only regardless of the <file> media.
    if (exportFrag.trackType !== 'video') continue;
    const sourceAsset = assetById.get(frag.sourceAssetId!);
    if (!sourceAsset || !assetHasAudio(sourceAsset)) continue;

    if (!videoTrackAudioIndices.has(exportFrag.trackIndex)) {
      videoTrackAudioIndices.set(exportFrag.trackIndex, linkedAudioTrackSeed++);
    }

    linkedAudioFragments.push({
      id: `clip-${++clipIndex}`,
      start: exportFrag.start,
      duration: exportFrag.duration,
      trimStart: exportFrag.trimStart,
      sourceDuration: exportFrag.sourceDuration,
      sourceAssetId: exportFrag.sourceAssetId,
      name: exportFrag.name,
      trackType: 'audio',
      trackIndex: videoTrackAudioIndices.get(exportFrag.trackIndex)!,
    });
  }

  exportFragments.push(...linkedAudioFragments);

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
  return textToArrayBuffer(xmlString);
}

/**
 * Export a project as XMEML file to the project folder.
 */
export async function exportXmeml(params: XmemlExportParams): Promise<void> {
  const options = await buildExportOptions(params.project, params.fsAdapter, params.assetPathResolver);
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
  const options = await buildExportOptions(params.project, params.fsAdapter, params.assetPathResolver);
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
  const xmlString = arrayBufferToText(buffer);

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
