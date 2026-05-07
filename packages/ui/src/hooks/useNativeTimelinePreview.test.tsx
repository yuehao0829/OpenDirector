import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { acquireNativePreviewOcclusion } from '@opendirector/core/utils/native-preview-occlusion';
import { isNativeTimelinePreviewDebugPresentSurfaceEnabled } from '@opendirector/core/services/preview-session';
import { useNativeTimelinePreview } from './useNativeTimelinePreview';

type PreviewEvent =
  | {
      type: 'state';
      payload: {
        sessionId: string;
        state: 'idle' | 'ready' | 'playing' | 'paused' | 'seeking' | 'ended' | 'error' | 'destroyed';
        positionMs: number;
        rate: number;
        nativeSurfaceAttached: boolean;
        timelineAttached: boolean;
        message?: string;
      };
    }
  | {
      type: 'position';
      payload: {
        sessionId: string;
        positionMs: number;
        isPlaying: boolean;
        isBuffering: boolean;
        driftMs: number;
        rate: number;
      };
    };

const previewControllerState = vi.hoisted(() => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }

  function createDeferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve'];
    let reject!: Deferred<T>['reject'];
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  class MockPreviewSessionController {
    readonly id: string;
    private listeners = new Set<(event: PreviewEvent) => void>();
    private desiredSurfacePresenting = false;
    private sessionInfo: {
      sessionId: string;
      windowLabel: string;
      state: 'idle' | 'paused';
      nativeSurfaceSupported: boolean;
      nativeSurfaceImplemented: boolean;
      nativeSurfacePlatformStatus: string;
      nativeSurfacePlatformReason: null;
      nativeSurfaceAttached: boolean;
      timelineAttached: boolean;
    } | null = null;

    constructor() {
      this.id = `session-${previewControllerState.instances.length + 1}`;
      previewControllerState.instances.push(this);
    }

    get sessionId(): string | null {
      return this.sessionInfo?.sessionId ?? null;
    }

    get info() {
      return this.sessionInfo;
    }

    subscribe(listener: (event: PreviewEvent) => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    emit(event: PreviewEvent) {
      if (event.type === 'state' && this.sessionInfo) {
        this.sessionInfo = {
          ...this.sessionInfo,
          state: event.payload.state === 'paused' ? 'paused' : 'idle',
          nativeSurfaceAttached: event.payload.nativeSurfaceAttached,
          timelineAttached: event.payload.timelineAttached,
        };
      }

      this.listeners.forEach((listener) => listener(event));
    }

    async create(windowLabel = 'main') {
      this.desiredSurfacePresenting = false;
      this.sessionInfo = {
        sessionId: this.id,
        windowLabel,
        state: 'idle',
        nativeSurfaceSupported: true,
        nativeSurfaceImplemented: true,
        nativeSurfacePlatformStatus: 'supported',
        nativeSurfacePlatformReason: null,
        nativeSurfaceAttached: false,
        timelineAttached: false,
      };
      return this.sessionInfo;
    }

    async destroy(): Promise<void> {}

    async attachSurface(
      _surfaceId?: string | null,
      options?: {
        viewport?: {
          x: number;
          y: number;
          width: number;
          height: number;
          scaleFactor: number;
          visible: boolean;
        } | null;
        surfaceSyncRevision?: number | null;
      },
    ) {
      if (!this.sessionInfo) {
        throw new Error('session not created');
      }

      previewControllerState.surfaceSetupCalls.push({
        controller: this,
        kind: 'attach',
        desiredPresentingAtCall: false,
        surfaceAttachedAtCall: this.sessionInfo.nativeSurfaceAttached,
        surfaceSyncRevision: options?.surfaceSyncRevision ?? null,
        viewport: options?.viewport ?? null,
      });

      if (!previewControllerState.deferAttach) {
        this.desiredSurfacePresenting = false;
        this.sessionInfo = {
          ...this.sessionInfo,
          nativeSurfaceAttached: true,
        };
        previewControllerState.attachCalls.push({
          controller: this,
          surfaceSyncRevision: options?.surfaceSyncRevision ?? null,
          viewport: options?.viewport ?? null,
          deferred: null,
        });
        return this.sessionInfo;
      }

      const deferred = createDeferred<void>();
      previewControllerState.attachCalls.push({
        controller: this,
        surfaceSyncRevision: options?.surfaceSyncRevision ?? null,
        viewport: options?.viewport ?? null,
        deferred,
      });
      return deferred.promise.then(() => {
        if (!this.sessionInfo) {
          throw new Error('session not created');
        }

        this.desiredSurfacePresenting = false;
        this.sessionInfo = {
          ...this.sessionInfo,
          nativeSurfaceAttached: true,
        };
        return this.sessionInfo;
      });
    }

    async setViewport(viewport: {
      x: number;
      y: number;
      width: number;
      height: number;
      scaleFactor: number;
      visible: boolean;
    }, surfaceSyncRevision?: number | null): Promise<void> {
      previewControllerState.surfaceSetupCalls.push({
        controller: this,
        kind: 'viewport',
        surfaceAttachedAtCall: this.sessionInfo?.nativeSurfaceAttached ?? false,
        surfaceSyncRevision: surfaceSyncRevision ?? null,
        viewport,
      });

      if (!previewControllerState.deferViewport) {
      previewControllerState.viewportCalls.push({
        controller: this,
        viewport,
        surfaceSyncRevision: surfaceSyncRevision ?? null,
        deferred: null,
      });
      return;
      }

      const deferred = createDeferred<void>();
      previewControllerState.viewportCalls.push({
        controller: this,
        viewport,
        surfaceSyncRevision: surfaceSyncRevision ?? null,
        deferred,
      });
      return deferred.promise;
    }

    async setSurfacePresenting(
      presenting: boolean,
      surfaceSyncRevision?: number | null,
    ): Promise<void> {
      this.desiredSurfacePresenting = presenting;
      previewControllerState.surfaceSetupCalls.push({
        controller: this,
        kind: 'present',
        presenting,
        surfaceAttachedAtCall: this.sessionInfo?.nativeSurfaceAttached ?? false,
        surfaceSyncRevision: surfaceSyncRevision ?? null,
      });
      previewControllerState.setSurfacePresentingCalls.push({
        controller: this,
        presenting,
      });

      if (!previewControllerState.deferPresenting) {
        previewControllerState.presentingCalls.push({
          controller: this,
          presenting,
          surfaceSyncRevision: surfaceSyncRevision ?? null,
          deferred: null,
        });
        return;
      }

      const deferred = createDeferred<void>();
      previewControllerState.presentingCalls.push({
        controller: this,
        presenting,
        surfaceSyncRevision: surfaceSyncRevision ?? null,
        deferred,
      });
      return deferred.promise;
    }

    async setTimeline(snapshot: unknown): Promise<void> {
      if (!previewControllerState.deferSetTimeline) {
        previewControllerState.setTimelineCalls.push({
          controller: this,
          snapshot,
          deferred: null,
        });
        return;
      }

      const deferred = createDeferred<void>();
      previewControllerState.setTimelineCalls.push({
        controller: this,
        snapshot,
        deferred,
      });
      return deferred.promise;
    }

    async play(): Promise<void> {
      previewControllerState.commandLog.push(`play:${this.id}`);
      if (!previewControllerState.deferPlay) {
        previewControllerState.playCalls.push({
          controller: this,
          deferred: null,
        });
        return;
      }

      const deferred = createDeferred<void>();
      previewControllerState.playCalls.push({
        controller: this,
        deferred,
      });
      return deferred.promise;
    }

    async playFrom(timeMs: number): Promise<void> {
      previewControllerState.commandLog.push(`playFrom:${this.id}:${timeMs}`);
      if (previewControllerState.deferPlayFrom) {
        const deferred = createDeferred<void>();
        previewControllerState.playFromCalls.push({
          controller: this,
          timeMs,
          deferred,
        });
        return deferred.promise;
      }
      previewControllerState.playFromCalls.push({
        controller: this,
        timeMs,
        deferred: null,
      });
    }

    async pause(): Promise<void> {
      previewControllerState.commandLog.push(`pause:${this.id}`);
      if (!previewControllerState.deferPause) {
        previewControllerState.pauseCalls.push({
          controller: this,
          deferred: null,
        });
        return;
      }

      const deferred = createDeferred<void>();
      previewControllerState.pauseCalls.push({
        controller: this,
        deferred,
      });
      return deferred.promise;
    }

    async seek(timeMs: number): Promise<void> {
      previewControllerState.commandLog.push(`seek:${this.id}:${timeMs}`);
      const deferred = createDeferred<void>();
      previewControllerState.seekCalls.push({
        controller: this,
        timeMs,
        deferred,
      });
      return deferred.promise;
    }

    async stepFrame(): Promise<void> {}

    async setRate(): Promise<void> {}

    async getDiagnostics() {
      return null;
    }
  }

  return {
    instances: [] as MockPreviewSessionController[],
    commandLog: [] as string[],
    deferAttach: false,
    deferPause: false,
    deferPlay: false,
    deferPlayFrom: false,
    deferPresenting: false,
    attachCalls: [] as Array<{
      controller: MockPreviewSessionController;
      surfaceSyncRevision: number | null;
      viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
        scaleFactor: number;
        visible: boolean;
      } | null;
      deferred: Deferred<void> | null;
    }>,
    playCalls: [] as Array<{
      controller: MockPreviewSessionController;
      deferred: Deferred<void> | null;
    }>,
    playFromCalls: [] as Array<{
      controller: MockPreviewSessionController;
      timeMs: number;
      deferred: Deferred<void> | null;
    }>,
    pauseCalls: [] as Array<{
      controller: MockPreviewSessionController;
      deferred: Deferred<void> | null;
    }>,
    seekCalls: [] as Array<{
      controller: MockPreviewSessionController;
      timeMs: number;
      deferred: Deferred<void>;
    }>,
    setTimelineCalls: [] as Array<{
      controller: MockPreviewSessionController;
      snapshot: unknown;
      deferred: Deferred<void> | null;
    }>,
    viewportCalls: [] as Array<{
      controller: MockPreviewSessionController;
      viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
        scaleFactor: number;
        visible: boolean;
      };
      surfaceSyncRevision: number | null;
      deferred: Deferred<void> | null;
    }>,
    presentingCalls: [] as Array<{
      controller: MockPreviewSessionController;
      presenting: boolean;
      surfaceSyncRevision: number | null;
      deferred: Deferred<void> | null;
    }>,
    setSurfacePresentingCalls: [] as Array<{
      controller: MockPreviewSessionController;
      presenting: boolean;
    }>,
    surfaceSetupCalls: [] as Array<
      | {
          controller: MockPreviewSessionController;
          kind: 'viewport';
          surfaceAttachedAtCall: boolean;
          surfaceSyncRevision: number | null;
          viewport: {
            x: number;
            y: number;
            width: number;
            height: number;
            scaleFactor: number;
            visible: boolean;
          };
        }
      | {
          controller: MockPreviewSessionController;
          kind: 'present';
          presenting: boolean;
          surfaceAttachedAtCall: boolean;
          surfaceSyncRevision: number | null;
        }
      | {
          controller: MockPreviewSessionController;
          kind: 'attach';
          desiredPresentingAtCall: boolean;
          surfaceAttachedAtCall: boolean;
          surfaceSyncRevision: number | null;
          viewport: {
            x: number;
            y: number;
            width: number;
            height: number;
            scaleFactor: number;
            visible: boolean;
          } | null;
        }
    >,
    deferViewport: false,
    deferSetTimeline: false,
    MockPreviewSessionController,
  };
});

