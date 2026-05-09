import type { Asset } from '../types/asset';
import type { Project } from '../types/project';
import type { Fragment, Track } from '../types/timeline';
import type {
  PreviewDiagnostics,
  PreviewSessionErrorEvent,
  PreviewSessionEvent,
  PreviewSessionFrameTimestampEvent,
  PreviewSessionInfo,
  PreviewSessionMetricsEvent,
  PreviewSessionPositionEvent,
  PreviewSessionStateEvent,
  PreviewViewport,
  TimelinePreviewSnapshot,
} from '../types/media-preview';
import { isTauri } from '../utils/platform';
import { calculateTimelineDuration } from '../utils/timeline';
import { resolveProjectAssetPath } from './otio-io';
import { buildProjectMediaTimeline } from './project-media-timeline';
import { tauriBridge } from './tauri-bridge';

const PREVIEW_POSITION_EVENT = 'media-preview://position';
const PREVIEW_STATE_EVENT = 'media-preview://state';
const PREVIEW_ERROR_EVENT = 'media-preview://error';
const PREVIEW_METRICS_EVENT = 'media-preview://metrics';
const PREVIEW_FRAME_TIMESTAMP_EVENT = 'media-preview://frame-timestamp';
const FEATURE_FLAG_STORAGE_KEY = 'opendirector.nativeTimelinePreview';
const DEBUG_PRESENT_SURFACE_STORAGE_KEY = 'opendirector.nativeTimelinePreview.debugPresentSurface';

export interface BuildTimelinePreviewSnapshotOptions {
  project: Project;
  tracks?: Track[];
  fragments?: Fragment[];
  assets?: Asset[];
}

export function isNativeTimelinePreviewEnabled(): boolean {
  if (!isTauri() || typeof window === 'undefined') {
    return false;
  }

  const override = window.localStorage.getItem(FEATURE_FLAG_STORAGE_KEY);
  if (override === '0' || override === 'false') {
    return false;
  }
  if (override === '1' || override === 'true') {
    return true;
  }

  return true;
}

export function isNativeTimelinePreviewDebugPresentSurfaceEnabled(): boolean {
  if (!isNativeTimelinePreviewEnabled() || typeof window === 'undefined') {
    return false;
  }

  const override = window.localStorage.getItem(DEBUG_PRESENT_SURFACE_STORAGE_KEY);
  if (override === '0' || override === 'false') {
    return false;
  }

  return true;
}

export function buildTimelinePreviewSnapshot(
  options: BuildTimelinePreviewSnapshotOptions,
): TimelinePreviewSnapshot {
  const project = {
    ...options.project,
    tracks: options.tracks ?? options.project.tracks,
    fragments: options.fragments ?? options.project.fragments,
    assets: options.assets ?? options.project.assets,
  };

  if (!project.folderPath) {
    throw new Error('Native timeline preview requires a saved project folder');
  }
  const projectPath = project.folderPath;

  const timeline = buildProjectMediaTimeline({
    project,
    assetPathResolver: (asset) => resolveProjectAssetPath(project, asset),
    missingAssetErrorLabel: 'Timeline preview',
    includeVideoSourceAudio: true,
    missingMediaPolicy: 'skip',
    emptyTimelinePolicy: 'allow',
  });

  return {
    projectPath,
    durationMs: calculateTimelineDuration(project.fragments, project.scenes),
    fps: timeline.fps,
    canvasWidth: timeline.width,
    canvasHeight: timeline.height,
    tracks: timeline.tracks.map((track) => ({
      id: track.id,
      type: track.type,
      muted: track.muted,
      order: track.order,
    })),
    fragments: timeline.clips.map((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      absolutePath: clip.inputPath,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      trimStartMs: clip.trimStartMs ?? 0,
      muted: false,
      crop: clip.crop,
      transform: clip.transform,
    })),
  };
}

type PreviewSessionListener = (event: PreviewSessionEvent) => void;

export class PreviewSessionController {
  private session: PreviewSessionInfo | null = null;
  private unlisten: Array<() => void> = [];
  private listeners = new Set<PreviewSessionListener>();

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  get info(): PreviewSessionInfo | null {
    return this.session;
  }

