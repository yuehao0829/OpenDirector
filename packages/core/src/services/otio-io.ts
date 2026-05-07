import type { FileSystemAdapter } from '../adapters/types';
import type { Asset, Project } from '../types';
import type {
  MediaExchangeExportResult,
  MediaExchangeImportResult,
  OtioExportRequest,
  OtioImportRequest,
} from '../types/media-exchange';
import {
  buildProjectAssetPathResolver,
  mapOtioTimelineToProjectData,
  mapProjectToOtioTimeline,
  parseOtioTimeline,
  serializeOtioTimelineToBuffer,
  type OtioImportResult,
  type OtioAssetPathResolver,
} from '../utils/otio';
import { arrayBufferToText } from '../utils/encoding';
import { guardedInvoke } from '../utils/tauri-invoke';

function requirePath(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`OTIO ${fieldName} is required`);
  }
  return normalized;
}

export async function exportOtio(
  request: OtioExportRequest,
): Promise<MediaExchangeExportResult> {
  return guardedInvoke('export_otio', {
    request: {
      ...request,
      projectPath: requirePath(request.projectPath, 'projectPath'),
      outputPath: request.outputPath?.trim() || undefined,
    },
  });
}

export async function importOtio(
  request: OtioImportRequest,
): Promise<MediaExchangeImportResult> {
  return guardedInvoke('import_otio', {
    request: {
      ...request,
      filePath: requirePath(request.filePath, 'filePath'),
      projectPath: request.projectPath?.trim() || undefined,
    },
  });
}

export interface ExportOtioToFileParams {
  project: Project;
  fsAdapter: FileSystemAdapter;
  assetPathResolver?: OtioAssetPathResolver;
  outputPath?: string;
}

export interface ImportOtioFromFileParams {
  filePath: string;
  fsAdapter: FileSystemAdapter;
}

export async function exportOtioToFile(
  params: ExportOtioToFileParams,
  filePath?: string,
): Promise<MediaExchangeExportResult> {
  const outputPath = resolveExportPath(params.project, filePath ?? params.outputPath);
  const assetPathResolver = params.assetPathResolver ?? buildProjectAssetPathResolver(params.project);
  const result = mapProjectToOtioTimeline({
    project: params.project,
    assetPathResolver,
  });

  await params.fsAdapter.writeFile(outputPath, serializeOtioTimelineToBuffer(result.timeline));

  return {
    format: 'otio',
    outputPath,
    warnings: result.warnings,
    summary: result.summary,
  };
}

export async function importOtioFromFile(
  params: ImportOtioFromFileParams,
): Promise<OtioImportResult> {
  const buffer = await params.fsAdapter.readFile(params.filePath);
  const otioString = arrayBufferToText(buffer);
  const timeline = parseOtioTimeline(otioString);
  const result = mapOtioTimelineToProjectData(timeline);

  await Promise.allSettled(result.assets.map(async (asset) => {
    if (!isLocalFilePath(asset.localPath)) {
      asset.exists = false;
      return;
    }

    try {
      asset.exists = await params.fsAdapter.exists(asset.localPath);
    } catch {
      asset.exists = false;
    }

    if (!asset.exists) {
      result.warnings.push({
        code: 'missing_asset_file',
        message: `Asset file not found during OTIO import: ${asset.localPath}`,
        path: asset.localPath,
      });
    }
  }));

  return result;
}

export function resolveDefaultOtioPath(project: Pick<Project, 'folderPath'>): string {
  if (!project.folderPath) {
    throw new Error('OTIO export requires a saved project folder');
  }
  return `${project.folderPath}/Timeline.otio.json`;
}

export function resolveProjectAssetPath(
  project: Project,
  asset: Asset,
): string | undefined {
  return buildProjectAssetPathResolver(project)(asset);
}

export const otioIo = {
  exportOtioToFile,
  importOtioFromFile,
  exportOtio,
  importOtio,
};

function resolveExportPath(project: Project, outputPath?: string): string {
  if (outputPath?.trim()) {
    return outputPath.trim();
  }
  return resolveDefaultOtioPath(project);
}

function isLocalFilePath(value: string): boolean {
  return !/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}
