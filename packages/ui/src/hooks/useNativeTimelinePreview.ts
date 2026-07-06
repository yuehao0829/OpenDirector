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
  applyBackendSample,
  applyIntent,
  createNativeTransportModel,
  projectPositionMs,
  shouldAdoptPausedPosition,
  type NativeTransportModel,
  type NativeTransportPhase,
} from './nativeTransportModel';

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
// Positions this hook itself wrote to the store (rAF playback clock, backend
// paused sync) echo back through the playhead; they must not feed a redundant
// transport command.
const PLAYHEAD_ECHO_EPSILON_MS = 0.5;
// Tolerance for treating a paused backend position as confirming/clamping the
// editor playhead (absorbs seek landing accuracy), see shouldAdoptPausedPosition.
const PAUSED_POSITION_MATCH_TOLERANCE_MS = 250;

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

function phaseFromState(state: PreviewSessionState): NativeTransportPhase {
  switch (state) {
    case 'playing':
      return 'playing';
    case 'ended':
      return 'ended';
    case 'error':
      return 'error';
    case 'idle':
    case 'destroyed':
      return 'idle';
    default:
      return 'paused';
  }
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

  const nativeStepFrameInFlightRef = useRef(false);
  // Latest-target-wins seek coalescing with a single in-flight invoke. Ordering
  // safety comes from the transport epoch + backend stale-command drop.
  const nativeSeekQueueRef = useRef<{
    inFlight: boolean;
    queuedTargetMs: number | null;
  }>({
    inFlight: false,
    queuedTargetMs: null,
  });
  const nativeTransportCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Tail of the position-bearing command chain (seek, stepFrame). Also read as
  // "a non-subsuming position command is in flight" so a concurrent pause waits
  // for it — a raced pause+seek must never reach the backend out of epoch order.
  const nativePositionCommandInFlightRef = useRef<Promise<void>>(Promise.resolve());
  // The single source of position/phase truth on the frontend. The rAF loop
  // projects from it; every epoch-fresh backend event and local intent updates it.
  const transportModelRef = useRef<NativeTransportModel>(createNativeTransportModel());
  // Last playhead position this hook wrote to the store; used to reject echoes.
  // null = this hook has not written yet, so it owns nothing and must neither
  // suppress a seek as an echo nor block a paused adoption.
  const lastAppliedPlayheadRef = useRef<number | null>(null);

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

  const isCurrentController = useCallback(
    (controller: PreviewSessionController | null): boolean =>
      controller !== null && controllerRef.current === controller,
    [],
  );

  // A stale controller's failure must not clobber the current controller's error state.
  const reportControllerError = useCallback(
    (controller: PreviewSessionController | null, controllerError: unknown) => {
      if (isCurrentController(controller)) {
        setError(getErrorMessage(controllerError));
      }
    },
    [isCurrentController],
  );

  const resetPreviewState = () => {
    setSessionId(null);
    setState('idle');
    setSurfaceAttached(false);
    setTimelineAttached(false);
    setPositionMs(0);
    setDiagnostics(null);
    setError(null);
    transportModelRef.current = createNativeTransportModel();
    lastAppliedPlayheadRef.current = null;
    nativeTransportCommandQueueRef.current = Promise.resolve();
    nativePositionCommandInFlightRef.current = Promise.resolve();
    nativeSeekQueueRef.current.inFlight = false;
    nativeSeekQueueRef.current.queuedTargetMs = null;
  };

  const resetTimelineSubmission = useCallback(() => {
    timelineSubmissionRef.current = createIdleTimelineSubmissionState();
    queuedTimelineSubmissionRef.current = null;
  }, []);

  const applySessionState = (nextSession: {
    state: PreviewSessionState;
    nativeSurfaceAttached: boolean;
    timelineAttached: boolean;
  }) => {
    setState(nextSession.state);
    setSurfaceAttached(nextSession.nativeSurfaceAttached);
    setTimelineAttached(nextSession.timelineAttached);
  };

  const updateTimelineSubmission = useCallback((
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
  }, []);

  const submitTimelineSnapshot = useCallback((
    controller: PreviewSessionController,
    controllerSessionId: string,
    snapshotKey: string,
    snapshot: ReturnType<typeof buildTimelinePreviewSnapshot>,
  ) => {
    const runSubmission = (
      nextController: PreviewSessionController,
      nextControllerSessionId: string,
      nextSnapshotKey: string,
      nextSnapshot: ReturnType<typeof buildTimelinePreviewSnapshot>,
    ) => {
      const currentSubmission = timelineSubmissionRef.current;
      if (
        currentSubmission.controller === nextController &&
        currentSubmission.sessionId === nextControllerSessionId &&
        currentSubmission.status === 'in_flight'
      ) {
        queuedTimelineSubmissionRef.current = {
          controller: nextController,
          sessionId: nextControllerSessionId,
          key: nextSnapshotKey,
          snapshot: nextSnapshot,
        };
        return;
      }

      updateTimelineSubmission(
        nextController,
        nextControllerSessionId,
        nextSnapshotKey,
        'in_flight',
      );

      void nextController
        .setTimeline(nextSnapshot)
        .then(() => {
          if (
            timelineSubmissionRef.current.controller === nextController &&
            timelineSubmissionRef.current.sessionId === nextControllerSessionId &&
            timelineSubmissionRef.current.key === nextSnapshotKey
          ) {
            updateTimelineSubmission(
              nextController,
              nextControllerSessionId,
              nextSnapshotKey,
              'applied',
            );
          }
          if (isCurrentController(nextController)) {
            refreshDiagnosticsRef.current?.('immediate');
          }
        })
        .catch((timelineError) => {
          if (
            timelineSubmissionRef.current.controller === nextController &&
            timelineSubmissionRef.current.sessionId === nextControllerSessionId &&
            timelineSubmissionRef.current.key === nextSnapshotKey
          ) {
            resetTimelineSubmission();
          }
          if (!isCurrentController(nextController)) {
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
            queuedSubmission.controller === nextController &&
            queuedSubmission.sessionId === nextControllerSessionId &&
            isCurrentController(nextController)
          ) {
            queuedTimelineSubmissionRef.current = null;
            runSubmission(
              queuedSubmission.controller,
              queuedSubmission.sessionId,
              queuedSubmission.key,
              queuedSubmission.snapshot,
            );
          }
        });
    };

    runSubmission(controller, controllerSessionId, snapshotKey, snapshot);
  }, [isCurrentController, resetTimelineSubmission, updateTimelineSubmission]);

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

  // Serialize a position-bearing command (seek, stepFrame) behind any pending
  // state command and any earlier position command, exposing it via
  // nativePositionCommandInFlightRef so a concurrent pause waits for it. This
  // gives every pair of mutually-non-subsuming transport invokes a total order on
  // the backend session; playFrom is exempt (it subsumes an in-flight seek), so a
  // scrub-then-play stays responsive.
  //
  // The transport tail is snapshotted at enqueue time, not read when the prior
  // position command settles: every command may only wait on commands enqueued
  // strictly before it, keeping the two-chain wait graph acyclic (a lazy read
  // deadlocks with a pause that awaits this position tail).
  const runNativePositionCommand = useCallback(
    (controller: PreviewSessionController, command: () => Promise<void>): Promise<void> => {
      const transportTail = nativeTransportCommandQueueRef.current.catch(() => {});
      const run = nativePositionCommandInFlightRef.current
        .catch(() => {})
        .then(() => transportTail)
        .then(() => {
          if (!isCurrentController(controller)) {
            return;
          }
          return command();
        });
      nativePositionCommandInFlightRef.current = run.catch(() => {});
      return run;
    },
    [isCurrentController],
  );

  // I4: play is always position-bearing. Read the playhead ref at dispatch time
  // (not effect time) so a play queued behind a stalled command can never
  // resurrect a stale target, then re-anchor the model to what was actually sent.
  const dispatchNativePlayFrom = useCallback(
    (controller: PreviewSessionController) => {
      nativeSeekQueueRef.current.queuedTargetMs = null;
      void enqueueNativeTransportCommand(controller, () => {
        const targetMs = Math.max(0, useTimelineStore.getState().getPlayheadRef());
        lastAppliedPlayheadRef.current = targetMs;
        transportModelRef.current = applyIntent(
          transportModelRef.current,
          { type: 'play', targetMs },
          performance.now(),
        );
        return controller.playFrom(targetMs).then(() => {
          if (isCurrentController(controller)) {
            setPositionMs(targetMs);
            refreshDiagnosticsRef.current?.('immediate');
          }
        });
      }).catch((playError) => {
        reportControllerError(controller, playError);
      });
    },
    [enqueueNativeTransportCommand, reportControllerError],
  );

  // Write a native-derived position into the playhead store, mirroring where the
  // old code did (setPlayhead only when the low-frequency display value has
  // drifted; otherwise the ref-only fast path). Records the value as an echo.
  //
  // Ownership guard: if the store's playhead ref no longer matches what this hook
  // last wrote, a foreign (user) write is pending and owns the playhead — leave it
  // untouched so the pending seek/play effect can turn it into a transport
  // command. A null lastApplied means the hook has not written yet and owns
  // nothing to defend, so the write (e.g. initial paused adoption) proceeds.
  const writePlayheadFromNative = (positionMs: number, syncStore: boolean) => {
    const timelineState = useTimelineStore.getState();
    const lastAppliedMs = lastAppliedPlayheadRef.current;
    if (
      lastAppliedMs !== null &&
      Math.abs(timelineState.getPlayheadRef() - lastAppliedMs) > PLAYHEAD_ECHO_EPSILON_MS
    ) {
      return;
    }

    const clampedPositionMs = Math.max(0, positionMs);
    lastAppliedPlayheadRef.current = clampedPositionMs;

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

  const shouldAdoptPausedPositionFromNative = (
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
    return shouldAdoptPausedPosition({
      backendMs: positionMs,
      playheadMs: timelineState.playhead,
      playheadRefMs: timelineState.getPlayheadRef(),
      timelineDurationMs: timelineState.duration,
      timelineReady: controllerTimelineAttached || hasSubmittedTimeline,
      timelineAttached: controllerTimelineAttached,
      toleranceMs: PAUSED_POSITION_MATCH_TOLERANCE_MS,
    });
  };

  // Fold an epoch-fresh backend event into the transport model. Playing samples
  // only re-anchor the model (the rAF loop owns the store); paused/idle/ended
  // samples that are "settled" are written straight to the playhead store.
  const ingestBackendSample = (
    controller: PreviewSessionController,
    positionMs: number,
    phase: NativeTransportPhase | undefined,
    rate: number | undefined,
    now: number,
  ) => {
    transportModelRef.current = applyBackendSample(
      transportModelRef.current,
      { positionMs, phase, rate },
      now,
    );
    setPositionMs(Math.max(0, positionMs));

    if (transportModelRef.current.phase === 'playing') {
      return;
    }
    if (shouldAdoptPausedPositionFromNative(positionMs, controller)) {
      writePlayheadFromNative(positionMs, true);
    }
  };

  const pumpNativeSeekQueue = useCallback((controller: PreviewSessionController) => {
    const seekQueue = nativeSeekQueueRef.current;
    if (seekQueue.inFlight || seekQueue.queuedTargetMs === null) {
      return;
    }

    seekQueue.inFlight = true;
    void runNativePositionCommand(controller, async () => {
      // Coalesce to the latest queued target at execution time (latest-wins).
      const nextTargetMs = seekQueue.queuedTargetMs;
      seekQueue.queuedTargetMs = null;
      if (
        nextTargetMs === null ||
        !isCurrentController(controller) ||
        !timelineAttached ||
        useTimelineStore.getState().isPlaying
      ) {
        return;
      }

      try {
        await controller.seek(nextTargetMs);
        if (!isCurrentController(controller)) {
          return;
        }
        setPositionMs(nextTargetMs);
        refreshDiagnosticsRef.current?.('immediate');
      } catch (seekError) {
        reportControllerError(controller, seekError);
      }
    }).finally(() => {
      seekQueue.inFlight = false;
      if (isCurrentController(controller) && seekQueue.queuedTargetMs !== null) {
        pumpNativeSeekQueue(controller);
      }
    });
  }, [isCurrentController, runNativePositionCommand, timelineAttached]);

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
          reportControllerError(activeController, diagnosticsError);
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
      nativeSeekQueueRef.current.queuedTargetMs = null;
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
    const nativeSeekQueue = nativeSeekQueueRef.current;
    const refreshState = diagnosticsRefreshStateRef.current;
    resetTimelineSubmission();
    resetPreviewState();
    const unsubscribe = controller.subscribe((event) => {
      if (disposed) return;

      switch (event.type) {
        case 'position': {
          const now = performance.now();
          const phase: NativeTransportPhase = event.payload.isPlaying ? 'playing' : 'paused';
          ingestBackendSample(controller, event.payload.positionMs, phase, event.payload.rate, now);
          break;
        }
        case 'state': {
          const now = performance.now();
          setSurfaceAttached(event.payload.nativeSurfaceAttached);
          setTimelineAttached(event.payload.timelineAttached);
          setState(event.payload.state);
          // A transient detach must not clear a submission the setTimeline promise
          // still owns; its own .then/.catch resolves that lifecycle.
          if (
            !event.payload.timelineAttached &&
            timelineSubmissionRef.current.controller === controller &&
            timelineSubmissionRef.current.sessionId === event.payload.sessionId &&
            timelineSubmissionRef.current.status !== 'in_flight'
          ) {
            resetTimelineSubmission();
          }

          ingestBackendSample(
            controller,
            event.payload.positionMs,
            phaseFromState(event.payload.state),
            event.payload.rate,
            now,
          );

          // `timelineStore.isPlaying` is the command source for native transport,
          // so only terminal states pull it back to paused.
          if (
            event.payload.state === 'ended' ||
            event.payload.state === 'error' ||
            event.payload.state === 'destroyed'
          ) {
            const timelineState = useTimelineStore.getState();
            if (timelineState.isPlaying) {
              timelineState.pause();
            }
          }
          if (event.payload.state !== 'error') {
            setError(null);
          }
          refreshDiagnosticsRef.current?.('event');
          break;
        }
        case 'error':
          setError(event.payload.message);
          setState('error');
          refreshDiagnosticsRef.current?.('immediate');
          break;
        case 'metrics':
          refreshDiagnosticsRef.current?.('event');
          break;
        case 'frameTimestamp': {
          const now = performance.now();
          ingestBackendSample(controller, event.payload.positionMs, undefined, undefined, now);
          break;
        }
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
      nativeSeekQueue.inFlight = false;
      nativeSeekQueue.queuedTargetMs = null;
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
    isCurrentController,
    projectId,
    resetTimelineSubmission,
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
    submitTimelineSnapshot,
    surfaceAttached,
    timelineAttached,
    tracks,
  ]);

  useEffect(() => {
    if (!active || !controllerRef.current || !timelineAttached) {
      return;
    }

    const controller = controllerRef.current;
    const now = performance.now();

    if (isPlaying) {
      // Optimistic phase so a racing pause still fires; dispatch re-reads the
      // playhead so the actual playFrom target is never stale.
      const targetMs = Math.max(0, useTimelineStore.getState().getPlayheadRef());
      transportModelRef.current = applyIntent(
        transportModelRef.current,
        { type: 'play', targetMs },
        now,
      );
      lastAppliedPlayheadRef.current = targetMs;
      dispatchNativePlayFrom(controller);
      return;
    }

    // Nothing to stop unless we believe playback is running — avoids emitting a
    // redundant pause on initial timeline attach. The seek effect handles the
    // pause-time playhead reconciliation (it deliberately does not record an echo).
    if (transportModelRef.current.phase !== 'playing') {
      return;
    }

    const targetMs = Math.max(0, useTimelineStore.getState().getPlayheadRef());
    transportModelRef.current = applyIntent(
      transportModelRef.current,
      { type: 'pause', targetMs },
      now,
    );
    // Order behind any in-flight seek/stepFrame (captured now, before the seek
    // effect can enqueue one) so a raced pause+seek reaches the backend in epoch
    // order rather than concurrently.
    const positionCommandInFlight = nativePositionCommandInFlightRef.current;
    void enqueueNativeTransportCommand(controller, async () => {
      await positionCommandInFlight.catch(() => {});
      await controller.pause();
    })
      .then(() => {
        if (isCurrentController(controller)) {
          refreshDiagnosticsRef.current?.('immediate');
        }
      })
      .catch((pauseError) => {
        reportControllerError(controller, pauseError);
      });
  }, [
    active,
    dispatchNativePlayFrom,
    enqueueNativeTransportCommand,
    isCurrentController,
    isPlaying,
    timelineAttached,
  ]);

  useEffect(() => {
    if (!active || !transportControlled || state !== 'playing') {
      return;
    }

    let cancelled = false;
    let animationId = 0;
    let lastStoreSyncAt = 0;
    const storeSyncIntervalMs = 100;

    const animate = (frameTime: number) => {
      if (cancelled) return;

      // Only project while the model itself is playing. A pause/seek intent (or an
      // ingested pause sample) re-anchors the model before this effect is torn down,
      // and a straggler frame must not write that anchor into the store — paused
      // positions may only enter through the tolerance-gated adoption path.
      if (transportModelRef.current.phase === 'playing') {
        const projectedMs = projectPositionMs(transportModelRef.current, frameTime);
        const shouldSyncStore = frameTime - lastStoreSyncAt >= storeSyncIntervalMs;
        writePlayheadFromNative(projectedMs, shouldSyncStore);
        if (shouldSyncStore) {
          lastStoreSyncAt = frameTime;
        }
      }

      animationId = window.requestAnimationFrame(animate);
    };

    animationId = window.requestAnimationFrame(animate);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationId);
    };
  }, [active, state, transportControlled]);

  useEffect(() => {
    if (!active || !controllerRef.current || !timelineAttached) {
      nativeSeekQueueRef.current.inFlight = false;
      nativeSeekQueueRef.current.queuedTargetMs = null;
      return;
    }

    const controller = controllerRef.current;
    const targetMs = Math.max(0, useTimelineStore.getState().getPlayheadRef());

    // Reject echoes of positions this hook wrote to the store (rAF playback
    // clock, backend paused sync); only genuine scrubs reach the backend.
    const lastAppliedMs = lastAppliedPlayheadRef.current;
    if (lastAppliedMs !== null && Math.abs(targetMs - lastAppliedMs) <= PLAYHEAD_ECHO_EPSILON_MS) {
      return;
    }

    const now = performance.now();
    if (useTimelineStore.getState().isPlaying) {
      // Seamless seek during playback: re-issue playFrom at the scrubbed target.
      transportModelRef.current = applyIntent(
        transportModelRef.current,
        { type: 'play', targetMs },
        now,
      );
      lastAppliedPlayheadRef.current = targetMs;
      dispatchNativePlayFrom(controller);
      return;
    }

    transportModelRef.current = applyIntent(
      transportModelRef.current,
      { type: 'seek', targetMs },
      now,
    );
    lastAppliedPlayheadRef.current = targetMs;
    nativeSeekQueueRef.current.queuedTargetMs = targetMs;
    pumpNativeSeekQueue(controller);
  }, [
    active,
    dispatchNativePlayFrom,
    isPlaying,
    playhead,
    pumpNativeSeekQueue,
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
      void runNativePositionCommand(controller, () =>
        controller.stepFrame(direction).then(() => {
          if (isCurrentController(controller)) {
            refreshDiagnosticsRef.current?.('immediate');
          }
        }),
      )
        .catch((stepError) => {
          reportControllerError(controller, stepError);
        })
        .finally(() => {
          nativeStepFrameInFlightRef.current = false;
        });
      return true;
    });
  }, [active, isCurrentController, isPlaying, runNativePositionCommand, timelineAttached]);

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
          reportControllerError(controller, viewportError);
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
  }, [active, containerRef, isCurrentController, sessionId, shouldPresentSurface, surfaceAttached]);

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
