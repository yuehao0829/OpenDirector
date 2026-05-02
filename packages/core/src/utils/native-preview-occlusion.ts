const WINDOW_STATE_KEY = '__OPENDIRECTOR_NATIVE_PREVIEW_OCCLUSION_STATE__';
const CHANGE_EVENT_NAME = 'opendirector:native-preview-occlusion-change';

type NativePreviewOcclusionWindow = Window & {
  [WINDOW_STATE_KEY]?: NativePreviewOcclusionState;
};

interface NativePreviewOcclusionState {
  blockers: Record<string, number>;
}

export interface NativePreviewOcclusionSnapshot {
  active: boolean;
  reasons: string[];
}

function resolveWindow(): NativePreviewOcclusionWindow | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window as NativePreviewOcclusionWindow;
}

function getState(targetWindow: NativePreviewOcclusionWindow): NativePreviewOcclusionState {
  if (!targetWindow[WINDOW_STATE_KEY]) {
    targetWindow[WINDOW_STATE_KEY] = {
      blockers: {},
    };
  }

  return targetWindow[WINDOW_STATE_KEY] as NativePreviewOcclusionState;
}

function createSnapshot(state: NativePreviewOcclusionState): NativePreviewOcclusionSnapshot {
  const reasons = Object.entries(state.blockers)
    .filter(([, count]) => count > 0)
    .map(([reason]) => reason)
    .sort();

  return {
    active: reasons.length > 0,
    reasons,
  };
}

function emitChange(targetWindow: NativePreviewOcclusionWindow): void {
  targetWindow.dispatchEvent(
    new CustomEvent<NativePreviewOcclusionSnapshot>(CHANGE_EVENT_NAME, {
      detail: createSnapshot(getState(targetWindow)),
    }),
  );
}

export function getNativePreviewOcclusionSnapshot(): NativePreviewOcclusionSnapshot {
  const targetWindow = resolveWindow();
  if (!targetWindow) {
    return {
      active: false,
      reasons: [],
    };
  }

  return createSnapshot(getState(targetWindow));
}

export function isNativePreviewOccluded(): boolean {
  return getNativePreviewOcclusionSnapshot().active;
}

export function subscribeNativePreviewOcclusion(
  listener: (snapshot: NativePreviewOcclusionSnapshot) => void,
): () => void {
  const targetWindow = resolveWindow();
  if (!targetWindow) {
    listener({
      active: false,
      reasons: [],
    });
    return () => {};
  }

  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<NativePreviewOcclusionSnapshot>).detail;
    listener(detail);
  };

  targetWindow.addEventListener(CHANGE_EVENT_NAME, handleChange);
  listener(createSnapshot(getState(targetWindow)));

  return () => {
    targetWindow.removeEventListener(CHANGE_EVENT_NAME, handleChange);
  };
}

export function acquireNativePreviewOcclusion(reason: string): () => void {
  const targetWindow = resolveWindow();
  if (!targetWindow) {
    return () => {};
  }

  const normalizedReason = reason.trim() || 'unknown';
  const state = getState(targetWindow);
  state.blockers[normalizedReason] = (state.blockers[normalizedReason] ?? 0) + 1;
  emitChange(targetWindow);

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;

    const nextCount = Math.max(0, (state.blockers[normalizedReason] ?? 0) - 1);
    if (nextCount === 0) {
      delete state.blockers[normalizedReason];
    } else {
      state.blockers[normalizedReason] = nextCount;
    }

    emitChange(targetWindow);
  };
}
