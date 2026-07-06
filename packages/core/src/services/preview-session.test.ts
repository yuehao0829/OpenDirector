import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSessionMock,
  destroySessionMock,
  attachSurfaceMock,
  setViewportMock,
  setSurfacePresentingMock,
  setTimelineMock,
  playMock,
  playFromMock,
  pauseMock,
  seekMock,
  stepFrameMock,
  setRateMock,
  getDiagnosticsMock,
  listenMock,
  listenerRegistry,
} = vi.hoisted(() => {
  const registry = new Map<string, (payload: unknown) => void>();

  return {
    createSessionMock: vi.fn(),
    destroySessionMock: vi.fn(),
    attachSurfaceMock: vi.fn(),
    setViewportMock: vi.fn(),
    setSurfacePresentingMock: vi.fn(),
    setTimelineMock: vi.fn(),
    playMock: vi.fn(),
    playFromMock: vi.fn(),
    pauseMock: vi.fn(),
    seekMock: vi.fn(),
    stepFrameMock: vi.fn(),
    setRateMock: vi.fn(),
    getDiagnosticsMock: vi.fn(),
    listenMock: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
      registry.set(event, handler);
      return () => {
        registry.delete(event);
      };
    }),
    listenerRegistry: registry,
  };
});

vi.mock('../utils/platform', () => ({
  isTauri: () => true,
}));

vi.mock('./tauri-bridge', () => ({
  tauriBridge: {
    previewApi: {
      createSession: createSessionMock,
      destroySession: destroySessionMock,
      attachSurface: attachSurfaceMock,
      setViewport: setViewportMock,
      setSurfacePresenting: setSurfacePresentingMock,
      setTimeline: setTimelineMock,
      play: playMock,
      playFrom: playFromMock,
      pause: pauseMock,
      seek: seekMock,
      stepFrame: stepFrameMock,
      setRate: setRateMock,
      getDiagnostics: getDiagnosticsMock,
    },
    listen: listenMock,
  },
}));

import {
  PreviewSessionController,
  buildTimelinePreviewSnapshot,
  isNativeTimelinePreviewDebugPresentSurfaceEnabled,
} from './preview-session';
import { DEFAULT_SCENE_DURATION_MS } from './project-defaults';
import {
  registerNativePreviewStepFrameHandler,
  requestNativePreviewStepFrame,
} from '../stores/timelineStore';