const timelineStoreState = vi.hoisted(() => ({
  current: {
    tracks: [{ id: 'track-1', type: 'video', order: 0, muted: false }],
    fragments: [{ id: 'fragment-1', trackId: 'track-1', start: 0, duration: 1_000 }],
    duration: 1_000,
    playhead: 5_000,
    displayPlayhead: 5_000,
    playheadRef: 5_000,
    displayPlayheadRef: 5_000,
    isPlaying: false,
    setNativePreviewTransportControlled: vi.fn(),
    setPlayhead: vi.fn(),
    setDisplayPlayhead: vi.fn(),
    setPlayheadRefOnly: vi.fn(),
    setDisplayPlayheadRefOnly: vi.fn(),
    getPlayheadRef: vi.fn(() => 5_000),
    getDisplayPlayheadRef: vi.fn(() => 5_000),
    pause: vi.fn(),
  },
}));

const projectStoreState = vi.hoisted(() => ({
  current: {
    currentProject: {
      id: 'project-1',
      folderPath: '/tmp/project-1',
    },
  },
}));

const assetStoreState = vi.hoisted(() => ({
  current: {
    assets: [],
  },
}));

const mockHelpers = vi.hoisted(() => {
  const createMockStoreHook = <T extends object>(stateRef: { current: T }) =>
    Object.assign((selector: (state: T) => unknown) => selector(stateRef.current), {
      getState: () => stateRef.current,
      setState: (updates: Partial<T>) => {
        Object.assign(stateRef.current, updates);
      },
      subscribe: vi.fn(() => () => {}),
    });

  return { createMockStoreHook };
});

