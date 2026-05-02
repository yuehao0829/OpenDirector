import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  buildTimelinePreviewSnapshot,
  isNativeTimelinePreviewDebugPresentSurfaceEnabled,
  isNativeTimelinePreviewEnabled,
  PreviewSessionController,
} from '@opendirector/core/services/preview-session';
import { ensureProjectVideoSourceAudioMetadata } from '@opendirector/core/services/project-service';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import {
  registerNativePreviewStepFrameHandler,
  useTimelineStore,
} from '@opendirector/core/stores/timelineStore';
import type {
  PreviewDiagnostics,
  PreviewSessionState,
  PreviewViewport,
} from '@opendirector/core/types/media-preview';
import { getErrorMessage } from '@opendirector/core/utils/common';
import {
  isNativePreviewOccluded,
  subscribeNativePreviewOcclusion,
} from '@opendirector/core/utils/native-preview-occlusion';
import {
  projectNativePlaybackPosition,
  type NativePlaybackSample,
} from './nativePlaybackClock';
import {
  shouldIgnoreBackwardNativePlayingClockRebase,
  shouldIgnoreStaleNativePlayingPosition,
  shouldRebasePlayingClockToNative,
  shouldSyncPausedNativePlayhead,
} from './nativeTimelinePreviewSync';

interface UseNativeTimelinePreviewOptions {
  enabled: boolean;
  containerRef: RefObject<HTMLElement | null>;
}

interface UseNativeTimelinePreviewResult {
  active: boolean;
  sessionId: string | null;
  state: PreviewSessionState;
  surfaceAttached: boolean;
  timelineAttached: boolean;
  positionMs: number;
  transportControlled: boolean;
  diagnostics: PreviewDiagnostics | null;
  error: string | null;
}

interface TimelineSubmissionState {
  controller: PreviewSessionController | null;
  sessionId: string | null;
  key: string | null;
  status: 'idle' | 'in_flight' | 'applied';
}

interface QueuedTimelineSubmission {
  controller: PreviewSessionController;
  sessionId: string;
  key: string;
  snapshot: ReturnType<typeof buildTimelinePreviewSnapshot>;
}

const DIAGNOSTICS_EVENT_DEBOUNCE_MS = 80;
const NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS = 250;
const PENDING_NATIVE_TARGET_MAX_AGE_MS = 2_000;
const PENDING_TRANSPORT_INTENT_MAX_AGE_MS = 1_500;

function createIdleTimelineSubmissionState(): TimelineSubmissionState {
  return {
    controller: null,
    sessionId: null,
    key: null,
    status: 'idle',
  };
}

function createPreviewSnapshotKey(snapshot: ReturnType<typeof buildTimelinePreviewSnapshot>): string {
  return JSON.stringify(snapshot);
}

function ensureSurfaceId(element: HTMLElement): string {
  if (!element.id) {
    element.id = `native-timeline-preview-host-${Math.random().toString(36).slice(2, 10)}`;
  }
  return element.id;
}

function readViewport(element: HTMLElement): PreviewViewport {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const opacity = Number.parseFloat(style.opacity || '1');
  const visible =
    element.isConnected &&
    document.visibilityState === 'visible' &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    opacity > 0 &&
    rect.width > 0 &&
    rect.height > 0;

  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    scaleFactor: window.devicePixelRatio || 1,
    visible,
  };
}

function areViewportsEqual(left: PreviewViewport, right: PreviewViewport): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.scaleFactor === right.scaleFactor &&
    left.visible === right.visible
  );
}