describe('PreviewSessionController', () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    destroySessionMock.mockReset();
    attachSurfaceMock.mockReset();
    setViewportMock.mockReset();
    setSurfacePresentingMock.mockReset();
    setTimelineMock.mockReset();
    playMock.mockReset();
    playFromMock.mockReset();
    pauseMock.mockReset();
    seekMock.mockReset();
    stepFrameMock.mockReset();
    setRateMock.mockReset();
    getDiagnosticsMock.mockReset();
    listenMock.mockClear();
    listenerRegistry.clear();

    createSessionMock.mockResolvedValue({
      sessionId: 'session-1',
      windowLabel: 'main',
      state: 'idle',
      nativeSurfaceSupported: true,
      nativeSurfaceImplemented: true,
      nativeSurfacePlatformStatus: 'supported',
      nativeSurfacePlatformReason: null,
      nativeSurfaceAttached: false,
      timelineAttached: false,
    });
    attachSurfaceMock.mockResolvedValue({
      sessionId: 'session-1',
      windowLabel: 'main',
      state: 'idle',
      nativeSurfaceSupported: true,
      nativeSurfaceImplemented: true,
      nativeSurfacePlatformStatus: 'supported',
      nativeSurfacePlatformReason: null,
      nativeSurfaceAttached: true,
      timelineAttached: false,
    });

    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn((key: string) =>
          key === 'opendirector.nativeTimelinePreview' ? 'true' : null,
        ),
      },
    });
  });

  it('updates cached session info from command responses and state events', async () => {
    const controller = new PreviewSessionController();
    const receivedEvents: Array<{ type: string; payload: unknown }> = [];

    controller.subscribe((event) => {
      receivedEvents.push(event as { type: string; payload: unknown });
    });

    await controller.create('main');
    expect(controller.info).toEqual({
      sessionId: 'session-1',
      windowLabel: 'main',
      state: 'idle',
      nativeSurfaceSupported: true,
      nativeSurfaceImplemented: true,
      nativeSurfacePlatformStatus: 'supported',
      nativeSurfacePlatformReason: null,
      nativeSurfaceAttached: false,
      timelineAttached: false,
    });

    await controller.attachSurface('surface-host');
    expect(controller.info?.nativeSurfaceAttached).toBe(true);

    const emitState = listenerRegistry.get('media-preview://state');
    expect(emitState).toBeTypeOf('function');

    emitState?.({
      sessionId: 'session-1',
      state: 'playing',
      positionMs: 120,
      rate: 1,
      nativeSurfaceAttached: true,
      timelineAttached: true,
      message: 'timeline-attached',
      epoch: 0,
    });

    expect(controller.info).toEqual({
      sessionId: 'session-1',
      windowLabel: 'main',
      state: 'playing',
      nativeSurfaceSupported: true,
      nativeSurfaceImplemented: true,
      nativeSurfacePlatformStatus: 'supported',
      nativeSurfacePlatformReason: null,
      nativeSurfaceAttached: true,
      timelineAttached: true,
    });
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toMatchObject({
      type: 'state',
      payload: {
        sessionId: 'session-1',
        state: 'playing',
        timelineAttached: true,
      },
    });
  });

  it('forwards surface viewport and revision parameters to preview API calls', async () => {
    const controller = new PreviewSessionController();

    await controller.create('main');

    await controller.attachSurface('surface-host', {
      viewport: {
        x: 12,
        y: 24,
        width: 640,
        height: 360,
        scaleFactor: 2,
        visible: true,
      },
      surfaceSyncRevision: 7,
    });
    await controller.setViewport(
      {
        x: 20,
        y: 30,
        width: 800,
        height: 450,
        scaleFactor: 1,
        visible: true,
      },
      8,
    );
    await controller.setSurfacePresenting(false, 9);

    expect(attachSurfaceMock).toHaveBeenCalledWith('session-1', 'surface-host', {
      x: 12,
      y: 24,
      width: 640,
      height: 360,
      scaleFactor: 2,
      visible: true,
    }, 7);
    expect(setViewportMock).toHaveBeenCalledWith('session-1', {
      x: 20,
      y: 30,
      width: 800,
      height: 450,
      scaleFactor: 1,
      visible: true,
    }, 8);
    expect(setSurfacePresentingMock).toHaveBeenCalledWith('session-1', false, 9);
  });

  it('ignores state events for other sessions', async () => {
    const controller = new PreviewSessionController();

    await controller.create('main');

    listenerRegistry.get('media-preview://state')?.({
      sessionId: 'session-2',
      state: 'error',
      positionMs: 0,
      rate: 1,
      nativeSurfaceAttached: true,
      timelineAttached: true,
      epoch: 0,
    });

    expect(controller.info?.state).toBe('idle');
    expect(controller.info?.nativeSurfaceAttached).toBe(false);
    expect(controller.info?.timelineAttached).toBe(false);
  });

  it('allocates a monotonic transport epoch per outgoing transport command', async () => {
    const controller = new PreviewSessionController();
    await controller.create('main');

    await controller.play();
    await controller.playFrom(1_000);
    await controller.pause();
    await controller.seek(2_000);
    await controller.stepFrame(1);
    await controller.setRate(2);

    expect(playMock).toHaveBeenCalledWith('session-1', 1);
    expect(playFromMock).toHaveBeenCalledWith('session-1', 1_000, 2);
    expect(pauseMock).toHaveBeenCalledWith('session-1', 3);
    expect(seekMock).toHaveBeenCalledWith('session-1', 2_000, 4);
    expect(stepFrameMock).toHaveBeenCalledWith('session-1', 1, 5);
    expect(setRateMock).toHaveBeenCalledWith('session-1', 2, 6);
  });

  it('drops position/state/frameTimestamp events whose epoch is not the latest sent epoch', async () => {
    const controller = new PreviewSessionController();
    const received: Array<{ type: string }> = [];
    controller.subscribe((event) => {
      received.push(event);
    });

    await controller.create('main');

    const emitPosition = listenerRegistry.get('media-preview://position');
    const emitState = listenerRegistry.get('media-preview://state');
    const emitFrame = listenerRegistry.get('media-preview://frame-timestamp');

    // Epoch 0 events are fresh before any transport command has been sent.
    emitPosition?.({
      sessionId: 'session-1',
      positionMs: 0,
      isPlaying: false,
      isBuffering: false,
      driftMs: 0,
      rate: 1,
      epoch: 0,
    });
    expect(received).toHaveLength(1);

    await controller.seek(5_000); // transportEpoch -> 1

    // Stale (pre-seek) events must be dropped.
    emitPosition?.({
      sessionId: 'session-1',
      positionMs: 0,
      isPlaying: false,
      isBuffering: false,
      driftMs: 0,
      rate: 1,
      epoch: 0,
    });
    emitFrame?.({ sessionId: 'session-1', positionMs: 0, epoch: 0 });
    emitState?.({
      sessionId: 'session-1',
      state: 'paused',
      positionMs: 0,
      rate: 1,
      nativeSurfaceAttached: true,
      timelineAttached: true,
      epoch: 0,
    });
    expect(received).toHaveLength(1);

    // Fresh (matching-epoch) events pass through.
    emitPosition?.({
      sessionId: 'session-1',
      positionMs: 5_000,
      isPlaying: false,
      isBuffering: false,
      driftMs: 0,
      rate: 1,
      epoch: 1,
    });
    emitFrame?.({ sessionId: 'session-1', positionMs: 5_000, epoch: 1 });
    emitState?.({
      sessionId: 'session-1',
      state: 'paused',
      positionMs: 5_000,
      rate: 1,
      nativeSurfaceAttached: true,
      timelineAttached: true,
      epoch: 1,
    });
    expect(received).toHaveLength(4);
    expect(received.map((event) => event.type)).toEqual([
      'position',
      'position',
      'frameTimestamp',
      'state',
    ]);
  });

  it('passes error and metrics events through regardless of transport epoch', async () => {
    const controller = new PreviewSessionController();
    const received: Array<{ type: string }> = [];
    controller.subscribe((event) => {
      received.push(event);
    });

    await controller.create('main');
    await controller.seek(1_000); // transportEpoch -> 1

    listenerRegistry.get('media-preview://error')?.({
      sessionId: 'session-1',
      message: 'boom',
    });
    listenerRegistry.get('media-preview://metrics')?.({
      sessionId: 'session-1',
      state: 'error',
      metrics: {},
    });

    expect(received.map((event) => event.type)).toEqual(['error', 'metrics']);
  });

  it('presents the native preview surface by default unless explicitly disabled', () => {
    expect(isNativeTimelinePreviewDebugPresentSurfaceEnabled()).toBe(true);

    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn((key: string) =>
          key === 'opendirector.nativeTimelinePreview.debugPresentSurface' ? 'false' : 'true',
        ),
      },
    });

    expect(isNativeTimelinePreviewDebugPresentSurfaceEnabled()).toBe(false);
  });

  it('routes step-frame requests to the current native preview handler', () => {
    const firstHandler = vi.fn(() => false);
    const secondHandler = vi.fn(() => true);

    const unregisterFirst = registerNativePreviewStepFrameHandler(firstHandler);
    const unregisterSecond = registerNativePreviewStepFrameHandler(secondHandler);

    expect(requestNativePreviewStepFrame(1)).toBe(true);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith(1);

    unregisterFirst();
    unregisterSecond();
    expect(requestNativePreviewStepFrame(-1)).toBe(false);
  });

  it('includes linked audio clips for video fragments with embedded audio', () => {
    const now = new Date('2026-04-29T00:00:00.000Z');
    const snapshot = buildTimelinePreviewSnapshot({
      project: {
        id: 'project-1',
        name: 'Preview Audio',
        folderPath: 'C:/Projects/PreviewAudio',
        tracks: [
          { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
        ],
        fragments: [
          {
            id: 'fragment-1',
            trackId: 'video-main',
            start: 500,
            duration: 2500,
            prompt: 'Hero',
            references: [],
            status: 'completed',
            sourceAssetId: 'asset-video',
            trimStart: 125,
            createdAt: now,
            updatedAt: now,
          },
        ],
        scenes: [],
        assets: [
          {
            id: 'asset-video',
            name: 'hero.mp4',
            type: 'video',
            source: 'original',
            url: 'asset://hero',
            relativePath: 'Assets/Video/hero.mp4',
            fileSize: 100,
            mimeType: 'video/mp4',
            duration: 4000,
            width: 1920,
            height: 1080,
            audioChannels: 2,
            tags: [],
            favorite: false,
            usageCount: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
        settings: {
          fps: 25,
          resolution: { width: 1280, height: 720 },
          defaultProvider: 'test',
          defaultAspectRatio: '16:9',
          providerConfig: {},
        },
        createdAt: now,
        updatedAt: now,
      },
    });

    expect(snapshot.tracks).toEqual([
      { id: 'video-main', type: 'video', muted: false, order: 0 },
      { id: '__linked_audio_track__video-main', type: 'audio', muted: false, order: 0 },
    ]);
    expect(snapshot.fragments).toEqual([
      expect.objectContaining({
        id: 'fragment-1',
        trackId: 'video-main',
        absolutePath: 'C:/Projects/PreviewAudio/Assets/Video/hero.mp4',
        startMs: 500,
        durationMs: 2500,
        trimStartMs: 125,
      }),
      expect.objectContaining({
        id: '__linked_audio_clip__fragment-1',
        trackId: '__linked_audio_track__video-main',
        absolutePath: 'C:/Projects/PreviewAudio/Assets/Video/hero.mp4',
        startMs: 500,
        durationMs: 2500,
        trimStartMs: 125,
      }),
    ]);
  });

  it('skips fragments without a playable source when building the preview snapshot', () => {
    const now = new Date('2026-04-29T00:00:00.000Z');
    const snapshot = buildTimelinePreviewSnapshot({
      project: {
        id: 'project-1',
        name: 'Preview Missing Sources',
        folderPath: 'C:/Projects/PreviewMissingSources',
        tracks: [
          { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
        ],
        fragments: [
          {
            id: 'fragment-valid',
            trackId: 'video-main',
            start: 0,
            duration: 1200,
            prompt: 'Valid',
            references: [],
            status: 'completed',
            sourceAssetId: 'asset-video',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'fragment-empty-source',
            trackId: 'video-main',
            start: 1800,
            duration: 1200,
            prompt: 'Empty Source',
            references: [],
            status: 'draft',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'fragment-unresolvable-path',
            trackId: 'video-main',
            start: 3200,
            duration: 800,
            prompt: 'Broken Path',
            references: [],
            status: 'completed',
            sourceAssetId: 'asset-missing-path',
            createdAt: now,
            updatedAt: now,
          },
        ],
        scenes: [],
        assets: [
          {
            id: 'asset-video',
            name: 'hero.mp4',
            type: 'video',
            source: 'original',
            url: 'asset://hero',
            relativePath: 'Assets/Video/hero.mp4',
            fileSize: 100,
            mimeType: 'video/mp4',
            duration: 4000,
            width: 1920,
            height: 1080,
            tags: [],
            favorite: false,
            usageCount: 0,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'asset-missing-path',
            name: 'missing.mp4',
            type: 'video',
            source: 'generated',
            url: 'asset://missing',
            fileSize: 100,
            mimeType: 'video/mp4',
            duration: 800,
            width: 1920,
            height: 1080,
            tags: [],
            favorite: false,
            usageCount: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
        settings: {
          fps: 25,
          resolution: { width: 1280, height: 720 },
          defaultProvider: 'test',
          defaultAspectRatio: '16:9',
          providerConfig: {},
        },
        createdAt: now,
        updatedAt: now,
      },
    });

    expect(snapshot.durationMs).toBe(4000);
    expect(snapshot.tracks).toEqual([
      { id: 'video-main', type: 'video', muted: false, order: 0 },
    ]);
    expect(snapshot.fragments).toEqual([
      expect.objectContaining({
        id: 'fragment-valid',
        trackId: 'video-main',
        absolutePath: 'C:/Projects/PreviewMissingSources/Assets/Video/hero.mp4',
        startMs: 0,
        durationMs: 1200,
      }),
    ]);
  });

  it('allows an empty preview timeline when every fragment lacks a playable source', () => {
    const now = new Date('2026-04-29T00:00:00.000Z');

    const snapshot = buildTimelinePreviewSnapshot({
      project: {
        id: 'project-1',
        name: 'Preview Missing Sources',
        folderPath: 'C:/Projects/PreviewMissingSources',
        tracks: [
          { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
        ],
        fragments: [
          {
            id: 'fragment-empty-source',
            trackId: 'video-main',
            start: 1800,
            duration: 1200,
            prompt: 'Empty Source',
            references: [],
            status: 'draft',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'fragment-unresolvable-path',
            trackId: 'video-main',
            start: 3200,
            duration: 800,
            prompt: 'Broken Path',
            references: [],
            status: 'completed',
            sourceAssetId: 'asset-missing-path',
            createdAt: now,
            updatedAt: now,
          },
        ],
        scenes: [],
        assets: [
          {
            id: 'asset-missing-path',
            name: 'missing.mp4',
            type: 'video',
            source: 'generated',
            url: 'asset://missing',
            fileSize: 100,
            mimeType: 'video/mp4',
            duration: 800,
            width: 1920,
            height: 1080,
            tags: [],
            favorite: false,
            usageCount: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
        settings: {
          fps: 25,
          resolution: { width: 1280, height: 720 },
          defaultProvider: 'test',
          defaultAspectRatio: '16:9',
          providerConfig: {},
        },
        createdAt: now,
        updatedAt: now,
      },
    });

    expect(snapshot.durationMs).toBe(4000);
    expect(snapshot.tracks).toEqual([
      { id: 'video-main', type: 'video', muted: false, order: 0 },
    ]);
    expect(snapshot.fragments).toEqual([]);
  });

  it('uses scene duration for a fully empty preview timeline', () => {
    const now = new Date('2026-04-29T00:00:00.000Z');

    const snapshot = buildTimelinePreviewSnapshot({
      project: {
        id: 'project-1',
        name: 'Empty Preview Timeline',
        folderPath: 'C:/Projects/EmptyPreviewTimeline',
        tracks: [
          { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
        ],
        fragments: [],
        scenes: [
          {
            id: 'scene-1',
            name: 'Scene 1',
            start: 0,
            duration: DEFAULT_SCENE_DURATION_MS,
            referenceIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        assets: [],
        settings: {
          fps: 25,
          resolution: { width: 1280, height: 720 },
          defaultProvider: 'test',
          defaultAspectRatio: '16:9',
          providerConfig: {},
        },
        createdAt: now,
        updatedAt: now,
      },
    });

    expect(snapshot.durationMs).toBe(DEFAULT_SCENE_DURATION_MS);
    expect(snapshot.fragments).toEqual([]);
  });
});
