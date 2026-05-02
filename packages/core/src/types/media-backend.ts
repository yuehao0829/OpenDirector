import type { PreviewTransform } from './media-preview';

export type MediaBackendId = 'gstreamerGes';

export interface AssetProcessRequest {
  backend?: MediaBackendId;
  inputPath: string;
  outputDir: string;
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
  trimStartMs?: number;
  trimEndMs?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxFileSize?: number;
  targetAspectRatio?: string;
  outputFormat?: string;
}

export interface MediaProcessResult {
  outputPath: string;
  fileSize: number;
  backendUsed: MediaBackendId;
}

export interface MediaConcatRequest {
  backend?: MediaBackendId;
  inputPaths: string[];
  outputDir: string;
  outputFilename: string;
}

export interface MediaConcatResult {
  outputPath: string;
  fileSize: number;
  backendUsed: MediaBackendId;
}

export interface MediaProbeRequest {
  backend?: MediaBackendId;
  path: string;
}

export interface MediaProbeResult {
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  frame_rate: number | null;
  channels: number | null;
  sample_rate: number | null;
  codec?: string | null;
}

export interface TimelineRenderTrack {
  id: string;
  type: 'video' | 'audio';
  muted: boolean;
  order: number;
}

export interface TimelineRenderClip {
  id: string;
  trackId: string;
  assetId?: string;
  inputPath?: string;
  startMs: number;
  durationMs: number;
  trimStartMs?: number;
  mute?: boolean;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  transform?: PreviewTransform;
}

export interface TimelineRenderRequest {
  backend?: MediaBackendId;
  outputPath: string;
  outputFormat?: string;
  width: number;
  height: number;
  fps: number;
  tracks: TimelineRenderTrack[];
  clips: TimelineRenderClip[];
}

export interface TimelineRenderResult {
  outputPath: string;
  fileSize: number;
  backendUsed: MediaBackendId;
}
