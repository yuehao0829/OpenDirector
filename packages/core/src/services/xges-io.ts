import { guardedInvoke } from '../utils/tauri-invoke';
import type {
  MediaExchangeExportResult,
  XgesExportRequest,
  XgesImportRequest,
  XgesImportResult,
  XgesTimelineExportPayload,
} from '../types/media-exchange';

function requirePath(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`XGES ${fieldName} is required`);
  }
  return normalized;
}

export async function exportXges(
  request: XgesExportRequest,
): Promise<MediaExchangeExportResult> {
  return guardedInvoke('export_xges', {
    request: {
      ...request,
      projectPath: requirePath(request.projectPath, 'projectPath'),
      outputPath: request.outputPath?.trim() || undefined,
    },
  });
}

export async function importXges(
  request: XgesImportRequest,
): Promise<XgesImportResult> {
  return guardedInvoke('import_xges', {
    request: {
      ...request,
      filePath: requirePath(request.filePath, 'filePath'),
      projectPath: request.projectPath?.trim() || undefined,
    },
  });
}

export interface ExportXgesToFileParams {
  projectPath: string;
  outputPath?: string;
  timeline: XgesTimelineExportPayload;
}

export interface ImportXgesFromFileParams {
  filePath: string;
  projectPath?: string;
}

export async function exportXgesToFile(
  params: ExportXgesToFileParams,
): Promise<MediaExchangeExportResult> {
  return exportXges({
    projectPath: requirePath(params.projectPath, 'projectPath'),
    outputPath: params.outputPath?.trim() || undefined,
    timeline: params.timeline,
  });
}

export async function importXgesFromFile(
  params: ImportXgesFromFileParams,
): Promise<XgesImportResult> {
  return importXges({
    filePath: requirePath(params.filePath, 'filePath'),
    projectPath: params.projectPath?.trim() || undefined,
  });
}

export const xgesIo = {
  exportXges,
  importXges,
  exportXgesToFile,
  importXgesFromFile,
};