  subscribe(listener: PreviewSessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(windowLabel = 'main'): Promise<PreviewSessionInfo | null> {
    if (!isNativeTimelinePreviewEnabled()) {
      return null;
    }

    if (this.session) {
      return this.session;
    }

    const session = await tauriBridge.previewApi.createSession(windowLabel);
    this.session = session;
    await this.attachEventListeners();
    return session;
  }

  async destroy(): Promise<void> {
    const sessionId = this.session?.sessionId;
    this.teardownListeners();
    this.session = null;
    if (!sessionId) {
      return;
    }

    try {
      await tauriBridge.previewApi.destroySession(sessionId);
    } finally {
      this.teardownListeners();
      this.session = null;
    }
  }

  async attachSurface(
    surfaceId?: string | null,
    options?: {
      viewport?: PreviewViewport | null;
      surfaceSyncRevision?: number | null;
    },
  ): Promise<PreviewSessionInfo | null> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return null;
    const session = await tauriBridge.previewApi.attachSurface(
      sessionId,
      surfaceId ?? null,
      options?.viewport ?? null,
      options?.surfaceSyncRevision ?? null,
    );
    this.session = session;
    return session;
  }

  async setViewport(viewport: PreviewViewport, surfaceSyncRevision?: number | null): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.setViewport(sessionId, viewport, surfaceSyncRevision ?? null);
  }

  async setSurfacePresenting(
    presenting: boolean,
    surfaceSyncRevision?: number | null,
  ): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.setSurfacePresenting(
      sessionId,
      presenting,
      surfaceSyncRevision ?? null,
    );
  }

  async setTimeline(snapshot: TimelinePreviewSnapshot): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.setTimeline(sessionId, snapshot);
  }

  async play(): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.play(sessionId);
  }

  async playFrom(timeMs: number): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.playFrom(sessionId, timeMs);
  }

  async pause(): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.pause(sessionId);
  }

  async seek(timeMs: number): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.seek(sessionId, timeMs);
  }

  async stepFrame(direction: 1 | -1 = 1): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.stepFrame(sessionId, direction);
  }

  async setRate(rate: number): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return;
    await tauriBridge.previewApi.setRate(sessionId, rate);
  }

  async getDiagnostics(): Promise<PreviewDiagnostics | null> {
    const sessionId = this.requireSessionId();
    if (!sessionId) return null;
    return tauriBridge.previewApi.getDiagnostics(sessionId);
  }

  private requireSessionId(): string | null {
    return isNativeTimelinePreviewEnabled() ? (this.session?.sessionId ?? null) : null;
  }

  private async attachEventListeners(): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId) return;

    const listeners = await Promise.all([
      tauriBridge.listen<PreviewSessionPositionEvent>(PREVIEW_POSITION_EVENT, (payload) => {
        if (payload.sessionId === sessionId) {
          this.emit({ type: 'position', payload });
        }
      }),
      tauriBridge.listen<PreviewSessionStateEvent>(PREVIEW_STATE_EVENT, (payload) => {
        if (payload.sessionId === sessionId) {
          this.applyStateEvent(payload);
          this.emit({ type: 'state', payload });
        }
      }),
      tauriBridge.listen<PreviewSessionErrorEvent>(PREVIEW_ERROR_EVENT, (payload) => {
        if (payload.sessionId === sessionId) {
          this.emit({ type: 'error', payload });
        }
      }),
      tauriBridge.listen<PreviewSessionMetricsEvent>(PREVIEW_METRICS_EVENT, (payload) => {
        if (payload.sessionId === sessionId) {
          this.emit({ type: 'metrics', payload });
        }
      }),
      tauriBridge.listen<PreviewSessionFrameTimestampEvent>(
        PREVIEW_FRAME_TIMESTAMP_EVENT,
        (payload) => {
          if (payload.sessionId === sessionId) {
            this.emit({ type: 'frameTimestamp', payload });
          }
        },
      ),
    ]);

    this.unlisten = listeners;
  }

  private teardownListeners(): void {
    for (const unlisten of this.unlisten) {
      unlisten();
    }
    this.unlisten = [];
  }

  private emit(event: PreviewSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private applyStateEvent(payload: PreviewSessionStateEvent): void {
    if (!this.session || this.session.sessionId !== payload.sessionId) {
      return;
    }

    this.session = {
      ...this.session,
      state: payload.state,
      nativeSurfaceAttached: payload.nativeSurfaceAttached,
      timelineAttached: payload.timelineAttached,
    };
  }
}