export function useNativeTimelinePreview({
  enabled,
  containerRef,
}: UseNativeTimelinePreviewOptions): UseNativeTimelinePreviewResult {
  const currentProject = useProjectStore((state) => state.currentProject);
  const projectId = currentProject?.id ?? null;
  const projectFolderPath = currentProject?.folderPath ?? null;
  const tracks = useTimelineStore((state) => state.tracks);
  const fragments = useTimelineStore((state) => state.fragments);
  const scenes = useTimelineStore((state) => state.scenes);
  const playhead = useTimelineStore((state) => state.playhead);
  const isPlaying = useTimelineStore((state) => state.isPlaying);
  const setNativePreviewTransportControlled = useTimelineStore(
    (state) => state.setNativePreviewTransportControlled,
  );
  const assets = useAssetStore((state) => state.assets);

  const controllerRef = useRef<PreviewSessionController | null>(null);
  const surfaceBootstrapTaskRef = useRef(0);
  const surfaceSyncRevisionRef = useRef(0);
  const queuedSurfaceViewportRef = useRef<PreviewViewport | null>(null);
  const lastSurfaceViewportRef = useRef<PreviewViewport | null>(null);
  const lastRequestedSurfacePresentingRef = useRef<boolean | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<PreviewSessionState>('idle');
  const [surfaceAttached, setSurfaceAttached] = useState(false);
  const [timelineAttached, setTimelineAttached] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [diagnostics, setDiagnostics] = useState<PreviewDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [surfaceOccluded, setSurfaceOccluded] = useState(() => isNativePreviewOccluded());

  const active = enabled && isNativeTimelinePreviewEnabled() && !!projectFolderPath;
  const debugPresentSurface = active && isNativeTimelinePreviewDebugPresentSurfaceEnabled();
  const shouldPresentSurface = debugPresentSurface && !surfaceOccluded;
  const shouldPresentSurfaceRef = useRef(shouldPresentSurface);
  shouldPresentSurfaceRef.current = shouldPresentSurface;
  const transportControlled =
    active && surfaceAttached && timelineAttached && state !== 'error' && state !== 'destroyed';

  const nativePlayheadSyncRef = useRef<{
    positionMs: number;
    updatedAt: number;
  }>({
    positionMs: 0,
    updatedAt: 0,
  });
  const nativeStepFrameInFlightRef = useRef(false);
  const nativeSeekQueueRef = useRef<{
    inFlight: boolean;
    activeTargetMs: number | null;
    activeTargetGeneration: number | null;
    queuedTargetMs: number | null;
    queuedTargetGeneration: number | null;
    generation: number;
  }>({
    inFlight: false,
    activeTargetMs: null,
    activeTargetGeneration: null,
    queuedTargetMs: null,
    queuedTargetGeneration: null,
    generation: 0,
  });
  const nativeTransportCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nativeBackendPositionRef = useRef<NativePlaybackSample>({
    positionMs: 0,
    updatedAt: 0,
    rate: 1,
  });
  const nativeObservedTransportStateRef = useRef<'playing' | 'paused' | null>(null);
  const nativePlaybackClockRef = useRef<{
    basePositionMs: number;
    baseUpdatedAt: number;
    rate: number;
  }>({
    basePositionMs: 0,
    baseUpdatedAt: 0,
    rate: 1,
  });
  const pendingNativeTargetRef = useRef<{
    generation: number;
    targetMs: number;
    sourcePositionMs: number;
    requestedAt: number;
  } | null>(null);
  const pendingNativeTargetGenerationRef = useRef(0);
  const pendingTransportIntentRef = useRef<{
    generation: number;
    desiredState: 'playing' | 'paused';
    targetMs: number | null;
    sourcePositionMs: number | null;
    requestedAt: number;
  } | null>(null);
  const transportIntentGenerationRef = useRef(0);

  const refreshDiagnosticsRef = useRef<((priority?: 'event' | 'immediate') => void) | null>(null);
  const diagnosticsRefreshStateRef = useRef<{
    inFlight: boolean;
    queued: boolean;
    timerId: number | null;
  }>({
    inFlight: false,
    queued: false,
    timerId: null,
  });
  const timelineSubmissionRef = useRef<TimelineSubmissionState>(createIdleTimelineSubmissionState());
  const queuedTimelineSubmissionRef = useRef<QueuedTimelineSubmission | null>(null);

  const getPauseTransportTargetMs = useCallback(() => {
    const timelineState = useTimelineStore.getState();
    if (
      state === 'playing' ||
      nativeObservedTransportStateRef.current === 'playing'
    ) {
      return Math.max(0, projectNativePlaybackClockPosition(performance.now()));
    }
    return Math.max(0, timelineState.getPlayheadRef());
  }, [state]);

  const resetPreviewState = () => {
    setSessionId(null);
    setState('idle');
    setSurfaceAttached(false);
    setTimelineAttached(false);
    setPositionMs(0);
    setDiagnostics(null);
    setError(null);
    nativeBackendPositionRef.current = {
      positionMs: 0,
      updatedAt: 0,
      rate: 1,
    };
    nativeObservedTransportStateRef.current = null;
    nativePlaybackClockRef.current = {
      basePositionMs: 0,
      baseUpdatedAt: 0,
      rate: 1,
    };
    nativePlayheadSyncRef.current = {
      positionMs: 0,
      updatedAt: 0,
    };
    nativeTransportCommandQueueRef.current = Promise.resolve();
    pendingNativeTargetRef.current = null;
    pendingTransportIntentRef.current = null;
  };

  const resetTimelineSubmission = () => {
    timelineSubmissionRef.current = createIdleTimelineSubmissionState();
    queuedTimelineSubmissionRef.current = null;
  };

  const applySessionState = (nextSession: {
    state: PreviewSessionState;
    nativeSurfaceAttached: boolean;
    timelineAttached: boolean;
  }) => {
    setState(nextSession.state);
    setSurfaceAttached(nextSession.nativeSurfaceAttached);
    setTimelineAttached(nextSession.timelineAttached);
  };

  const updateTimelineSubmission = (
    nextController: PreviewSessionController,
    nextSessionId: string,
    nextKey: string,
    nextStatus: TimelineSubmissionState['status'],
  ) => {
    timelineSubmissionRef.current = {
      controller: nextController,
      sessionId: nextSessionId,
      key: nextKey,
      status: nextStatus,
    };
  };

  const submitTimelineSnapshot = (
    controller: PreviewSessionController,
    controllerSessionId: string,
    snapshotKey: string,
    snapshot: ReturnType<typeof buildTimelinePreviewSnapshot>,
  ) => {
    const currentSubmission = timelineSubmissionRef.current;
    if (
      currentSubmission.controller === controller &&
      currentSubmission.sessionId === controllerSessionId &&
      currentSubmission.status === 'in_flight'
    ) {
      queuedTimelineSubmissionRef.current = {
        controller,
        sessionId: controllerSessionId,
        key: snapshotKey,
        snapshot,
      };
      return;
    }

    updateTimelineSubmission(controller, controllerSessionId, snapshotKey, 'in_flight');

    void controller
      .setTimeline(snapshot)
      .then(() => {
        if (
          timelineSubmissionRef.current.controller === controller &&
          timelineSubmissionRef.current.sessionId === controllerSessionId &&
          timelineSubmissionRef.current.key === snapshotKey
        ) {
          updateTimelineSubmission(controller, controllerSessionId, snapshotKey, 'applied');
        }
        if (isCurrentController(controller)) {
          refreshDiagnosticsRef.current?.('immediate');
        }
      })
      .catch((timelineError) => {
        if (
          timelineSubmissionRef.current.controller === controller &&
          timelineSubmissionRef.current.sessionId === controllerSessionId &&
          timelineSubmissionRef.current.key === snapshotKey
        ) {
          resetTimelineSubmission();
        }
        if (!isCurrentController(controller)) {
          return;
        }
        const message = getErrorMessage(timelineError);
        setError(message);
        setState('error');
        setTimelineAttached(false);
      })
      .finally(() => {
        const queuedSubmission = queuedTimelineSubmissionRef.current;
        if (
          queuedSubmission &&
          queuedSubmission.controller === controller &&
          queuedSubmission.sessionId === controllerSessionId &&
          isCurrentController(controller)
        ) {
          queuedTimelineSubmissionRef.current = null;
          submitTimelineSnapshot(
            queuedSubmission.controller,
            queuedSubmission.sessionId,
            queuedSubmission.key,
            queuedSubmission.snapshot,
          );
        }
      });
  };

  const isCurrentController = useCallback(
    (controller: PreviewSessionController | null): boolean =>
      controller !== null && controllerRef.current === controller,
    [],
  );

  const enqueueNativeTransportCommand = useCallback(
    async (
      controller: PreviewSessionController,
      command: () => Promise<void>,
    ): Promise<void> => {
      const queuedCommand = nativeTransportCommandQueueRef.current
        .catch(() => {})
        .then(async () => {
          if (!isCurrentController(controller)) {
            return;
          }
          await command();
        });

      nativeTransportCommandQueueRef.current = queuedCommand.catch(() => {});
      return queuedCommand;
    },
    [isCurrentController],
  );

  const syncTimelinePlayheadFromNative = (
    positionMs: number,
    updatedAt: number,
    syncStore: boolean,
  ) => {
    const clampedPositionMs = Math.max(0, positionMs);
    nativePlayheadSyncRef.current = {
      positionMs: clampedPositionMs,
      updatedAt,
    };

    const timelineState = useTimelineStore.getState();
    if (syncStore) {
      if (
        Math.abs(timelineState.playhead - clampedPositionMs) > 0.5 ||
        Math.abs(timelineState.getPlayheadRef() - clampedPositionMs) > 0.5
      ) {
        timelineState.setPlayhead(clampedPositionMs);
      } else {
        timelineState.setPlayheadRefOnly(clampedPositionMs);
      }
      return;
    }

    if (Math.abs(timelineState.getPlayheadRef() - clampedPositionMs) > 0.5) {
      timelineState.setPlayheadRefOnly(clampedPositionMs);
    }
  };

  const rebaseNativePlaybackClock = (
    positionMs: number,
    updatedAt: number,
    rate = 1,
  ) => {
    nativePlaybackClockRef.current = {
      basePositionMs: Math.max(0, positionMs),
      baseUpdatedAt: updatedAt,
      rate: rate > 0 ? rate : 1,
    };
  };

  const projectNativePlaybackClockPosition = (targetTime: number) => {
    const clock = nativePlaybackClockRef.current;
    return projectNativePlaybackPosition(
      {
        positionMs: clock.basePositionMs,
        updatedAt: clock.baseUpdatedAt,
        rate: clock.rate,
      },
      targetTime,
    );
  };

  const shouldSyncPausedPositionFromNative = (
    positionMs: number,
    controller: PreviewSessionController,
  ) => {
    const controllerSessionId = controller.sessionId;
    const controllerTimelineAttached = controller.info?.timelineAttached ?? false;
    const hasSubmittedTimeline =
      controllerSessionId !== null &&
      timelineSubmissionRef.current.controller === controller &&
      timelineSubmissionRef.current.sessionId === controllerSessionId &&
      timelineSubmissionRef.current.status !== 'idle';
    const timelineState = useTimelineStore.getState();
    return shouldSyncPausedNativePlayhead({
      nextPositionMs: positionMs,
      currentPlayheadMs: timelineState.playhead,
      currentPlayheadRefMs: timelineState.getPlayheadRef(),
      timelineDurationMs: timelineState.duration,
      timelineReady: controllerTimelineAttached || hasSubmittedTimeline,
      timelineAttached: controllerTimelineAttached,
      thresholdMs: NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS,
    });
  };

  const markPendingNativeTarget = useCallback((targetMs: number, requestedAt = performance.now()) => {
    const generation = pendingNativeTargetGenerationRef.current + 1;
    pendingNativeTargetGenerationRef.current = generation;
    pendingNativeTargetRef.current = {
      generation,
      targetMs: Math.max(0, targetMs),
      sourcePositionMs: Math.max(0, nativeBackendPositionRef.current.positionMs),
      requestedAt,
    };
    return generation;
  }, []);

  const markPendingTransportIntent = useCallback(
    (
      desiredState: 'playing' | 'paused',
      targetMs: number | null,
      requestedAt = performance.now(),
    ) => {
      const generation = transportIntentGenerationRef.current + 1;
      transportIntentGenerationRef.current = generation;
      pendingTransportIntentRef.current = {
        generation,
        desiredState,
        targetMs: targetMs === null ? null : Math.max(0, targetMs),
        sourcePositionMs:
          targetMs === null ? null : Math.max(0, nativeBackendPositionRef.current.positionMs),
        requestedAt,
      };
      return generation;
    },
    [],
  );

  const getPendingTransportIntent = useCallback((now = performance.now()) => {
    const pendingTransportIntent = pendingTransportIntentRef.current;
    if (!pendingTransportIntent) {
      return null;
    }

    if (now - pendingTransportIntent.requestedAt > PENDING_TRANSPORT_INTENT_MAX_AGE_MS) {
      pendingTransportIntentRef.current = null;
      return null;
    }

    return pendingTransportIntent;
  }, []);

  const clearPendingTransportIntentIfCurrent = useCallback(
    (generation: number, desiredState: 'playing' | 'paused') => {
      const pendingTransportIntent = pendingTransportIntentRef.current;
      if (!pendingTransportIntent) {
        return;
      }

      if (
        pendingTransportIntent.generation !== generation ||
        pendingTransportIntent.desiredState !== desiredState
      ) {
        return;
      }

      pendingTransportIntentRef.current = null;
    },
    [],
  );

  const clearPendingNativeTargetIfCurrent = useCallback((generation: number) => {
    const pendingNativeTarget = pendingNativeTargetRef.current;
    if (!pendingNativeTarget) {
      return;
    }

    if (pendingNativeTarget.generation !== generation) {
      return;
    }

    pendingNativeTargetRef.current = null;
  }, []);

  const isPendingTransportIntentCurrent = useCallback(
    (generation: number, desiredState: 'playing' | 'paused', now = performance.now()) => {
      const pendingTransportIntent = getPendingTransportIntent(now);
      if (!pendingTransportIntent) {
        return false;
      }

      return (
        pendingTransportIntent.generation === generation &&
        pendingTransportIntent.desiredState === desiredState
      );
    },
    [getPendingTransportIntent],
  );

  const shouldIgnoreConflictingTransportSample = useCallback(
    (sampleState: 'playing' | 'paused', now = performance.now()) => {
      const pendingTransportIntent = getPendingTransportIntent(now);
      if (!pendingTransportIntent) {
        return false;
      }

      return pendingTransportIntent.desiredState !== sampleState;
    },
    [getPendingTransportIntent],
  );

  const settlePendingTransportIntent = useCallback(
    (sampleState: 'playing' | 'paused', positionMs: number, now = performance.now()) => {
      const pendingTransportIntent = getPendingTransportIntent(now);
      if (!pendingTransportIntent) {
        return;
      }

      if (pendingTransportIntent.desiredState !== sampleState) {
        return;
      }

      if (
        sampleState === 'playing' &&
        pendingTransportIntent.targetMs !== null
      ) {
        const sourcePositionMs = pendingTransportIntent.sourcePositionMs;
        const targetPositionMs = pendingTransportIntent.targetMs;
        if (
          sourcePositionMs === null ||
          (targetPositionMs > sourcePositionMs &&
            positionMs < targetPositionMs - NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS) ||
          (targetPositionMs < sourcePositionMs &&
            positionMs > targetPositionMs + NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS) ||
          (Math.abs(targetPositionMs - sourcePositionMs) <=
            NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS &&
            Math.abs(positionMs - targetPositionMs) >
              NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS)
        ) {
          return;
        }
      }
      pendingTransportIntentRef.current = null;
    },
    [getPendingTransportIntent],
  );

  const clearPendingNativeTargetIfSettled = useCallback(
    (positionMs: number, now = performance.now()) => {
      const pendingTarget = pendingNativeTargetRef.current;
      if (!pendingTarget) {
        return;
      }

      const expired = now - pendingTarget.requestedAt > PENDING_NATIVE_TARGET_MAX_AGE_MS;
      const settled =
        (pendingTarget.targetMs > pendingTarget.sourcePositionMs &&
          positionMs >= pendingTarget.targetMs - NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS) ||
        (pendingTarget.targetMs < pendingTarget.sourcePositionMs &&
          positionMs <= pendingTarget.targetMs + NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS) ||
        (Math.abs(pendingTarget.targetMs - pendingTarget.sourcePositionMs) <=
          NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS &&
          Math.abs(positionMs - pendingTarget.targetMs) <=
            NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS);

      if (!expired && !settled) {
        return;
      }
      pendingNativeTargetRef.current = null;
    },
    [],
  );

  const shouldIgnorePlayingSample = useCallback(
    (positionMs: number, now = performance.now()) => {
      clearPendingNativeTargetIfSettled(positionMs, now);
      const pendingTarget = pendingNativeTargetRef.current;
      if (!pendingTarget) {
        return false;
      }

      return shouldIgnoreStaleNativePlayingPosition({
        nextPositionMs: positionMs,
        targetPositionMs: pendingTarget.targetMs,
        sourcePositionMs: pendingTarget.sourcePositionMs,
        currentPlayheadRefMs: useTimelineStore.getState().getPlayheadRef(),
        requestedAt: pendingTarget.requestedAt,
        now,
        thresholdMs: NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS,
        maxPendingMs: PENDING_NATIVE_TARGET_MAX_AGE_MS,
      });
    },
    [clearPendingNativeTargetIfSettled],
  );

  const shouldFreezePlayheadForPendingPause = useCallback(() => {
    const pendingTransportIntent = pendingTransportIntentRef.current;
    if (!pendingTransportIntent) {
      return false;
    }

    if (pendingTransportIntent.desiredState !== 'paused') {
      return false;
    }

    if (
      performance.now() - pendingTransportIntent.requestedAt >
      PENDING_TRANSPORT_INTENT_MAX_AGE_MS
    ) {
      return false;
    }

    return !useTimelineStore.getState().isPlaying;
  }, []);

  const pumpNativeSeekQueue = useCallback(async (controller: PreviewSessionController) => {
    const seekQueue = nativeSeekQueueRef.current;
    if (seekQueue.inFlight) {
      return;
    }

    seekQueue.inFlight = true;

    try {
      while (true) {
        const nextTargetMs = seekQueue.queuedTargetMs;
        const nextTargetGeneration = seekQueue.queuedTargetGeneration;
        seekQueue.queuedTargetMs = null;
        seekQueue.queuedTargetGeneration = null;
        if (nextTargetMs === null) {
          break;
        }
        const generationAtQueueDrain = seekQueue.generation;
        seekQueue.activeTargetMs = nextTargetMs;
        seekQueue.activeTargetGeneration = nextTargetGeneration;

        if (
          !isCurrentController(controller) ||
          !timelineAttached ||
          useTimelineStore.getState().isPlaying
        ) {
          break;
        }

        try {
          const currentSeekQueue = nativeSeekQueueRef.current;
          const storeIsPlaying = useTimelineStore.getState().isPlaying;
          if (
            storeIsPlaying ||
            currentSeekQueue.generation !== generationAtQueueDrain
          ) {
            continue;
          }

          await controller.seek(nextTargetMs);
          const currentSeekQueueAfterSeek = nativeSeekQueueRef.current;
          if (
            !isCurrentController(controller) ||
            !timelineAttached ||
            useTimelineStore.getState().isPlaying ||
            currentSeekQueueAfterSeek.generation !== generationAtQueueDrain
          ) {
            continue;
          }
          const syncAt = performance.now();
          nativeBackendPositionRef.current = {
            positionMs: nextTargetMs,
            updatedAt: syncAt,
            rate: nativeBackendPositionRef.current.rate,
          };
          setPositionMs(nextTargetMs);
          if (isCurrentController(controller)) {
            refreshDiagnosticsRef.current?.('immediate');
          }
        } catch (seekError) {
          if (nextTargetGeneration !== null) {
            clearPendingNativeTargetIfCurrent(nextTargetGeneration);
          }
          if (isCurrentController(controller)) {
            const message = getErrorMessage(seekError);
            setError(message);
          }
          break;
        }
      }
    } finally {
      seekQueue.inFlight = false;
      seekQueue.activeTargetMs = null;
      seekQueue.activeTargetGeneration = null;
    }

    if (!isCurrentController(controller)) {
      return;
    }

    if (seekQueue.queuedTargetMs !== null) {
      void pumpNativeSeekQueue(controller);
      return;
    }
  }, [
    clearPendingNativeTargetIfCurrent,
    clearPendingNativeTargetIfSettled,
    isCurrentController,
    timelineAttached,
  ]);

  refreshDiagnosticsRef.current = (priority = 'event') => {
    const controller = controllerRef.current;
    if (!controller) return;

    const refreshState = diagnosticsRefreshStateRef.current;
    const runRefresh = () => {
      const activeController = controllerRef.current;
      if (!activeController) return;

      if (refreshState.inFlight) {
        refreshState.queued = true;
        return;
      }

      refreshState.inFlight = true;
      void activeController
        .getDiagnostics()
        .then((nextDiagnostics) => {
          if (isCurrentController(activeController)) {
            setDiagnostics(nextDiagnostics);
          }
        })
        .catch((diagnosticsError) => {
          if (isCurrentController(activeController)) {
            const message = getErrorMessage(diagnosticsError);
            setError(message);
          }
        })
        .finally(() => {
          refreshState.inFlight = false;
          if (refreshState.queued) {
            refreshState.queued = false;
            runRefresh();
          }
        });
    };

    if (priority === 'immediate') {
      if (refreshState.timerId !== null) {
        window.clearTimeout(refreshState.timerId);
        refreshState.timerId = null;
      }
      runRefresh();
      return;
    }

    if (refreshState.inFlight) {
      refreshState.queued = true;
      return;
    }

    if (refreshState.timerId !== null) {
      return;
    }

    refreshState.timerId = window.setTimeout(() => {
      refreshState.timerId = null;
      runRefresh();
    }, DIAGNOSTICS_EVENT_DEBOUNCE_MS);
  };

  useEffect(() => {
    setNativePreviewTransportControlled(transportControlled);
  }, [setNativePreviewTransportControlled, transportControlled]);

  useEffect(() => {
    return () => {
      setNativePreviewTransportControlled(false);
    };
  }, [setNativePreviewTransportControlled]);

  useEffect(() => {
    if (!active || !projectId) {
      const controller = controllerRef.current;
      controllerRef.current = null;
      nativeStepFrameInFlightRef.current = false;
      nativeSeekQueueRef.current.inFlight = false;
      nativeSeekQueueRef.current.activeTargetMs = null;
      nativeSeekQueueRef.current.activeTargetGeneration = null;
      nativeSeekQueueRef.current.queuedTargetMs = null;
      nativeSeekQueueRef.current.queuedTargetGeneration = null;
      nativeSeekQueueRef.current.generation += 1;
      resetTimelineSubmission();
      resetPreviewState();
      const refreshState = diagnosticsRefreshStateRef.current;
      if (refreshState.timerId !== null) {
        window.clearTimeout(refreshState.timerId);
        refreshState.timerId = null;
      }
      refreshState.queued = false;
      refreshState.inFlight = false;

      if (controller) {
        void controller.destroy().catch((destroyError) => {
          console.warn('[NativeTimelinePreview] failed to destroy session:', destroyError);
        });
      }
      return;
    }

    let disposed = false;
    const controller = new PreviewSessionController();
    resetTimelineSubmission();
    resetPreviewState();
    const unsubscribe = controller.subscribe((event) => {
      if (disposed) return;

      switch (event.type) {
        case 'position': {
          const nextPositionMs = event.payload.positionMs;
          const nextRate = event.payload.rate > 0 ? event.payload.rate : 1;
          const syncAt = performance.now();
          const transportSampleState = event.payload.isPlaying ? 'playing' : 'paused';
          const storeIsPlaying = useTimelineStore.getState().isPlaying;
          const ignoreLatePlayingSample =
            transportSampleState === 'playing' &&
            nativeObservedTransportStateRef.current === 'paused' &&
            !storeIsPlaying;
          const ignoreConflictingTransportSample = shouldIgnoreConflictingTransportSample(
            transportSampleState,
            syncAt,
          );
          const ignorePendingTargetSample = shouldIgnorePlayingSample(nextPositionMs, syncAt);
          const ignorePlayingSample = event.payload.isPlaying && ignorePendingTargetSample;
          if (ignoreConflictingTransportSample || ignoreLatePlayingSample) {
            break;
          }
          nativeObservedTransportStateRef.current = transportSampleState;
          settlePendingTransportIntent(transportSampleState, nextPositionMs, syncAt);
          if (!ignorePendingTargetSample) {
            clearPendingNativeTargetIfSettled(nextPositionMs, syncAt);
            nativeBackendPositionRef.current = {
              positionMs: nextPositionMs,
              updatedAt: syncAt,
              rate: nextRate,
            };
            setPositionMs(nextPositionMs);
          }

          const timelineState = useTimelineStore.getState();
          if (!event.payload.isPlaying) {
            if (ignorePendingTargetSample) {
              break;
            }
            rebaseNativePlaybackClock(nextPositionMs, syncAt, nextRate);
            if (
              shouldSyncPausedPositionFromNative(
                nextPositionMs,
                controller,
              )
            ) {
              syncTimelinePlayheadFromNative(nextPositionMs, syncAt, true);
            }
          } else if (ignorePlayingSample) {
            break;
          } else if (
            shouldRebasePlayingClockToNative({
              nativePositionMs: nextPositionMs,
              currentPlayheadRefMs: timelineState.getPlayheadRef(),
              thresholdMs: NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS,
            })
          ) {
            rebaseNativePlaybackClock(nextPositionMs, syncAt, nextRate);
          } else {
            const currentRate = nativePlaybackClockRef.current.rate > 0 ? nativePlaybackClockRef.current.rate : 1;
            if (Math.abs(currentRate - nextRate) > 0.000_001) {
              rebaseNativePlaybackClock(
                projectNativePlaybackClockPosition(syncAt),
                syncAt,
                nextRate,
              );
            } else {
              nativePlaybackClockRef.current.rate = nextRate;
            }
          }
          break;
        }
        case 'state': {
          const syncAt = performance.now();
          const transportSampleState =
            event.payload.state === 'playing'
              ? 'playing'
              : event.payload.state === 'paused'
                ? 'paused'
                : null;
          const ignoreConflictingTransportSample =
            transportSampleState === null
              ? false
              : shouldIgnoreConflictingTransportSample(transportSampleState, syncAt);
          setSurfaceAttached(event.payload.nativeSurfaceAttached);
          setTimelineAttached(event.payload.timelineAttached);
          if (!ignoreConflictingTransportSample) {
            setState(event.payload.state);
            if (transportSampleState) {
              nativeObservedTransportStateRef.current = transportSampleState;
            } else {
              nativeObservedTransportStateRef.current = null;
            }
          }
          if (
            !event.payload.timelineAttached &&
            timelineSubmissionRef.current.controller === controller &&
            timelineSubmissionRef.current.sessionId === event.payload.sessionId
          ) {
            resetTimelineSubmission();
          }
          const nextRate = event.payload.rate > 0 ? event.payload.rate : 1;
          const ignorePendingTargetSample = shouldIgnorePlayingSample(event.payload.positionMs, syncAt);
          const ignorePlayingSample =
            event.payload.state === 'playing' &&
            ignorePendingTargetSample;
          if (ignoreConflictingTransportSample) {
            break;
          }
          if (!ignorePendingTargetSample) {
            setPositionMs(event.payload.positionMs);
            clearPendingNativeTargetIfSettled(event.payload.positionMs, syncAt);
            nativeBackendPositionRef.current = {
              positionMs: event.payload.positionMs,
              updatedAt: syncAt,
              rate: nextRate,
            };
          }
          if (transportSampleState) {
            settlePendingTransportIntent(
              transportSampleState,
              event.payload.positionMs,
              syncAt,
            );
          }
          {
            const timelineState = useTimelineStore.getState();
            if (event.payload.state === 'playing') {
              if (ignorePlayingSample) {
                break;
              }
              if (
                shouldRebasePlayingClockToNative({
                  nativePositionMs: event.payload.positionMs,
                  currentPlayheadRefMs: timelineState.getPlayheadRef(),
                  thresholdMs: NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS,
                })
              ) {
                rebaseNativePlaybackClock(
                  event.payload.positionMs,
                  syncAt,
                  nextRate,
                );
              } else {
                const currentRate = nativePlaybackClockRef.current.rate > 0 ? nativePlaybackClockRef.current.rate : 1;
                if (Math.abs(currentRate - nextRate) > 0.000_001) {
                  rebaseNativePlaybackClock(
                    projectNativePlaybackClockPosition(syncAt),
                    syncAt,
                    nextRate,
                  );
                } else {
                  nativePlaybackClockRef.current.rate = nextRate;
                }
              }
            } else {
              if (ignorePendingTargetSample) {
                break;
              }
              rebaseNativePlaybackClock(
                event.payload.positionMs,
                syncAt,
                nextRate,
              );
              if (
                shouldSyncPausedPositionFromNative(
                  event.payload.positionMs,
                  controller,
                )
              ) {
                syncTimelinePlayheadFromNative(event.payload.positionMs, syncAt, true);
              }
            }
            // `timelineStore.isPlaying` is the command source for native transport.
            // Mirroring transient backend `paused` states back into the store causes
            // seek->play races: a seek completion emits `paused`, the UI flips back
            // to paused, and immediately sends a conflicting pause command.
            if (
              event.payload.state === 'ended' ||
              event.payload.state === 'error' ||
              event.payload.state === 'destroyed'
            ) {
              pendingTransportIntentRef.current = null;
              if (timelineState.isPlaying) {
                timelineState.pause();
              }
            }
          }
          if (event.payload.state !== 'error') {
            setError(null);
          }
          refreshDiagnosticsRef.current?.('event');
          break;
        }
        case 'error':
          pendingTransportIntentRef.current = null;
          setError(event.payload.message);
          setState('error');
          refreshDiagnosticsRef.current?.('immediate');
          break;
        case 'metrics':
          refreshDiagnosticsRef.current?.('event');
          break;
        default:
          break;
      }
    });

    controllerRef.current = controller;
    surfaceSyncRevisionRef.current += 1;
    surfaceBootstrapTaskRef.current = 0;
    queuedSurfaceViewportRef.current = null;
    lastSurfaceViewportRef.current = null;
    lastRequestedSurfacePresentingRef.current = null;

    void (async () => {
      try {
        const session = await controller.create('main');
        if (disposed || !session) return;

        setSessionId(session.sessionId);
        applySessionState(session);

        refreshDiagnosticsRef.current?.('immediate');
      } catch (createError) {
        if (!disposed) {
          const message = getErrorMessage(createError);
          setError(message);
          setState('error');
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
      nativeStepFrameInFlightRef.current = false;
      nativeSeekQueueRef.current.inFlight = false;
      nativeSeekQueueRef.current.activeTargetMs = null;
      nativeSeekQueueRef.current.activeTargetGeneration = null;
      nativeSeekQueueRef.current.queuedTargetMs = null;
      nativeSeekQueueRef.current.queuedTargetGeneration = null;
      nativeSeekQueueRef.current.generation += 1;
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        surfaceSyncRevisionRef.current += 1;
        surfaceBootstrapTaskRef.current = 0;
        queuedSurfaceViewportRef.current = null;
        lastSurfaceViewportRef.current = null;
        lastRequestedSurfacePresentingRef.current = null;
      }
      if (timelineSubmissionRef.current.controller === controller) {
        resetTimelineSubmission();
      }
      const refreshState = diagnosticsRefreshStateRef.current;
      if (refreshState.timerId !== null) {
        window.clearTimeout(refreshState.timerId);
        refreshState.timerId = null;
      }
      refreshState.queued = false;
      void controller.destroy().catch((destroyError) => {
        console.warn('[NativeTimelinePreview] failed to destroy session:', destroyError);
      });
    };
  }, [
    active,
    clearPendingNativeTargetIfSettled,
    isCurrentController,
    projectId,
    settlePendingTransportIntent,
    shouldIgnoreConflictingTransportSample,
    shouldIgnorePlayingSample,
  ]);

  useEffect(() => {
    if (!active || !currentProject || !controllerRef.current) {
      return;
    }

    const controller = controllerRef.current;
    const controllerInfo = controller.info;
    const controllerSessionId = controllerInfo?.sessionId ?? null;
    if (!controllerSessionId) {
      return;
    }

    if (
      (controllerInfo?.nativeSurfaceSupported ?? true) &&
      !controllerInfo?.nativeSurfaceAttached
    ) {
      return;
    }

    let disposed = false;

    void (async () => {
      let snapshot: ReturnType<typeof buildTimelinePreviewSnapshot>;
      try {
        const project = await ensureProjectVideoSourceAudioMetadata({
          ...currentProject,
          tracks,
          fragments,
          scenes,
          assets,
        });

        if (disposed || !isCurrentController(controller)) {
          return;
        }

        snapshot = buildTimelinePreviewSnapshot({ project });
      } catch (timelineError) {
        if (disposed || !isCurrentController(controller)) {
          return;
        }
        const message = getErrorMessage(timelineError);
        setError(message);
        setState('error');
        setTimelineAttached(false);
        return;
      }

      const snapshotKey = createPreviewSnapshotKey(snapshot);
      if (
        timelineSubmissionRef.current.controller === controller &&
        timelineSubmissionRef.current.sessionId === controllerSessionId &&
        timelineSubmissionRef.current.key === snapshotKey
      ) {
        if (timelineSubmissionRef.current.status === 'in_flight') {
          if (
            queuedTimelineSubmissionRef.current?.controller === controller &&
            queuedTimelineSubmissionRef.current?.sessionId === controllerSessionId &&
            queuedTimelineSubmissionRef.current.key !== snapshotKey
          ) {
            queuedTimelineSubmissionRef.current = null;
          }
          return;
        }

        if (
          timelineSubmissionRef.current.status === 'applied' &&
          (controllerInfo?.timelineAttached ?? timelineAttached)
        ) {
          return;
        }
      }

      if (
        queuedTimelineSubmissionRef.current?.controller === controller &&
        queuedTimelineSubmissionRef.current?.sessionId === controllerSessionId &&
        queuedTimelineSubmissionRef.current?.key === snapshotKey
      ) {
        return;
      }

      submitTimelineSnapshot(controller, controllerSessionId, snapshotKey, snapshot);
    })();

    return () => {
      disposed = true;
    };
  }, [
    active,
    assets,
    currentProject,
    fragments,
    isCurrentController,
    sessionId,
    scenes,
    surfaceAttached,
    timelineAttached,
    tracks,
  ]);

  useEffect(() => {
    if (!active || !controllerRef.current || !timelineAttached) {
      return;
    }

    const controller = controllerRef.current;
    if (isPlaying) {
      const queuedTransportIntent = getPendingTransportIntent();
      const hasPendingPauseIntent = queuedTransportIntent?.desiredState === 'paused';
      nativeSeekQueueRef.current.generation += 1;
      nativeSeekQueueRef.current.queuedTargetMs = null;
      nativeSeekQueueRef.current.queuedTargetGeneration = null;
      const timelineState = useTimelineStore.getState();
      const targetPlayheadMs = timelineState.getPlayheadRef();
      const transportIntentGeneration = markPendingTransportIntent('playing', targetPlayheadMs);
      const seekQueue = nativeSeekQueueRef.current;
      const hasPendingSeekForTarget =
        (seekQueue.queuedTargetMs !== null &&
          Math.abs(seekQueue.queuedTargetMs - targetPlayheadMs) <= 0.5) ||
        (seekQueue.activeTargetMs !== null &&
          Math.abs(seekQueue.activeTargetMs - targetPlayheadMs) <= 0.5);
      const needsSeekBeforePlay =
        (seekQueue.inFlight && !hasPendingSeekForTarget) ||
        (seekQueue.queuedTargetMs !== null && !hasPendingSeekForTarget) ||
        Math.abs(
          targetPlayheadMs - nativeBackendPositionRef.current.positionMs,
        ) > NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS;

      if (
        state === 'playing' &&
        !needsSeekBeforePlay &&
        !hasPendingSeekForTarget &&
        !hasPendingPauseIntent
      ) {
        return;
      }

      if (needsSeekBeforePlay || hasPendingSeekForTarget) {
        const pendingTargetGeneration = markPendingNativeTarget(targetPlayheadMs);
        rebaseNativePlaybackClock(
          targetPlayheadMs,
          performance.now(),
          nativeBackendPositionRef.current.rate,
        );
        let didSendPlayFrom = false;
        void enqueueNativeTransportCommand(controller, async () => {
          if (!isPendingTransportIntentCurrent(transportIntentGeneration, 'playing')) {
            return;
          }
          didSendPlayFrom = true;
          await controller.playFrom(targetPlayheadMs);
        })
          .then(() => {
            if (
              !didSendPlayFrom ||
              !isCurrentController(controller) ||
              !isPendingTransportIntentCurrent(transportIntentGeneration, 'playing')
            ) {
              return;
            }
            const syncAt = performance.now();
            nativeBackendPositionRef.current = {
              positionMs: targetPlayheadMs,
              updatedAt: syncAt,
              rate: nativeBackendPositionRef.current.rate,
            };
            setPositionMs(targetPlayheadMs);
            if (isCurrentController(controller)) {
              refreshDiagnosticsRef.current?.('immediate');
            }
          })
          .catch((playError) => {
            clearPendingTransportIntentIfCurrent(transportIntentGeneration, 'playing');
            clearPendingNativeTargetIfCurrent(pendingTargetGeneration);
            if (isCurrentController(controller)) {
              const message = getErrorMessage(playError);
              setError(message);
            }
          });
        return;
      }

      void enqueueNativeTransportCommand(controller, async () => {
        if (!isPendingTransportIntentCurrent(transportIntentGeneration, 'playing')) {
          return;
        }
        await controller.play();
      })
        .then(() => {
          if (isCurrentController(controller)) {
            refreshDiagnosticsRef.current?.('immediate');
          }
        })
        .catch((playError) => {
          clearPendingTransportIntentIfCurrent(transportIntentGeneration, 'playing');
          if (isCurrentController(controller)) {
            const message = getErrorMessage(playError);
            setError(message);
          }
        });
      return;
    }

    const targetPlayheadMs = getPauseTransportTargetMs();
    const queuedTransportIntent = getPendingTransportIntent();
    const hasPendingPlayIntent = queuedTransportIntent?.desiredState === 'playing';
    const needsSeekBeforePause =
      Math.abs(targetPlayheadMs - nativeBackendPositionRef.current.positionMs) >
      NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS;
    if (
      state === 'paused' &&
      nativeObservedTransportStateRef.current !== 'playing' &&
      !hasPendingPlayIntent
    ) {
      return;
    }
    let pendingTargetGeneration: number | null = null;
    if (needsSeekBeforePause) {
      const requestedAt = performance.now();
      pendingTargetGeneration = markPendingNativeTarget(targetPlayheadMs, requestedAt);
      rebaseNativePlaybackClock(
        targetPlayheadMs,
        requestedAt,
        nativeBackendPositionRef.current.rate,
      );
    }
    const transportIntentGeneration = markPendingTransportIntent('paused', targetPlayheadMs);

    void enqueueNativeTransportCommand(controller, async () => {
      if (!isPendingTransportIntentCurrent(transportIntentGeneration, 'paused')) {
        return;
      }
      await controller.pause();
    })
      .then(() => {
        if (isCurrentController(controller)) {
          refreshDiagnosticsRef.current?.('immediate');
        }
      })
      .catch((pauseError) => {
        clearPendingTransportIntentIfCurrent(transportIntentGeneration, 'paused');
        if (pendingTargetGeneration !== null) {
          clearPendingNativeTargetIfCurrent(pendingTargetGeneration);
        }
        if (isCurrentController(controller)) {
          const message = getErrorMessage(pauseError);
          setError(message);
        }
      });
  }, [
    active,
    isCurrentController,
    getPendingTransportIntent,
    isPendingTransportIntentCurrent,
    isPlaying,
    getPauseTransportTargetMs,
    markPendingTransportIntent,
    markPendingNativeTarget,
    clearPendingNativeTargetIfCurrent,
    clearPendingTransportIntentIfCurrent,
    enqueueNativeTransportCommand,
    pumpNativeSeekQueue,
    timelineAttached,
  ]);

  useEffect(() => {
    if (!active || !transportControlled || state !== 'playing') {
      return;
    }

    let cancelled = false;
    let animationId = 0;
    let lastStoreSyncAt = 0;
    const nativeSyncIntervalMs = 100;
    const startAt = performance.now();

    rebaseNativePlaybackClock(
      nativeBackendPositionRef.current.positionMs,
      startAt,
      nativeBackendPositionRef.current.rate,
    );

    const animate = (frameTime: number) => {
      if (cancelled) return;

      const clock = nativePlaybackClockRef.current;
      const rate = clock.rate > 0 ? clock.rate : 1;
      let nextPositionMs = clock.basePositionMs + (frameTime - clock.baseUpdatedAt) * rate;
      const backendSync = nativeBackendPositionRef.current;
      const projectedBackendPositionMs = projectNativePlaybackPosition(backendSync, frameTime);
      const pendingTarget = pendingNativeTargetRef.current;
      const pendingTransportIntent = pendingTransportIntentRef.current;
      const shouldFreezePlayhead = shouldFreezePlayheadForPendingPause();
      const shouldIgnoreBackwardBackendClamp = shouldIgnoreBackwardNativePlayingClockRebase({
        nativePositionMs: projectedBackendPositionMs,
        currentPlayheadRefMs: nextPositionMs,
        pendingTargetMs: pendingTarget?.targetMs ?? null,
        pendingTargetRequestedAt: pendingTarget?.requestedAt ?? null,
        pendingTransportTargetMs: pendingTransportIntent?.targetMs ?? null,
        pendingTransportRequestedAt: pendingTransportIntent?.requestedAt ?? null,
        now: frameTime,
        thresholdMs: NATIVE_PLAYHEAD_RESYNC_THRESHOLD_MS,
        maxPendingMs: PENDING_NATIVE_TARGET_MAX_AGE_MS,
        maxPendingTransportIntentMs: PENDING_TRANSPORT_INTENT_MAX_AGE_MS,
      });

      // Native transport currently reports positions at ~10fps. During playback,
      // use those samples as a clock anchor, then advance locally at 60fps so the
      // timeline line does not inherit backend polling jitter or boundary jumps.
      // Compare against the sample projected to `frameTime`, otherwise a healthy
      // 10fps native pump looks one polling interval behind and drags the UI.
      // Keep this clamp backward-only: allowing RAF to chase forward samples
      // reintroduces snap/jitter around fragment boundaries.
      if (
        !shouldIgnoreBackwardBackendClamp &&
        backendSync.updatedAt > 0 &&
        projectedBackendPositionMs < nextPositionMs - 80
      ) {
        rebaseNativePlaybackClock(
          projectedBackendPositionMs,
          frameTime,
          backendSync.rate,
        );
        nextPositionMs = projectedBackendPositionMs;
      }

      nextPositionMs = Math.max(0, nextPositionMs);

      if (shouldFreezePlayhead) {
        animationId = window.requestAnimationFrame(animate);
        return;
      }

      const shouldSyncStore = frameTime - lastStoreSyncAt >= nativeSyncIntervalMs;
      syncTimelinePlayheadFromNative(nextPositionMs, frameTime, shouldSyncStore);
      if (shouldSyncStore) {
        lastStoreSyncAt = frameTime;
      }

      animationId = window.requestAnimationFrame(animate);
    };

    animationId = window.requestAnimationFrame(animate);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationId);
    };
  }, [active, shouldFreezePlayheadForPendingPause, state, transportControlled]);

  useEffect(() => {
    if (!active || !controllerRef.current || !timelineAttached) {
      nativeSeekQueueRef.current.inFlight = false;
      nativeSeekQueueRef.current.activeTargetMs = null;
      nativeSeekQueueRef.current.activeTargetGeneration = null;
      nativeSeekQueueRef.current.queuedTargetMs = null;
      nativeSeekQueueRef.current.queuedTargetGeneration = null;
      nativeSeekQueueRef.current.generation += 1;
      return;
    }

    if (
      state === 'playing' ||
      nativeObservedTransportStateRef.current === 'playing'
    ) {
      return;
    }

    if (isPlaying) {
      // During playback, timeline playhead updates are driven by the native
      // clock and timeline rebuild recovery. Treating those updates as manual
      // scrubs feeds back into redundant backend seeks while resizing clips.
      if (nativeSeekQueueRef.current.inFlight) {
        return;
      }
      nativeSeekQueueRef.current.queuedTargetMs = null;
      nativeSeekQueueRef.current.queuedTargetGeneration = null;
      return;
    }

    const targetPlayheadMs = getPauseTransportTargetMs();
    const recentNativeSync = nativePlayheadSyncRef.current;
    if (
      Math.abs(targetPlayheadMs - recentNativeSync.positionMs) <= 0.5 &&
      performance.now() - recentNativeSync.updatedAt < 250
    ) {
      return;
    }

    const seekQueue = nativeSeekQueueRef.current;
    const requestedAt = performance.now();
    const pendingTargetGeneration = markPendingNativeTarget(targetPlayheadMs, requestedAt);
    seekQueue.queuedTargetMs = targetPlayheadMs;
    seekQueue.queuedTargetGeneration = pendingTargetGeneration;
    rebaseNativePlaybackClock(
      targetPlayheadMs,
      requestedAt,
      nativeBackendPositionRef.current.rate,
    );

    if (seekQueue.inFlight) {
      return;
    }

    void pumpNativeSeekQueue(controllerRef.current);
  }, [
    active,
    getPauseTransportTargetMs,
    isPlaying,
    markPendingNativeTarget,
    playhead,
    pumpNativeSeekQueue,
    state,
    timelineAttached,
  ]);

  useEffect(() => {
    if (!active) {
      nativeStepFrameInFlightRef.current = false;
      return;
    }

    return registerNativePreviewStepFrameHandler((direction) => {
      const controller = controllerRef.current;
      if (!controller || !timelineAttached || isPlaying || nativeStepFrameInFlightRef.current) {
        return false;
      }

      nativeStepFrameInFlightRef.current = true;
      void controller
        .stepFrame(direction)
        .then(() => {
          if (isCurrentController(controller)) {
            refreshDiagnosticsRef.current?.('immediate');
          }
        })
        .catch((stepError) => {
          if (isCurrentController(controller)) {
            const message = getErrorMessage(stepError);
            setError(message);
          }
        })
        .finally(() => {
          nativeStepFrameInFlightRef.current = false;
        });
      return true;
    });
  }, [active, isCurrentController, isPlaying, timelineAttached]);

  useEffect(() => {
    if (!active || !controllerRef.current) {
      return;
    }

    const host = containerRef.current;
    if (!host) return;

    let frameId = 0;

    const syncViewport = () => {
      frameId = 0;
      if (!controllerRef.current || !containerRef.current) {
        return;
      }
      const nextViewport = readViewport(containerRef.current);
      if (surfaceBootstrapTaskRef.current !== 0) {
        queuedSurfaceViewportRef.current = nextViewport;
        return;
      }
      if (
        lastSurfaceViewportRef.current &&
        areViewportsEqual(lastSurfaceViewportRef.current, nextViewport)
      ) {
        return;
      }
      const controller = controllerRef.current;
      const surfaceSyncRevision = surfaceSyncRevisionRef.current;
      void controller
        .setViewport(nextViewport, surfaceSyncRevision)
        .then(() => {
          if (
            isCurrentController(controller) &&
            surfaceSyncRevisionRef.current === surfaceSyncRevision
          ) {
            lastSurfaceViewportRef.current = nextViewport;
          }
        })
        .catch((viewportError) => {
          if (isCurrentController(controller)) {
            const message = getErrorMessage(viewportError);
            setError(message);
          }
        });
    };

    const scheduleViewportSync = () => {
      if (frameId !== 0) return;
      frameId = window.requestAnimationFrame(syncViewport);
    };

    const resizeObserver = new ResizeObserver(scheduleViewportSync);
    resizeObserver.observe(host);
    window.addEventListener('resize', scheduleViewportSync);
    window.addEventListener('scroll', scheduleViewportSync, true);
    scheduleViewportSync();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleViewportSync);
      window.removeEventListener('scroll', scheduleViewportSync, true);
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [active, containerRef, isCurrentController]);

  useLayoutEffect(() => {
    return subscribeNativePreviewOcclusion((snapshot) => {
      setSurfaceOccluded(snapshot.active);
    });
  }, []);

  useLayoutEffect(() => {
    if (!active || !sessionId || !controllerRef.current) {
      return;
    }

    const controller = controllerRef.current;
    const host = containerRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    const surfaceSyncRevision = surfaceSyncRevisionRef.current + 1;
    surfaceSyncRevisionRef.current = surfaceSyncRevision;

    const isTaskCurrent = () =>
      !disposed &&
      isCurrentController(controller) &&
      surfaceSyncRevisionRef.current === surfaceSyncRevision;

    const flushSurfaceViewportBeforePresent = async (
      initialViewport: PreviewViewport,
    ): Promise<boolean> => {
      surfaceBootstrapTaskRef.current = surfaceSyncRevision;
      let nextViewport = queuedSurfaceViewportRef.current ?? initialViewport;
      queuedSurfaceViewportRef.current = null;

      while (
        !lastSurfaceViewportRef.current ||
        !areViewportsEqual(nextViewport, lastSurfaceViewportRef.current)
      ) {
        await controller.setViewport(nextViewport, surfaceSyncRevision);
        if (!isTaskCurrent()) {
          return false;
        }

        lastSurfaceViewportRef.current = nextViewport;
        const queuedViewport = queuedSurfaceViewportRef.current;
        queuedSurfaceViewportRef.current = null;
        if (!queuedViewport) {
          break;
        }
        nextViewport = queuedViewport;
      }

      if (surfaceBootstrapTaskRef.current === surfaceSyncRevision) {
        surfaceBootstrapTaskRef.current = 0;
      }

      return true;
    };

    void (async () => {
      try {
        const attached = controller.info?.nativeSurfaceAttached ?? surfaceAttached;
        if (!attached) {
          surfaceBootstrapTaskRef.current = surfaceSyncRevision;
          queuedSurfaceViewportRef.current = null;
          const bootstrapViewport = readViewport(host);
          lastSurfaceViewportRef.current = bootstrapViewport;
          const attachedSession = await controller.attachSurface(ensureSurfaceId(host), {
            viewport: bootstrapViewport,
            surfaceSyncRevision,
          });
          if (!isTaskCurrent()) {
            return;
          }

          if (attachedSession) {
            applySessionState(attachedSession);
          }

          if (!(await flushSurfaceViewportBeforePresent(readViewport(host)))) {
            return;
          }

          lastRequestedSurfacePresentingRef.current = false;
          const nextDesiredPresenting = shouldPresentSurfaceRef.current;
          if (nextDesiredPresenting) {
            lastRequestedSurfacePresentingRef.current = true;
            await controller.setSurfacePresenting(true, surfaceSyncRevision);
            if (!isTaskCurrent()) {
              return;
            }
          }
          refreshDiagnosticsRef.current?.('immediate');
          return;
        }

        if (lastRequestedSurfacePresentingRef.current === shouldPresentSurface) {
          return;
        }

        if (shouldPresentSurface) {
          if (!(await flushSurfaceViewportBeforePresent(readViewport(host)))) {
            return;
          }
        }

        lastRequestedSurfacePresentingRef.current = shouldPresentSurface;
        await controller.setSurfacePresenting(shouldPresentSurface, surfaceSyncRevision);
        if (!isTaskCurrent()) {
          return;
        }

        refreshDiagnosticsRef.current?.('immediate');
      } catch (surfaceError) {
        if (isTaskCurrent()) {
          const message = getErrorMessage(surfaceError);
          setError(message);
        }
      } finally {
        if (surfaceBootstrapTaskRef.current === surfaceSyncRevision) {
          surfaceBootstrapTaskRef.current = 0;
        }
      }
    })();

    return () => {
      disposed = true;
      if (surfaceBootstrapTaskRef.current === surfaceSyncRevision) {
        surfaceBootstrapTaskRef.current = 0;
      }
    };
  }, [active, containerRef, isCurrentController, sessionId, shouldPresentSurface]);

  return {
    active,
    sessionId,
    state,
    surfaceAttached,
    timelineAttached,
    positionMs,
    transportControlled,
    diagnostics,
    error,
  };
}
