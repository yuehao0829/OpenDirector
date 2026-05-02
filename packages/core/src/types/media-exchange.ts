export type MediaExchangeFormat = 'otio' | 'xges';

export interface MediaExchangeWarning {
  code: string;
  message: string;
  path?: string;
}

export interface MediaExchangeSummary {
  projectName?: string;
  durationMs?: number;
  trackCount?: number;
  clipCount?: number;
  assetCount?: number;
}

export interface MediaExchangeExportResult {
  format: MediaExchangeFormat;
  outputPath: string;
  warnings: MediaExchangeWarning[];
  summary?: MediaExchangeSummary;
}

export interface MediaExchangeImportResult {
  format: MediaExchangeFormat;
  sourcePath: string;
  warnings: MediaExchangeWarning[];
  summary?: MediaExchangeSummary;
}

export interface ImportedTimelineAsset {
  id: string;
  name: string;
  localPath: string;
  duration?: number;
  type: 'video' | 'image' | 'audio';
  width?: number;
  height?: number;
  audioChannels?: number;
  sampleRate?: number;
  mediaMetadataHydrated?: boolean;
}

export interface ImportedTimelineFragment {
  id: string;
  name: string;
  start: number;
  duration: number;
  trimStart?: number;
  sourceAssetId?: string;
  crop?: XgesTimelineCrop;
}

export interface ImportedTimelineTrack {
  id: string;
  type: 'video' | 'audio';
  name: string;
  muted: boolean;
  order: number;
  fragments: ImportedTimelineFragment[];
}

export interface XgesImportResult extends MediaExchangeImportResult {
  projectName: string;
  fps: number;
  width: number;
  height: number;
  assets: ImportedTimelineAsset[];
  tracks: ImportedTimelineTrack[];
  totalDuration: number;
}

export interface OtioExportRequest {
  projectPath: string;
  outputPath?: string;
}

export interface OtioImportRequest {
  filePath: string;
  projectPath?: string;
}

export interface XgesExportRequest {
  projectPath: string;
  outputPath?: string;
  timeline: XgesTimelineExportPayload;
}

export interface XgesImportRequest {
  filePath: string;
  projectPath?: string;
}

export interface XgesTimelineExportPayload {
  projectName?: string;
  width: number;
  height: number;
  fps: number;
  tracks: XgesTimelineTrack[];
  clips: XgesTimelineClip[];
}

export interface XgesTimelineTrack {
  id: string;
  type: 'video' | 'audio';
  muted: boolean;
  order: number;
}

export interface XgesTimelineClip {
  id: string;
  trackId: string;
  inputPath: string;
  name?: string;
  startMs: number;
  durationMs: number;
  trimStartMs?: number;
  mute?: boolean;
  crop?: XgesTimelineCrop;
}

export interface XgesTimelineCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