vi.mock('@opendirector/core/services/preview-session', () => ({
  buildTimelinePreviewSnapshot: vi.fn((options: { project: { fragments?: Array<{ duration: number }> } }) => ({
    projectPath: '/tmp/project',
    durationMs: options.project.fragments?.[0]?.duration ?? 10_000,
    fps: 30,
    canvasWidth: 1920,
    canvasHeight: 1080,
    tracks: [],
    fragments: [],
  })),
  isNativeTimelinePreviewEnabled: vi.fn(() => true),
  isNativeTimelinePreviewDebugPresentSurfaceEnabled: vi.fn(() => false),
  PreviewSessionController: previewControllerState.MockPreviewSessionController,
}));

vi.mock('@opendirector/core/services/project-service', () => ({
  ensureProjectVideoSourceAudioMetadata: vi.fn(async (project) => project),
}));

vi.mock('@opendirector/core/stores/timelineStore', () => ({
  useTimelineStore: mockHelpers.createMockStoreHook(timelineStoreState),
  registerNativePreviewStepFrameHandler: vi.fn(() => () => {}),
}));

vi.mock('@opendirector/core/stores/projectStore', () => ({
  useProjectStore: mockHelpers.createMockStoreHook(projectStoreState),
}));

vi.mock('@opendirector/core/stores/assetStore', () => ({
  useAssetStore: mockHelpers.createMockStoreHook(assetStoreState),
}));

function HookHost() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const preview = useNativeTimelinePreview({
    enabled: true,
    containerRef,
  });

  return (
    <div
      ref={containerRef}
      data-testid="native-preview-host"
      data-session-id={preview.sessionId ?? ''}
      data-position={String(preview.positionMs)}
      data-state={preview.state}
      data-timeline-attached={preview.timelineAttached ? 'true' : 'false'}
    />
  );
}

function setMockPlayhead(targetMs: number, displayMs = targetMs) {
  timelineStoreState.current.playhead = targetMs;
  timelineStoreState.current.displayPlayhead = displayMs;
  timelineStoreState.current.playheadRef = targetMs;
  timelineStoreState.current.displayPlayheadRef = displayMs;
}

function installTimelineStoreMocks() {
  timelineStoreState.current.setNativePreviewTransportControlled = vi.fn();
  timelineStoreState.current.setPlayhead = vi.fn((time: number) => {
    const clamped = Math.max(0, time);
    timelineStoreState.current.playhead = clamped;
    timelineStoreState.current.displayPlayhead = clamped;
    timelineStoreState.current.playheadRef = clamped;
    timelineStoreState.current.displayPlayheadRef = clamped;
  });
  timelineStoreState.current.setDisplayPlayhead = vi.fn((time: number) => {
    const clamped = Math.max(0, time);
    timelineStoreState.current.displayPlayhead = clamped;
    timelineStoreState.current.displayPlayheadRef = clamped;
  });
  timelineStoreState.current.setPlayheadRefOnly = vi.fn((time: number) => {
    timelineStoreState.current.playheadRef = Math.max(0, time);
  });
  timelineStoreState.current.setDisplayPlayheadRefOnly = vi.fn((time: number) => {
    timelineStoreState.current.displayPlayheadRef = Math.max(0, time);
  });
  timelineStoreState.current.getPlayheadRef = vi.fn(() => timelineStoreState.current.playheadRef);
  timelineStoreState.current.getDisplayPlayheadRef = vi.fn(
    () => timelineStoreState.current.displayPlayheadRef,
  );
  timelineStoreState.current.pause = vi.fn(() => {
    timelineStoreState.current.isPlaying = false;
  });
}

function resetNativePreviewOcclusionState() {
  delete (
    window as Window & {
      __OPENDIRECTOR_NATIVE_PREVIEW_OCCLUSION_STATE__?: unknown;
    }
  ).__OPENDIRECTOR_NATIVE_PREVIEW_OCCLUSION_STATE__;
}

