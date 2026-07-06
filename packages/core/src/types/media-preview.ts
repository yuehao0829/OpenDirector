import type { CropRect } from './asset';

export type PreviewSessionState =
  | 'idle'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'ended'
  | 'error'
  | 'destroyed';

export interface PreviewTransform {
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotationDeg?: number;
  opacity?: number;
}

export interface TimelinePreviewTrack {
  id: string;
  type: 'video' | 'audio';
  muted: boolean;
  order: number;
}

export interface TimelinePreviewFragment {
  id: string;
  trackId: string;
  absolutePath: string;
  startMs: number;
  durationMs: number;
  trimStartMs: number;
  muted: boolean;
  volume?: number;
  crop?: CropRect;
  transform?: PreviewTransform;
}

export interface TimelinePreviewSnapshot {
  projectPath: string;
  durationMs: number;
  fps: number;
  canvasWidth: number;
  canvasHeight: number;
  tracks: TimelinePreviewTrack[];
  fragments: TimelinePreviewFragment[];
}

export interface PreviewViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  visible: boolean;
}

export interface PreviewSurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewSessionInfo {
  sessionId: string;
  windowLabel: string;
  state: PreviewSessionState;
  nativeSurfaceSupported: boolean;
  nativeSurfaceImplemented?: boolean;
  nativeSurfacePlatformStatus?: string;
  nativeSurfacePlatformReason?: string | null;
  nativeSurfaceAttached: boolean;
  timelineAttached: boolean;
}

export interface PreviewSessionPositionEvent {
  sessionId: string;
  positionMs: number;
  isPlaying: boolean;
  isBuffering: boolean;
  driftMs: number;
  rate: number;
  epoch: number;
}

export interface PreviewSessionFrameTimestampEvent {
  sessionId: string;
  positionMs: number;
  epoch: number;
}

export interface PreviewSessionStateEvent {
  sessionId: string;
  state: PreviewSessionState;
  positionMs: number;
  rate: number;
  nativeSurfaceAttached: boolean;
  timelineAttached: boolean;
  message?: string;
  epoch: number;
}

export interface PreviewSessionErrorEvent {
  sessionId: string;
  message: string;
  details?: string;
}

export interface PreviewSessionMetrics {
  timelineUpdates: number;
  seekCount: number;
  warmSeekCount: number;
  coldSeekCount: number;
  stepCount: number;
  playCount: number;
  pauseCount: number;
  viewportUpdates: number;
  seekBurstCount: number;
  maxSeekBurstCount: number;
  lastSeekLatencyMs: number;
  maxSeekLatencyMs: number;
}

export interface PreviewSessionMetricsEvent {
  sessionId: string;
  state: PreviewSessionState;
  metrics: PreviewSessionMetrics;
}

export interface PreviewRuntimeDiagnostics {
  gstreamerReady: boolean;
  gstreamerReason?: string | null;
  runtimeRoot?: string | null;
  gesLaunchPath?: string | null;
}

export interface PreviewDiagnostics {
  sessionId: string;
  windowLabel: string;
  state: PreviewSessionState;
  playbackBackend: string;
  configuredVideoSinkType?: string | null;
  nativeSurfaceSupported: boolean;
  nativeSurfaceImplemented?: boolean;
  nativeSurfacePlatformStatus?: string;
  nativeSurfacePlatformReason?: string | null;
  nativeSurfaceType?: string | null;
  nativeSurfaceAttached: boolean;
  nativeSurfaceVisible?: boolean;
  nativeSurfacePresenting?: boolean;
  nativeSurfaceEmbeddedContentAttached?: boolean;
  attachedSurfaceId?: string | null;
  nativeHostWindowHandle?: string | null;
  nativeSurfaceWindowHandle?: string | null;
  nativeSurfacePhysicalRect?: PreviewSurfaceRect | null;
  timelineAttached: boolean;
  durationMs: number;
  positionMs: number;
  rate: number;
  transportEpoch: number;
  pendingSeekTargetMs: number | null;
  viewport?: PreviewViewport | null;
  timelineTrackCount: number;
  timelineFragmentCount: number;
  preparedTimelineTrackCount: number;
  preparedTimelineClipCount: number;
  runtime: PreviewRuntimeDiagnostics;
  lastError?: string | null;
  metrics: PreviewSessionMetrics;
}

export type PreviewSessionEvent =
  | { type: 'position'; payload: PreviewSessionPositionEvent }
  | { type: 'state'; payload: PreviewSessionStateEvent }
  | { type: 'error'; payload: PreviewSessionErrorEvent }
  | { type: 'metrics'; payload: PreviewSessionMetricsEvent }
  | { type: 'frameTimestamp'; payload: PreviewSessionFrameTimestampEvent };
