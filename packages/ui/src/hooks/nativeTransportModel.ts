export type NativeTransportPhase = 'idle' | 'paused' | 'playing' | 'ended' | 'error';

export interface NativeTransportModel {
  phase: NativeTransportPhase;
  /** Authoritative position anchor. */
  anchorMs: number;
  /** performance.now() timestamp the anchor was captured at. */
  anchorAt: number;
  rate: number;
  /**
   * Set by a local intent; the next backend sample re-anchors the playing clock
   * even within the drift threshold, so the optimistic anchor is corrected to the
   * backend once (covers macOS playFrom->preroll lag).
   */
  pendingAnchorSample: boolean;
}

// While playing, backend position samples within this drift are treated as noise
// and do not re-anchor the projection clock (D3D11/GES clip-boundary queries can
// oscillate); only larger divergence re-anchors.
const PLAYING_REANCHOR_THRESHOLD_MS = 250;

export type NativeTransportIntent =
  | { type: 'seek'; targetMs: number }
  | { type: 'play'; targetMs: number }
  | { type: 'pause'; targetMs: number }
  | { type: 'rate'; rate: number };

export interface NativeBackendSample {
  positionMs: number;
  /** Omitted for position-only samples (e.g. frame timestamps) that must not change phase. */
  phase?: NativeTransportPhase;
  /** Omitted when the sample carries no rate; the current rate is kept. */
  rate?: number;
}

function normalizeRate(rate: number | undefined, fallback: number): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

function normalizePositionMs(positionMs: number): number {
  return Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
}

export function createNativeTransportModel(now = performance.now()): NativeTransportModel {
  return { phase: 'idle', anchorMs: 0, anchorAt: now, rate: 1, pendingAnchorSample: false };
}

/** Apply a locally-issued transport intent as an optimistic update. */
export function applyIntent(
  model: NativeTransportModel,
  intent: NativeTransportIntent,
  now: number,
): NativeTransportModel {
  switch (intent.type) {
    case 'seek':
      // Re-anchor to the seek target while preserving the current phase.
      return {
        ...model,
        anchorMs: normalizePositionMs(intent.targetMs),
        anchorAt: now,
        pendingAnchorSample: true,
      };
    case 'play':
      return {
        phase: 'playing',
        anchorMs: normalizePositionMs(intent.targetMs),
        anchorAt: now,
        rate: model.rate,
        pendingAnchorSample: true,
      };
    case 'pause':
      return {
        phase: 'paused',
        anchorMs: normalizePositionMs(intent.targetMs),
        anchorAt: now,
        rate: model.rate,
        pendingAnchorSample: true,
      };
    case 'rate': {
      const rate = normalizeRate(intent.rate, model.rate);
      // Re-anchor at the current projection so the position stays continuous.
      return {
        ...model,
        anchorMs: projectPositionMs(model, now),
        anchorAt: now,
        rate,
        pendingAnchorSample: true,
      };
    }
    default:
      return model;
  }
}

/**
 * Apply an epoch-fresh backend event to the model. While playing, position
 * samples are drift corrections rather than absolute re-anchors: re-anchor only
 * on a phase or rate change, on the first sample after a local intent, or when
 * the drift exceeds the threshold. Position-only samples (frame timestamps) never
 * re-anchor the playing clock. Non-playing samples always re-anchor.
 */
export function applyBackendSample(
  model: NativeTransportModel,
  sample: NativeBackendSample,
  now: number,
): NativeTransportModel {
  const nextPhase = sample.phase ?? model.phase;
  const nextRate = normalizeRate(sample.rate, model.rate);
  const nextPositionMs = normalizePositionMs(sample.positionMs);

  if (model.phase === 'playing' && nextPhase === 'playing') {
    if (nextRate !== model.rate) {
      return {
        phase: 'playing',
        anchorMs: projectPositionMs(model, now),
        anchorAt: now,
        rate: nextRate,
        pendingAnchorSample: false,
      };
    }
    if (sample.phase === undefined) {
      // Frame-timestamp / position-only sample: keep the local clock intact.
      return model;
    }
    if (!model.pendingAnchorSample) {
      const drift = nextPositionMs - projectPositionMs(model, now);
      if (Math.abs(drift) <= PLAYING_REANCHOR_THRESHOLD_MS) {
        return model;
      }
    }
    return {
      phase: 'playing',
      anchorMs: nextPositionMs,
      anchorAt: now,
      rate: nextRate,
      pendingAnchorSample: false,
    };
  }

  return {
    phase: nextPhase,
    anchorMs: nextPositionMs,
    anchorAt: now,
    rate: nextRate,
    pendingAnchorSample: false,
  };
}

export function projectPositionMs(model: NativeTransportModel, now: number): number {
  const rate = model.rate > 0 ? model.rate : 1;
  const elapsedMs = model.phase === 'playing' ? Math.max(0, now - model.anchorAt) * rate : 0;
  return Math.max(0, model.anchorMs + elapsedMs);
}

export interface PausedPositionAdoption {
  backendMs: number;
  playheadMs: number;
  playheadRefMs: number;
  timelineDurationMs: number;
  timelineReady: boolean;
  timelineAttached: boolean;
  toleranceMs: number;
}

/**
 * Decide whether an epoch-fresh paused backend position is "settled" and should
 * be written to the playhead store. A settled position either confirms the
 * editor playhead or clamps it into the current timeline bounds; positions that
 * do neither are the backend still catching up to the editor's intent and are
 * left for the seek path to reconcile. (Epoch filtering removes stale samples
 * upstream; this only resolves editor-vs-backend authority.)
 */
export function shouldAdoptPausedPosition({
  backendMs,
  playheadMs,
  playheadRefMs,
  timelineDurationMs,
  timelineReady,
  timelineAttached,
  toleranceMs,
}: PausedPositionAdoption): boolean {
  if (!timelineReady) {
    return false;
  }

  const maxTimelineMs = Math.max(0, timelineDurationMs);
  const clampToTimeline = (positionMs: number) => Math.min(Math.max(0, positionMs), maxTimelineMs);

  const clampedBackendMs = clampToTimeline(backendMs);
  const playhead = Math.max(0, playheadMs);
  const playheadRef = Math.max(0, playheadRefMs);

  if (
    Math.abs(playhead - clampedBackendMs) <= toleranceMs &&
    Math.abs(playheadRef - clampedBackendMs) <= toleranceMs
  ) {
    return true;
  }

  if (!timelineAttached) {
    return false;
  }

  return (
    Math.abs(clampToTimeline(playhead) - clampedBackendMs) <= toleranceMs &&
    Math.abs(clampToTimeline(playheadRef) - clampedBackendMs) <= toleranceMs
  );
}