describe('useNativeTimelinePreview', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  let mockHostRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  beforeEach(() => {
    resetNativePreviewOcclusionState();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    previewControllerState.instances.length = 0;
    previewControllerState.commandLog.length = 0;
    previewControllerState.deferAttach = false;
    previewControllerState.deferPause = false;
    previewControllerState.deferPlay = false;
    previewControllerState.deferPlayFrom = false;
    previewControllerState.deferPresenting = false;
    previewControllerState.attachCalls.length = 0;
    previewControllerState.playCalls.length = 0;
    previewControllerState.playFromCalls.length = 0;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;
    previewControllerState.setTimelineCalls.length = 0;
    previewControllerState.viewportCalls.length = 0;
    previewControllerState.presentingCalls.length = 0;
    previewControllerState.setSurfacePresentingCalls.length = 0;
    previewControllerState.surfaceSetupCalls.length = 0;
    previewControllerState.deferViewport = false;
    previewControllerState.deferSetTimeline = false;
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(false);

    timelineStoreState.current.duration = 1_000;
    setMockPlayhead(5_000);
    timelineStoreState.current.fragments = [
      { id: 'fragment-1', trackId: 'track-1', start: 0, duration: 1_000 },
    ];
    timelineStoreState.current.isPlaying = false;
    installTimelineStoreMocks();

    projectStoreState.current.currentProject = {
      id: 'project-1',
      folderPath: '/tmp/project-1',
    };

    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    mockHostRect = {
      x: 0,
      y: 0,
      width: 800,
      height: 400,
    };
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: mockHostRect.x,
        y: mockHostRect.y,
        top: mockHostRect.y,
        left: mockHostRect.x,
        bottom: mockHostRect.y + mockHostRect.height,
        right: mockHostRect.x + mockHostRect.width,
        width: mockHostRect.width,
        height: mockHostRect.height,
        toJSON() {
          return this;
        },
      } as DOMRect;
    };

    originalResizeObserver = globalThis.ResizeObserver;
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetNativePreviewOcclusionState();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    if (originalResizeObserver) {
      vi.stubGlobal('ResizeObserver', originalResizeObserver);
    } else {
      vi.unstubAllGlobals();
    }
  });

  it('ignores paused origin events from a new session even after a stale seek resolves', async () => {
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstController = previewControllerState.instances[0];
    expect(firstController).toBeDefined();

    await act(async () => {
      firstController.emit({
        type: 'state',
        payload: {
          sessionId: firstController.id,
          state: 'paused',
          positionMs: 0,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(1);
    expect(previewControllerState.seekCalls[0].timeMs).toBe(5_000);
    timelineStoreState.current.setPlayhead.mockClear();

    projectStoreState.current.currentProject = {
      id: 'project-2',
      folderPath: '/tmp/project-2',
    };

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const secondController = previewControllerState.instances[1];
    expect(secondController).toBeDefined();

    await act(async () => {
      previewControllerState.seekCalls[0].deferred.resolve();
      await Promise.resolve();
    });

    expect(
      container
        .querySelector('[data-testid="native-preview-host"]')
        ?.getAttribute('data-position'),
    ).not.toBe('5000');

    await act(async () => {
      secondController.emit({
        type: 'state',
        payload: {
          sessionId: secondController.id,
          state: 'paused',
          positionMs: 0,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.setPlayhead).not.toHaveBeenCalled();
  });

  it('accepts paused position events before the matching state event updates controller info', async () => {
    setMockPlayhead(4_800);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    timelineStoreState.current.setPlayhead.mockClear();

    await act(async () => {
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 5_000,
          isPlaying: false,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.setPlayhead).toHaveBeenCalledWith(5_000);
  });

  it('accepts paused boundary corrections after the timeline has been shortened', async () => {
    setMockPlayhead(5_000);
    timelineStoreState.current.duration = 3_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    timelineStoreState.current.setPlayhead.mockClear();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 3_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.setPlayhead).toHaveBeenCalledWith(3_000);
  });

  it('coalesces timeline updates while a previous native submission is still in flight', async () => {
    previewControllerState.deferSetTimeline = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.setTimelineCalls).toHaveLength(1);
    expect(previewControllerState.setTimelineCalls[0]?.snapshot).toEqual({
      projectPath: '/tmp/project',
      durationMs: 1_000,
      fps: 30,
      canvasWidth: 1920,
      canvasHeight: 1080,
      tracks: [],
      fragments: [],
    });

    timelineStoreState.current.fragments = [
      { id: 'fragment-1', trackId: 'track-1', start: 0, duration: 2_000 },
    ];

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    timelineStoreState.current.fragments = [
      { id: 'fragment-1', trackId: 'track-1', start: 0, duration: 3_000 },
    ];

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.setTimelineCalls).toHaveLength(1);

    await act(async () => {
      previewControllerState.setTimelineCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.setTimelineCalls).toHaveLength(2);
    expect(previewControllerState.setTimelineCalls[1]?.snapshot).toEqual({
      projectPath: '/tmp/project',
      durationMs: 3_000,
      fps: 30,
      canvasWidth: 1920,
      canvasHeight: 1080,
      tracks: [],
      fragments: [],
    });
  });

  it('drops a queued stale snapshot when the timeline returns to the in-flight version', async () => {
    previewControllerState.deferSetTimeline = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.setTimelineCalls).toHaveLength(1);
    expect(previewControllerState.setTimelineCalls[0]?.snapshot).toEqual({
      projectPath: '/tmp/project',
      durationMs: 1_000,
      fps: 30,
      canvasWidth: 1920,
      canvasHeight: 1080,
      tracks: [],
      fragments: [],
    });

    timelineStoreState.current.fragments = [
      { id: 'fragment-1', trackId: 'track-1', start: 0, duration: 2_000 },
    ];

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    timelineStoreState.current.fragments = [
      { id: 'fragment-1', trackId: 'track-1', start: 0, duration: 1_000 },
    ];

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      previewControllerState.setTimelineCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.setTimelineCalls).toHaveLength(1);
  });

  it('does not enqueue native seeks for playhead changes while playback is running', async () => {
    timelineStoreState.current.isPlaying = true;
    setMockPlayhead(5_000);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 5_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.fragments = [
      { id: 'fragment-1', trackId: 'track-1', start: 0, duration: 1_200 },
    ];
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    setMockPlayhead(5_400);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(0);
  });

  it('does not accept paused boundary events from a new session before that session reports timelineAttached', async () => {
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstController = previewControllerState.instances[0];
    expect(firstController).toBeDefined();

    await act(async () => {
      firstController.emit({
        type: 'state',
        payload: {
          sessionId: firstController.id,
          state: 'paused',
          positionMs: 5_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.setPlayhead.mockClear();
    timelineStoreState.current.duration = 0;

    projectStoreState.current.currentProject = {
      id: 'project-2',
      folderPath: '/tmp/project-2',
    };

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const secondController = previewControllerState.instances[1];
    expect(secondController).toBeDefined();

    await act(async () => {
      secondController.emit({
        type: 'state',
        payload: {
          sessionId: secondController.id,
          state: 'paused',
          positionMs: 0,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: false,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.setPlayhead).not.toHaveBeenCalled();
  });

  it('seeks to the latest playhead before issuing play when playback starts immediately after a jump', async () => {
    setMockPlayhead(0);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 0,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.seekCalls.length = 0;
    previewControllerState.playCalls.length = 0;
    setMockPlayhead(5_000);
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.playFromCalls).toHaveLength(1);
    expect(previewControllerState.playFromCalls[0]?.timeMs).toBe(5_000);
    expect(previewControllerState.playCalls).toHaveLength(0);
  });

  it('ignores stale paused state positions while a newer local seek target is pending', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.setPlayhead.mockClear();
    timelineStoreState.current.setPlayheadRefOnly.mockClear();
    timelineStoreState.current.isPlaying = false;
    setMockPlayhead(5_000);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.setPlayhead).not.toHaveBeenCalled();
    expect(timelineStoreState.current.setPlayheadRefOnly).not.toHaveBeenCalledWith(1_000);
  });

  it('ignores stale paused state positions while a newer rewind target is pending', async () => {
    setMockPlayhead(18_960);
    timelineStoreState.current.duration = 30_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 18_960,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.setPlayhead.mockClear();
    timelineStoreState.current.setPlayheadRefOnly.mockClear();
    timelineStoreState.current.isPlaying = false;
    setMockPlayhead(8_340);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 18_960,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.playhead).toBe(8_340);
    expect(timelineStoreState.current.playheadRef).toBe(8_340);
    expect(timelineStoreState.current.setPlayhead).not.toHaveBeenCalledWith(18_960);
    expect(timelineStoreState.current.setPlayheadRefOnly).not.toHaveBeenCalledWith(18_960);
  });

  it('drops stale paused seeks when immediate replay starts before the queued seek is sent', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.commandLog.length = 0;
    previewControllerState.playCalls.length = 0;
    previewControllerState.playFromCalls.length = 0;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;
    previewControllerState.deferPause = true;

    timelineStoreState.current.isPlaying = false;
    setMockPlayhead(5_000);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([`pause:${controller.id}`]);
    expect(previewControllerState.seekCalls).toHaveLength(0);
    expect(previewControllerState.playCalls).toHaveLength(0);
    expect(previewControllerState.playFromCalls).toHaveLength(0);

    await act(async () => {
      previewControllerState.pauseCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([
      `pause:${controller.id}`,
      `playFrom:${controller.id}:5000`,
    ]);
    expect(previewControllerState.seekCalls).toHaveLength(0);
    expect(previewControllerState.playFromCalls).toHaveLength(1);
    expect(previewControllerState.playCalls).toHaveLength(0);
  });

  it('does not block playFrom behind an already in-flight paused seek', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.commandLog.length = 0;
    previewControllerState.seekCalls.length = 0;
    previewControllerState.playCalls.length = 0;
    previewControllerState.playFromCalls.length = 0;

    setMockPlayhead(5_000);
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([`seek:${controller.id}:5000`]);
    expect(previewControllerState.seekCalls).toHaveLength(1);

    timelineStoreState.current.isPlaying = true;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([
      `seek:${controller.id}:5000`,
      `playFrom:${controller.id}:5000`,
    ]);
    expect(previewControllerState.playFromCalls).toHaveLength(1);
    expect(previewControllerState.playCalls).toHaveLength(0);
  });

  it('queues a plain play after an in-flight pause when replay resumes at the same target', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.commandLog.length = 0;
    previewControllerState.playCalls.length = 0;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.deferPause = true;

    timelineStoreState.current.isPlaying = false;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = true;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([`pause:${controller.id}`]);

    await act(async () => {
      previewControllerState.pauseCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([
      `pause:${controller.id}`,
      `play:${controller.id}`,
    ]);
    expect(previewControllerState.playCalls).toHaveLength(1);
  });

  it('accepts native playing samples again after a pause request fails', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.deferPause = true;
    timelineStoreState.current.isPlaying = false;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      previewControllerState.pauseCalls[0]?.deferred?.reject(new Error('pause failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 1_240,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    const host = container.querySelector('[data-testid="native-preview-host"]');
    expect(host?.getAttribute('data-state')).toBe('playing');
    expect(host?.getAttribute('data-position')).toBe('1240');
  });

  it('pauses against the latest native playing position when position arrives before playing state', async () => {
    setMockPlayhead(1_200);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_200,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.playCalls.length = 0;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;

    timelineStoreState.current.isPlaying = true;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.playCalls).toHaveLength(1);

    await act(async () => {
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 1_520,
          isPlaying: true,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = false;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.pauseCalls).toHaveLength(1);
    expect(previewControllerState.seekCalls).toHaveLength(0);

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_540,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(0);
  });

  it('accepts the first real playing position after a slow play start times out the local intent', async () => {
    let nowMs = 0;
    const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    try {
      setMockPlayhead(1_200);
      timelineStoreState.current.duration = 10_000;

      await act(async () => {
        root.render(<HookHost />);
        await Promise.resolve();
        await Promise.resolve();
      });

      const controller = previewControllerState.instances[0];
      expect(controller).toBeDefined();

      await act(async () => {
        controller.emit({
          type: 'state',
          payload: {
            sessionId: controller.id,
            state: 'paused',
            positionMs: 1_200,
            rate: 1,
            nativeSurfaceAttached: true,
            timelineAttached: true,
          },
        });
        await Promise.resolve();
      });

      previewControllerState.playCalls.length = 0;
      previewControllerState.pauseCalls.length = 0;
      previewControllerState.seekCalls.length = 0;

      timelineStoreState.current.isPlaying = true;
      await act(async () => {
        root.render(<HookHost />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(previewControllerState.playCalls).toHaveLength(1);

      nowMs = 1_600;
      await act(async () => {
        controller.emit({
          type: 'position',
          payload: {
            sessionId: controller.id,
            positionMs: 1_520,
            isPlaying: true,
            isBuffering: false,
            driftMs: 0,
            rate: 1,
          },
        });
        await Promise.resolve();
      });

      timelineStoreState.current.isPlaying = false;
      await act(async () => {
        root.render(<HookHost />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(previewControllerState.pauseCalls).toHaveLength(1);
      expect(previewControllerState.seekCalls).toHaveLength(0);

      nowMs = 1_620;
      await act(async () => {
        controller.emit({
          type: 'state',
          payload: {
            sessionId: controller.id,
            state: 'paused',
            positionMs: 1_540,
            rate: 1,
            nativeSurfaceAttached: true,
            timelineAttached: true,
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(previewControllerState.seekCalls).toHaveLength(0);
    } finally {
      performanceNowSpy.mockRestore();
    }
  });

  it('ignores stale paused state samples after the latest local intent has switched back to play', async () => {
    setMockPlayhead(8_000);
    timelineStoreState.current.duration = 30_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 8_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.setPlayhead.mockClear();
    timelineStoreState.current.setPlayheadRefOnly.mockClear();
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 8_120,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.setPlayhead).not.toHaveBeenCalled();
    expect(timelineStoreState.current.setPlayheadRefOnly).not.toHaveBeenCalledWith(8_120);
  });

  it('ignores late playing position samples after paused state so paused scrubbing can still seek', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = false;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.pauseCalls).toHaveLength(1);

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_040,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 1_030,
          isPlaying: true,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.seekCalls.length = 0;
    setMockPlayhead(5_000);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(1);
    expect(previewControllerState.seekCalls[0]?.timeMs).toBe(5_000);
  });

  it('uses the authoritative playhead ref for paused seeks after a rapid pause', async () => {
    setMockPlayhead(8_077);
    timelineStoreState.current.duration = 30_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 8_077,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.seekCalls.length = 0;

    timelineStoreState.current.isPlaying = false;
    setMockPlayhead(8_340, 127);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 8_077,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(1);
    expect(previewControllerState.seekCalls[0]?.timeMs).toBe(8_340);
  });

  it('does not let an ignored stale paused state overwrite the observed playing transport', async () => {
    setMockPlayhead(8_077);
    timelineStoreState.current.duration = 30_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 8_077,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.playCalls.length = 0;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;

    timelineStoreState.current.isPlaying = true;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.playCalls).toHaveLength(1);

    await act(async () => {
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 8_340,
          isPlaying: true,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 8_077,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;
    timelineStoreState.current.isPlaying = false;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.pauseCalls).toHaveLength(1);

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 8_340,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(0);
  });

  it('queues a pause behind an in-flight play when playback is cancelled before native enters playing', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.commandLog.length = 0;
    previewControllerState.playCalls.length = 0;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.deferPlay = true;

    timelineStoreState.current.isPlaying = true;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = false;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([`play:${controller.id}`]);
    expect(previewControllerState.pauseCalls).toHaveLength(0);

    await act(async () => {
      previewControllerState.playCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([
      `play:${controller.id}`,
      `pause:${controller.id}`,
    ]);
    expect(previewControllerState.pauseCalls).toHaveLength(1);
  });

  it('accepts native paused samples again after a playFrom request fails', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.deferPlayFrom = true;
    setMockPlayhead(5_000);
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      previewControllerState.playFromCalls[0]?.deferred?.reject(new Error('playFrom failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    const host = container.querySelector('[data-testid="native-preview-host"]');
    expect(host?.getAttribute('data-state')).toBe('paused');
    expect(host?.getAttribute('data-position')).toBe('1000');
  });

  it('does not issue a second pause after native reaches paused and instead seeks to the editor target', async () => {
    setMockPlayhead(4_127);
    timelineStoreState.current.duration = 30_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 4_127,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 4_068,
          isPlaying: true,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;

    timelineStoreState.current.isPlaying = false;
    setMockPlayhead(18_580);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.pauseCalls).toHaveLength(1);

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 4_117,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.pauseCalls).toHaveLength(1);
    expect(previewControllerState.seekCalls).toHaveLength(1);
    expect(previewControllerState.seekCalls[0]?.timeMs).toBe(18_580);
  });

  it('accepts native paused samples again after a seek request fails', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    setMockPlayhead(5_000);
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      previewControllerState.seekCalls[0]?.deferred.reject(new Error('seek failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    const host = container.querySelector('[data-testid="native-preview-host"]');
    expect(host?.getAttribute('data-position')).toBe('1000');
  });

  it('ignores stale playing position samples after playFrom jumps to a newer target', async () => {
    setMockPlayhead(7_857);
    timelineStoreState.current.duration = 30_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 7_857,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = false;
    setMockPlayhead(18_960);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 7_857,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.playFromCalls.length = 0;
    timelineStoreState.current.isPlaying = true;
    timelineStoreState.current.setPlayhead.mockClear();
    timelineStoreState.current.setPlayheadRefOnly.mockClear();

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(1);

    await act(async () => {
      previewControllerState.seekCalls[0]?.deferred.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.playFromCalls).toHaveLength(1);
    expect(previewControllerState.playFromCalls[0]?.timeMs).toBe(18_960);

    setMockPlayhead(19_360);

    await act(async () => {
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 8_120,
          isPlaying: true,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.playhead).toBe(19_360);
    expect(timelineStoreState.current.playheadRef).toBe(19_360);
    expect(timelineStoreState.current.setPlayhead).not.toHaveBeenCalledWith(8_120);
    expect(timelineStoreState.current.setPlayheadRefOnly).not.toHaveBeenCalledWith(8_120);
  });

  it('ignores stale playing position samples after playFrom rewinds to an earlier target', async () => {
    setMockPlayhead(18_960);
    timelineStoreState.current.duration = 30_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 18_960,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = false;
    setMockPlayhead(8_340);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 18_960,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.playFromCalls.length = 0;
    timelineStoreState.current.isPlaying = true;
    timelineStoreState.current.setPlayhead.mockClear();
    timelineStoreState.current.setPlayheadRefOnly.mockClear();

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.seekCalls).toHaveLength(1);

    await act(async () => {
      previewControllerState.seekCalls[0]?.deferred.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.playFromCalls).toHaveLength(1);
    expect(previewControllerState.playFromCalls[0]?.timeMs).toBe(8_340);

    await act(async () => {
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 18_720,
          isPlaying: true,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    expect(timelineStoreState.current.playhead).toBe(8_340);
    expect(timelineStoreState.current.playheadRef).toBe(8_340);
    expect(timelineStoreState.current.setPlayhead).not.toHaveBeenCalledWith(18_720);
    expect(timelineStoreState.current.setPlayheadRefOnly).not.toHaveBeenCalledWith(18_720);
  });

  it('pauses against the advanced playback clock instead of seeking back to the stale start target', async () => {
    setMockPlayhead(7_180);
    timelineStoreState.current.duration = 30_000;
    timelineStoreState.current.isPlaying = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 7_180,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'position',
        payload: {
          sessionId: controller.id,
          positionMs: 9_155,
          isPlaying: true,
          isBuffering: false,
          driftMs: 0,
          rate: 1,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = false;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.seekCalls.length = 0;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.pauseCalls).toHaveLength(1);
    expect(previewControllerState.seekCalls).toHaveLength(0);
  });

  it('skips a queued stale playFrom when high-frequency transport toggles end on pause', async () => {
    setMockPlayhead(1_000);
    timelineStoreState.current.duration = 10_000;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'paused',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = true;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      controller.emit({
        type: 'state',
        payload: {
          sessionId: controller.id,
          state: 'playing',
          positionMs: 1_000,
          rate: 1,
          nativeSurfaceAttached: true,
          timelineAttached: true,
        },
      });
      await Promise.resolve();
    });

    previewControllerState.commandLog.length = 0;
    previewControllerState.playCalls.length = 0;
    previewControllerState.playFromCalls.length = 0;
    previewControllerState.pauseCalls.length = 0;
    previewControllerState.deferPause = true;

    timelineStoreState.current.isPlaying = false;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    setMockPlayhead(5_000);
    timelineStoreState.current.isPlaying = true;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    timelineStoreState.current.isPlaying = false;
    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.commandLog).toEqual([`pause:${controller.id}`]);

    await act(async () => {
      previewControllerState.pauseCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container
        .querySelector('[data-testid="native-preview-host"]')
        ?.getAttribute('data-position'),
    ).not.toBe('5000');
    expect(previewControllerState.commandLog).toEqual([
      `pause:${controller.id}`,
      `pause:${controller.id}`,
    ]);
    expect(previewControllerState.playFromCalls).toHaveLength(0);
    expect(previewControllerState.playCalls).toHaveLength(0);
    expect(previewControllerState.pauseCalls).toHaveLength(2);
  });

  it('temporarily hides the native surface while a global occlusion blocker is active', async () => {
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(true);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();
    const visibleSurfaceSetupCalls = previewControllerState.surfaceSetupCalls.filter(
      (call) => call.controller === controller,
    );
    expect(visibleSurfaceSetupCalls).toHaveLength(2);
    const bootstrapRevision = visibleSurfaceSetupCalls[0]?.surfaceSyncRevision;
    expect(typeof bootstrapRevision).toBe('number');
    expect(visibleSurfaceSetupCalls[0]).toEqual({
      controller,
      kind: 'attach',
      desiredPresentingAtCall: false,
      surfaceAttachedAtCall: false,
      surfaceSyncRevision: bootstrapRevision,
      viewport: {
        x: 0,
        y: 0,
        width: 800,
        height: 400,
        scaleFactor: 1,
        visible: true,
      },
    });
    expect(visibleSurfaceSetupCalls[1]).toEqual({
      controller,
      kind: 'present',
      presenting: true,
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: bootstrapRevision,
    });
    expect(previewControllerState.setSurfacePresentingCalls.at(-1)).toEqual({
      controller,
      presenting: true,
    });

    let release!: () => void;
    await act(async () => {
      release = acquireNativePreviewOcclusion('modal');
      await Promise.resolve();
    });

    const hideCall = previewControllerState.surfaceSetupCalls.at(-1);
    expect(hideCall).toEqual({
      controller,
      kind: 'present',
      presenting: false,
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: expect.any(Number),
    });

    await act(async () => {
      release();
      await Promise.resolve();
    });

    const reshowPresentCall = previewControllerState.surfaceSetupCalls.at(-1);
    expect(reshowPresentCall).toEqual({
      controller,
      kind: 'present',
      presenting: true,
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: expect.any(Number),
    });
  });

  it('creates the native surface as hidden when a global occlusion blocker is already active', async () => {
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(true);

    let release!: () => void;
    await act(async () => {
      release = acquireNativePreviewOcclusion('modal');
      await Promise.resolve();
    });

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();
    const hiddenSurfaceSetupCalls = previewControllerState.surfaceSetupCalls.filter(
      (call) => call.controller === controller,
    );
    expect(hiddenSurfaceSetupCalls).toHaveLength(1);
    const hiddenBootstrapRevision = hiddenSurfaceSetupCalls[0]?.surfaceSyncRevision;
    expect(typeof hiddenBootstrapRevision).toBe('number');
    expect(hiddenSurfaceSetupCalls[0]).toEqual({
      controller,
      kind: 'attach',
      desiredPresentingAtCall: false,
      surfaceAttachedAtCall: false,
      surfaceSyncRevision: hiddenBootstrapRevision,
      viewport: {
        x: 0,
        y: 0,
        width: 800,
        height: 400,
        scaleFactor: 1,
        visible: true,
      },
    });
    expect(previewControllerState.setSurfacePresentingCalls).toHaveLength(0);

    mockHostRect = {
      x: 16,
      y: 24,
      width: 720,
      height: 360,
    };

    await act(async () => {
      release();
      await Promise.resolve();
    });

    const revealViewportCall = previewControllerState.surfaceSetupCalls.at(-2);
    const revealPresentCall = previewControllerState.surfaceSetupCalls.at(-1);
    expect(revealViewportCall).toEqual({
      controller,
      kind: 'viewport',
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: expect.any(Number),
      viewport: {
        x: 16,
        y: 24,
        width: 720,
        height: 360,
        scaleFactor: 1,
        visible: true,
      },
    });
    expect(revealPresentCall).toEqual({
      controller,
      kind: 'present',
      presenting: true,
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: (revealViewportCall as { surfaceSyncRevision: number | null }).surfaceSyncRevision,
    });
  });

  it('waits for queued viewport updates before re-presenting the native surface', async () => {
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(true);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    let release!: () => void;
    await act(async () => {
      release = acquireNativePreviewOcclusion('modal');
      await Promise.resolve();
      await Promise.resolve();
    });

    previewControllerState.surfaceSetupCalls.length = 0;
    previewControllerState.viewportCalls.length = 0;
    previewControllerState.presentingCalls.length = 0;
    previewControllerState.deferViewport = true;

    mockHostRect = {
      x: 16,
      y: 24,
      width: 720,
      height: 360,
    };

    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.surfaceSetupCalls).toEqual([
      {
        controller,
        kind: 'viewport',
        surfaceAttachedAtCall: true,
        surfaceSyncRevision: expect.any(Number),
        viewport: {
          x: 16,
          y: 24,
          width: 720,
          height: 360,
          scaleFactor: 1,
          visible: true,
        },
      },
    ]);
    expect(previewControllerState.presentingCalls).toHaveLength(0);

    mockHostRect = {
      x: 32,
      y: 48,
      width: 640,
      height: 320,
    };

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.surfaceSetupCalls).toHaveLength(1);
    expect(previewControllerState.presentingCalls).toHaveLength(0);

    await act(async () => {
      previewControllerState.viewportCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.surfaceSetupCalls).toHaveLength(2);
    expect(previewControllerState.surfaceSetupCalls[1]).toEqual({
      controller,
      kind: 'viewport',
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: (previewControllerState.surfaceSetupCalls[0] as { surfaceSyncRevision: number | null }).surfaceSyncRevision,
      viewport: {
        x: 32,
        y: 48,
        width: 640,
        height: 320,
        scaleFactor: 1,
        visible: true,
      },
    });
    expect(previewControllerState.presentingCalls).toHaveLength(0);

    previewControllerState.deferViewport = false;
    await act(async () => {
      previewControllerState.viewportCalls[1]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.surfaceSetupCalls).toHaveLength(3);
    expect(previewControllerState.surfaceSetupCalls[2]).toEqual({
      controller,
      kind: 'present',
      presenting: true,
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: (previewControllerState.surfaceSetupCalls[1] as { surfaceSyncRevision: number | null }).surfaceSyncRevision,
    });
  });

  it.skip('re-syncs the viewport after a slow attach before presenting the native surface', async () => {
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(true);
    previewControllerState.deferAttach = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();
    expect(previewControllerState.surfaceSetupCalls).toEqual([
      {
        controller,
        kind: 'attach',
        desiredPresentingAtCall: false,
        surfaceAttachedAtCall: false,
        surfaceSyncRevision: expect.any(Number),
        viewport: {
          x: 0,
          y: 0,
          width: 800,
          height: 400,
          scaleFactor: 1,
          visible: true,
        },
      },
    ]);

    mockHostRect = {
      x: 40,
      y: 60,
      width: 720,
      height: 360,
    };

    await act(async () => {
      previewControllerState.attachCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.surfaceSetupCalls).toHaveLength(3);
    const resyncedViewportCall = previewControllerState.surfaceSetupCalls[1];
    const presentCall = previewControllerState.surfaceSetupCalls[2];
    expect(resyncedViewportCall).toEqual({
      controller,
      kind: 'viewport',
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: (previewControllerState.surfaceSetupCalls[0] as { surfaceSyncRevision: number | null }).surfaceSyncRevision,
      viewport: {
        x: 40,
        y: 60,
        width: 720,
        height: 360,
        scaleFactor: 1,
        visible: true,
      },
    });
    expect(presentCall).toEqual({
      controller,
      kind: 'present',
      presenting: true,
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: (resyncedViewportCall as { surfaceSyncRevision: number | null }).surfaceSyncRevision,
    });
  });

  it.skip('keeps viewport updates flowing while the first present request is still in flight', async () => {
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(true);
    previewControllerState.deferPresenting = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();
    expect(previewControllerState.surfaceSetupCalls).toEqual([
      {
        controller,
        kind: 'attach',
        desiredPresentingAtCall: false,
        surfaceAttachedAtCall: false,
        surfaceSyncRevision: expect.any(Number),
        viewport: {
          x: 0,
          y: 0,
          width: 800,
          height: 400,
          scaleFactor: 1,
          visible: true,
        },
      },
      {
        controller,
        kind: 'present',
        presenting: true,
        surfaceAttachedAtCall: true,
        surfaceSyncRevision: expect.any(Number),
      },
    ]);

    mockHostRect = {
      x: 32,
      y: 48,
      width: 640,
      height: 360,
    };

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.surfaceSetupCalls).toHaveLength(3);
    expect(previewControllerState.surfaceSetupCalls[2]).toEqual({
      controller,
      kind: 'viewport',
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: (previewControllerState.surfaceSetupCalls[1] as { surfaceSyncRevision: number | null }).surfaceSyncRevision,
      viewport: {
        x: 32,
        y: 48,
        width: 640,
        height: 360,
        scaleFactor: 1,
        visible: true,
      },
    });

    await act(async () => {
      previewControllerState.presentingCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it.skip('cancels a stale visible surface bootstrap when a blocker appears before attach completes', async () => {
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(true);
    previewControllerState.deferAttach = true;

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();
    expect(previewControllerState.surfaceSetupCalls).toHaveLength(1);
    expect(previewControllerState.surfaceSetupCalls[0]).toEqual({
      controller,
      kind: 'attach',
      desiredPresentingAtCall: false,
      surfaceAttachedAtCall: false,
      surfaceSyncRevision: expect.any(Number),
      viewport: {
        x: 0,
        y: 0,
        width: 800,
        height: 400,
        scaleFactor: 1,
        visible: true,
      },
    });
    expect(previewControllerState.presentingCalls).toHaveLength(0);

    let release!: () => void;
    await act(async () => {
      release = acquireNativePreviewOcclusion('modal');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.surfaceSetupCalls).toHaveLength(2);
    expect(previewControllerState.surfaceSetupCalls[1]).toEqual({
      controller,
      kind: 'attach',
      desiredPresentingAtCall: false,
      surfaceAttachedAtCall: false,
      surfaceSyncRevision: expect.any(Number),
      viewport: {
        x: 0,
        y: 0,
        width: 800,
        height: 400,
        scaleFactor: 1,
        visible: true,
      },
    });
    expect(
      (previewControllerState.surfaceSetupCalls[1] as { surfaceSyncRevision: number | null })
        .surfaceSyncRevision,
    ).not.toBe(
      (previewControllerState.surfaceSetupCalls[0] as { surfaceSyncRevision: number | null })
        .surfaceSyncRevision,
    );
    expect(previewControllerState.presentingCalls).toHaveLength(0);

    await act(async () => {
      previewControllerState.attachCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.presentingCalls).toHaveLength(0);

    await act(async () => {
      previewControllerState.attachCalls[1]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.presentingCalls).toHaveLength(0);

    previewControllerState.deferAttach = false;
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });

    const finalRevealCall = previewControllerState.surfaceSetupCalls.at(-1);
    expect(finalRevealCall).toEqual({
      controller,
      kind: 'present',
      presenting: true,
      surfaceAttachedAtCall: true,
      surfaceSyncRevision: expect.any(Number),
    });
  });

  it('does not skip the reverse visibility update while the previous presenting request is still in flight', async () => {
    vi.mocked(isNativeTimelinePreviewDebugPresentSurfaceEnabled).mockReturnValue(true);

    await act(async () => {
      root.render(<HookHost />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const controller = previewControllerState.instances[0];
    expect(controller).toBeDefined();

    previewControllerState.surfaceSetupCalls.length = 0;
    previewControllerState.viewportCalls.length = 0;
    previewControllerState.presentingCalls.length = 0;
    previewControllerState.deferPresenting = true;

    let release!: () => void;
    await act(async () => {
      release = acquireNativePreviewOcclusion('modal');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.presentingCalls).toHaveLength(1);
    expect(previewControllerState.surfaceSetupCalls).toEqual([
      {
        controller,
        kind: 'present',
        presenting: false,
        surfaceAttachedAtCall: true,
        surfaceSyncRevision: expect.any(Number),
      },
    ]);

    mockHostRect = {
      x: 20,
      y: 30,
      width: 640,
      height: 360,
    };

    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewControllerState.presentingCalls).toHaveLength(2);
    expect(previewControllerState.surfaceSetupCalls.slice(-2)).toEqual([
      {
        controller,
        kind: 'viewport',
        surfaceAttachedAtCall: true,
        surfaceSyncRevision: expect.any(Number),
        viewport: {
          x: 20,
          y: 30,
          width: 640,
          height: 360,
          scaleFactor: 1,
          visible: true,
        },
      },
      {
        controller,
        kind: 'present',
        presenting: true,
        surfaceAttachedAtCall: true,
        surfaceSyncRevision: expect.any(Number),
      },
    ]);
    expect(previewControllerState.presentingCalls.map((call) => call.presenting)).toEqual([
      false,
      true,
    ]);
    expect(previewControllerState.presentingCalls[0]?.surfaceSyncRevision).not.toBe(
      previewControllerState.presentingCalls[1]?.surfaceSyncRevision,
    );

    await act(async () => {
      previewControllerState.presentingCalls[1]?.deferred?.resolve();
      previewControllerState.presentingCalls[0]?.deferred?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
