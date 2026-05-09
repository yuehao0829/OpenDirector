import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { Track, Fragment, TimelineState, ToolMode, DraftFragment, Scene, Reference, PasteIndicator, SnapLine, GenerationParamDefaults } from '../types';

export type NativePreviewStepFrameDirection = 1 | -1;
type NativePreviewStepFrameHandler = (direction: NativePreviewStepFrameDirection) => boolean;
let nativePreviewStepFrameHandler: NativePreviewStepFrameHandler | null = null;

// Module-level ref: the authoritative playhead value during playback.
// rAF writes here at 60fps without triggering Zustand updates.
// Zustand `playhead` is synced at low frequency (~10fps) for UI display only.
let _playheadRef = 0;
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_SLIDER_STEPS } from '../constants/timeline';
import { calculateTimelineDuration, safeMax, timeToPixel } from '../utils/timeline';

const LOG_ZOOM_MIN = Math.log(ZOOM_MIN);
const LOG_ZOOM_MAX = Math.log(ZOOM_MAX);
const LOG_ZOOM_RANGE = LOG_ZOOM_MAX - LOG_ZOOM_MIN;
import { storeEvents } from './store-events';
import { useSelectionStore } from './selectionStore';
import { useSettingsStore } from './settingsStore';
import { createDefaultTracks, createDefaultScene } from '../services/project-defaults';
import { t } from '../i18n';

export function registerNativePreviewStepFrameHandler(
  handler: NativePreviewStepFrameHandler,
): () => void {
  nativePreviewStepFrameHandler = handler;
  return () => {
    if (nativePreviewStepFrameHandler === handler) {
      nativePreviewStepFrameHandler = null;
    }
  };
}

export function requestNativePreviewStepFrame(
  direction: NativePreviewStepFrameDirection,
): boolean {
  return nativePreviewStepFrameHandler?.(direction) ?? false;
}

// Layout constants (synchronized with UI constants)
// These are used for track position calculations in confirmSelectionBox
const TRACK_HEIGHT = 80;
const TIME_RULER_HEIGHT = 24;
const SCENE_TRACK_HEIGHT = 24;
const TRACK_DIVIDER_HEIGHT = 4;

function getDefaultGenParams(): GenerationParamDefaults {
  return { ...useSettingsStore.getState().defaultGenerationParams };
}

/** Deduplicate references by assetId, keeping first occurrence */
function dedupReferences(refs: Reference[]): Reference[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.assetId)) return false;
    seen.add(r.assetId);
    return true;
  });
}

interface TimelineActions {
  // Track actions
  addTrack: (track: Track) => void;
  updateTrack: (id: string, updates: Partial<Track>) => void;
  deleteTrack: (id: string) => void;
  canAddVideoTrack: () => boolean;
  insertTrackAfter: (trackId: string) => void;
  deleteTrackWithOrderReindex: (trackId: string) => void;

  // Fragment actions
  addFragment: (fragment: Fragment) => void;
  updateFragment: (id: string, updates: Partial<Fragment>) => void;
  deleteFragment: (id: string) => void;
  deleteFragments: (ids: string[]) => void;
  moveFragment: (id: string, newStart: number) => void;
  moveFragmentToTrack: (id: string, newStart: number, newTrackId: string) => void;
  moveFragments: (updates: Array<{ id: string; newStart: number; newTrackId?: string }>) => void;
  resizeFragment: (id: string, newDuration: number) => void;
  applyFragmentTiming: (
    id: string,
    updates: {
      start: number;
      duration: number;
      trimStart?: number;
    },
  ) => void;
  splitFragment: (id: string, splitTime: number) => void;
  mergeFragments: (ids: string[]) => void;
  createFragment: (trackId: string, startTime: number, duration?: number) => void;

  // Playback
  setPlayhead: (time: number) => void;
  /** Read the authoritative playhead ref (no re-render). Use in rAF loops, audio sync, etc. */
  getPlayheadRef: () => number;
  /** Write playhead ref only (no Zustand update, zero re-renders). Used by rAF playback loop. */
  setPlayheadRefOnly: (time: number) => void;
  play: () => void;
  pause: () => void;
  togglePlayback: () => void;
  setNativePreviewTransportControlled: (controlled: boolean) => void;

  // Zoom & Scroll
  adjustScrollForZoom: (oldZoom: number, newZoom: number) => number;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setZoomFromSlider: (value: number) => void; // value: 0-100
  getZoomSliderValue: () => number; // returns 0-100
  setScroll: (x: number, y: number) => void;

  // Tool Mode
  setToolMode: (mode: ToolMode) => void;

  // Selection Box
  startSelectionBox: (startX: number, startY: number) => void;
  updateSelectionBox: (endX: number, endY: number) => void;
  confirmSelectionBox: () => void;
  cancelSelectionBox: () => void;

  // Draft Fragment
  setDraftFragment: (draft: DraftFragment | null) => void;
  setDraftPrompt: (prompt: string) => void;
  confirmDraftFragment: (prompt?: string, references?: Reference[], sourceAssetId?: string) => void;
  cancelDraftFragment: () => void;

  // Scene management
  addScene: (scene: Scene) => void;
  updateScene: (id: string, updates: Partial<Scene>) => void;
  deleteScene: (id: string) => void;
  deleteScenes: (ids: string[]) => void;
  splitScene: (id: string, splitTime: number) => void;
  mergeScenes: (ids: string[]) => void;
  getSceneAtTime: (time: number) => Scene | undefined;

  // Clipboard
  copySelection: () => void;
  cutSelection: () => void;
  pasteFromClipboard: () => void;
  setPasteIndicator: (indicator: PasteIndicator | null) => void;
  clearPasteIndicator: () => void;

  // Reset
  reset: () => void;

  // Initialization
  initializeDefaults: () => void;

  // Snap
  toggleSnap: () => void;
  setSnapEnabled: (enabled: boolean) => void;
  setActiveSnapLines: (lines: SnapLine[]) => void;
  clearActiveSnapLines: () => void;
}

const initialState: TimelineState = {
  tracks: [],
  fragments: [],
  scenes: [],
  playhead: 0,
  zoom: 50, // pixels per second
  scroll: { x: 0, y: 0 },
  duration: 0,
  isPlaying: false,
  nativePreviewTransportControlled: false,
  toolMode: 'select',
  selectionBox: null,
  draftFragment: null,
  draftPrompt: '',
  maxVideoTracks: 10,
  clipboard: null,
  pasteIndicator: null,
  // Snap settings
  snapEnabled: true,
  snapThreshold: 25,
  activeSnapLines: [],
};

/**
 * Expand the last scene if content duration exceeds total scene duration.
 * Only expands the last scene, never shrinks.
 */
function expandLastSceneIfNeeded(
  scenes: Scene[],
  newDuration: number
): Scene[] {
  if (scenes.length === 0) return scenes;

  // Calculate total scene duration
  const totalSceneDuration = scenes.reduce(
    (sum, s) => sum + s.duration,
    0
  );

  // Only expand, never shrink
  if (newDuration <= totalSceneDuration) return scenes;

  // Extend the last scene
  const extraDuration = newDuration - totalSceneDuration;

  return scenes.map((s, index) =>
    index === scenes.length - 1
      ? { ...s, duration: s.duration + extraDuration, updatedAt: new Date() }
      : s
  );
}

/**
 * Paste scenes at a target time position.
 * Handles splitting existing scenes, maintaining continuity, and filling gaps.
 */
function pasteScenesAtPosition(
  existingScenes: Scene[],
  clipboardScenes: Scene[],
  targetTime: number,
  baseTime: number
): Scene[] {
  if (clipboardScenes.length === 0) return existingScenes;

  const timeOffset = targetTime - baseTime;

  // Calculate the total duration of pasted scenes
  const pastedScenesTotalDuration = clipboardScenes.reduce(
    (sum, s) => sum + s.duration,
    0
  );

  // Find where to insert/overwrite
  const pasteStartTime = Math.max(0, clipboardScenes[0].start + timeOffset);
  const pasteEndTime = pasteStartTime + pastedScenesTotalDuration;

  // Build new scenes list:
  // 1. Keep scenes that end before paste start
  // 2. Split and keep partial scenes that overlap with paste region edges
  // 3. Insert pasted scenes
  // 4. Keep scenes that start after paste end (adjust their positions)

  const beforeScenes: Scene[] = [];
  const afterScenes: Scene[] = [];

  for (const scene of existingScenes) {
    const sceneEnd = scene.start + scene.duration;

    if (sceneEnd <= pasteStartTime) {
      // Scene ends before paste region - keep as is
      beforeScenes.push(scene);
    } else if (scene.start >= pasteEndTime) {
      // Scene starts after paste region - will be adjusted
      afterScenes.push(scene);
    } else if (scene.start < pasteStartTime && sceneEnd > pasteStartTime) {
      // Scene starts before paste region and ends inside/after it
      // Keep the part before paste region
      const beforePart: Scene = {
        ...scene,
        duration: pasteStartTime - scene.start,
        updatedAt: new Date(),
      };
      beforeScenes.push(beforePart);

      // If scene also extends past the paste region, keep the after part
      if (sceneEnd > pasteEndTime) {
        const afterPart: Scene = {
          ...scene,
          id: `${scene.id}-after-${Date.now()}`,
          start: pasteEndTime,
          duration: sceneEnd - pasteEndTime,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        afterScenes.push(afterPart);
      }
    } else if (scene.start >= pasteStartTime && scene.start < pasteEndTime && sceneEnd > pasteEndTime) {
      // Scene starts inside paste region but ends after it
      // Keep the part after paste region
      const afterPart: Scene = {
        ...scene,
        start: pasteEndTime,
        duration: sceneEnd - pasteEndTime,
        updatedAt: new Date(),
      };
      afterScenes.push(afterPart);
    }
    // Scene parts completely inside the paste region are overwritten (discarded)
  }

  // Create pasted scenes with new IDs and adjusted positions
  let currentTime = pasteStartTime;
  const pastedScenes: Scene[] = clipboardScenes.map((clipScene, index) => {
    const newScene: Scene = {
      ...clipScene,
      id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${index}`,
      start: currentTime,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    currentTime += clipScene.duration;
    return newScene;
  });

  // Adjust after scenes to start right after pasted scenes
  let afterCurrentTime = pasteEndTime;
  const adjustedAfterScenes: Scene[] = afterScenes.map((scene) => {
    const adjustedScene: Scene = {
      ...scene,
      start: afterCurrentTime,
      updatedAt: new Date(),
    };
    afterCurrentTime += scene.duration;
    return adjustedScene;
  });

  // Combine all scenes and sort by start time
  const newScenes = [...pastedScenes, ...adjustedAfterScenes];
  const updatedScenes = [...beforeScenes, ...newScenes].sort((a, b) => a.start - b.start);

  // If there's a gap before the first scene, extend it to start from 0
  if (updatedScenes.length > 0 && updatedScenes[0].start > 0) {
    updatedScenes[0] = {
      ...updatedScenes[0],
      start: 0,
      duration: updatedScenes[0].duration + updatedScenes[0].start,
      updatedAt: new Date(),
    };
  }

  // Fill any gaps between scenes
  for (let i = 1; i < updatedScenes.length; i++) {
    const prevScene = updatedScenes[i - 1];
    const currScene = updatedScenes[i];
    const expectedStart = prevScene.start + prevScene.duration;
    if (currScene.start > expectedStart) {
      // Gap found - extend previous scene
      updatedScenes[i - 1] = {
        ...prevScene,
        duration: prevScene.duration + (currScene.start - expectedStart),
        updatedAt: new Date(),
      };
      updatedScenes[i] = {
        ...currScene,
        start: expectedStart,
        updatedAt: new Date(),
      };
    }
  }

  return updatedScenes;
}

export const useTimelineStore = create<TimelineState & TimelineActions>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,

    // Track actions
    addTrack: (track) => set((state) => ({
      tracks: [...state.tracks, track],
    })),

    updateTrack: (id, updates) => set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),

    deleteTrack: (id) => set((state) => ({
      tracks: state.tracks.filter((t) => t.id !== id),
      fragments: state.fragments.filter((f) => f.trackId !== id),
    })),

    canAddVideoTrack: () => {
      const state = get();
      const videoTracks = state.tracks.filter((t) => t.type === 'video');
      return videoTracks.length < state.maxVideoTracks;
    },

    insertTrackAfter: (trackId) => set((state) => {
      const targetTrack = state.tracks.find((t) => t.id === trackId);
      if (!targetTrack) return state;

      // Check max tracks limit for video
      if (targetTrack.type === 'video') {
        const videoCount = state.tracks.filter((t) => t.type === 'video').length;
        if (videoCount >= state.maxVideoTracks) return state;
      }

      // Shift all same-type tracks with order > target.order up by 1
      const shiftedTracks = state.tracks.map((t) =>
        t.type === targetTrack.type && t.order > targetTrack.order
          ? { ...t, order: t.order + 1 }
          : t
      );

      const sameTypeTracks = shiftedTracks.filter((t) => t.type === targetTrack.type);
      const newOrder = targetTrack.order + 1;
      const trackNumber = sameTypeTracks.length + 1;

      const newTrack: Track = {
        id: `${targetTrack.type}-track-${Date.now()}`,
        type: targetTrack.type,
        name: t(targetTrack.type === 'video' ? 'timeline.videoTrack' : 'timeline.audioTrack', { index: trackNumber }),
        muted: false,
        locked: false,
        order: newOrder,
      };

      return { tracks: [...shiftedTracks, newTrack] };
    }),

    deleteTrackWithOrderReindex: (trackId) => set((state) => {
      const targetTrack = state.tracks.find((t) => t.id === trackId);
      if (!targetTrack) return state;

      // Don't allow deleting if only 1 track of this type remains
      const sameTypeTracks = state.tracks.filter((t) => t.type === targetTrack.type);
      if (sameTypeTracks.length <= 1) return state;

      // Remove the track and its fragments
      const remainingTracks = state.tracks.filter((t) => t.id !== trackId);
      const remainingFragments = state.fragments.filter((f) => f.trackId !== trackId);

      // Re-index: for tracks of the same type with order > deleted order, shift down by 1
      const reindexedTracks = remainingTracks.map((t) =>
        t.type === targetTrack.type && t.order > targetTrack.order
          ? { ...t, order: t.order - 1 }
          : t
      );

      return {
        tracks: reindexedTracks,
        fragments: remainingFragments,
      };
    }),

    // Fragment actions
    addFragment: (fragment) => set((state) => {
      const newDuration = Math.max(state.duration, fragment.start + fragment.duration);
      const fragmentWithDefaults = fragment.genParams
        ? fragment
        : { ...fragment, genParams: getDefaultGenParams() };
      return {
        fragments: [...state.fragments, fragmentWithDefaults],
        scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
        duration: newDuration,
      };
    }),

    updateFragment: (id, updates) => {
      set((state) => {
        const existing = state.fragments.find(f => f.id === id);
        if (!existing) return state;

        return {
          fragments: state.fragments.map(f =>
            f.id === id ? { ...f, ...updates, updatedAt: new Date() } : f
          ),
        };
      });
    },

    deleteFragment: (id) => {
      if (useSelectionStore.getState().primaryIds.includes(id)) {
        storeEvents.emit({ type: 'SELECTION_CLEAR' });
      }

      set((state) => {
        const newFragments = state.fragments.filter((f) => f.id !== id);
        const newDuration = calculateTimelineDuration(newFragments, state.scenes);

        return {
          fragments: newFragments,
          duration: newDuration,
        };
      });
    },

    deleteFragments: (ids) => {
      const selSet = new Set(useSelectionStore.getState().primaryIds);
      if (ids.some(id => selSet.has(id))) {
        storeEvents.emit({ type: 'SELECTION_CLEAR' });
      }

      const idSet = new Set(ids);
      set((state) => {
        const newFragments = state.fragments.filter(f => !idSet.has(f.id));
        const newDuration = calculateTimelineDuration(newFragments, state.scenes);

        return {
          fragments: newFragments,
          duration: newDuration,
        };
      });
    },

    moveFragment: (id, newStart) => set((state) => {
      const fragment = state.fragments.find((f) => f.id === id);
      if (!fragment) return state;

      // Calculate duration based on all fragments after move
      const newFragments = state.fragments.map((f) =>
        f.id === id ? { ...f, start: Math.max(0, newStart) } : f
      );
      const newDuration = calculateTimelineDuration(newFragments, state.scenes);

      return {
        fragments: newFragments,
        scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
        duration: newDuration,
      };
    }),

    moveFragmentToTrack: (id, newStart, newTrackId) => set((state) => {
      const fragment = state.fragments.find((f) => f.id === id);
      if (!fragment) return state;

      // Verify target track exists and has matching type
      const targetTrack = state.tracks.find((t) => t.id === newTrackId);
      if (!targetTrack) return state;

      const sourceTrack = state.tracks.find((t) => t.id === fragment.trackId);
      if (!sourceTrack) return state;

      // Only allow moving between tracks of the same type
      if (sourceTrack.type !== targetTrack.type) return state;

      // Calculate duration based on all fragments after move
      const newFragments = state.fragments.map((f) =>
        f.id === id ? { ...f, start: Math.max(0, newStart), trackId: newTrackId } : f
      );
      const newDuration = calculateTimelineDuration(newFragments, state.scenes);

      return {
        fragments: newFragments,
        scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
        duration: newDuration,
      };
    }),

    moveFragments: (updates) => set((state) => {
      if (updates.length === 0) return state;

      const updatesById = new Map(updates.map((update) => [update.id, update]));
      const newFragments = state.fragments.map((fragment) => {
        const update = updatesById.get(fragment.id);
        if (!update) return fragment;

        let nextTrackId = fragment.trackId;
        if (update.newTrackId && update.newTrackId !== fragment.trackId) {
          const sourceTrack = state.tracks.find((track) => track.id === fragment.trackId);
          const targetTrack = state.tracks.find((track) => track.id === update.newTrackId);
          if (sourceTrack && targetTrack && sourceTrack.type === targetTrack.type) {
            nextTrackId = update.newTrackId;
          }
        }

        return {
          ...fragment,
          start: Math.max(0, update.newStart),
          trackId: nextTrackId,
        };
      });

      const newDuration = calculateTimelineDuration(newFragments, state.scenes);
      return {
        fragments: newFragments,
        scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
        duration: newDuration,
      };
    }),

    resizeFragment: (id, newFragmentDuration) => set((state) => {
      const fragment = state.fragments.find((f) => f.id === id);
      if (!fragment) return state;

      // Calculate duration based on all fragments after resize
      const newFragments = state.fragments.map((f) =>
        f.id === id ? { ...f, duration: Math.max(1000, newFragmentDuration) } : f
      );
      const newDuration = calculateTimelineDuration(newFragments, state.scenes);

      return {
        fragments: newFragments,
        scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
        duration: newDuration,
      };
    }),

    applyFragmentTiming: (id, updates) => set((state) => {
      const fragment = state.fragments.find((f) => f.id === id);
      if (!fragment) return state;

      const normalizedStart = Math.max(0, updates.start);
      const normalizedDuration = Math.max(1000, updates.duration);
      const normalizedTrimStart =
        updates.trimStart === undefined ? undefined : Math.max(0, updates.trimStart);

      const newFragments = state.fragments.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              start: normalizedStart,
              duration: normalizedDuration,
              trimStart: normalizedTrimStart,
              updatedAt: new Date(),
            }
          : candidate,
      );
      const newDuration = calculateTimelineDuration(newFragments, state.scenes);

      return {
        fragments: newFragments,
        scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
        duration: newDuration,
      };
    }),

    splitFragment: (id, splitTime) => set((state) => {
      const fragment = state.fragments.find((f) => f.id === id);
      if (!fragment) return state;

      const relativeTime = splitTime - fragment.start;
      if (relativeTime <= 0 || relativeTime >= fragment.duration) return state;
      const hasPlaybackSource = !!(fragment.sourceAssetId ?? fragment.resultAssetId);

      const firstFragment: Fragment = {
        ...fragment,
        duration: relativeTime,
        trimStart: hasPlaybackSource ? fragment.trimStart : undefined,
        updatedAt: new Date(),
      };

      const secondFragment: Fragment = {
        ...fragment,
        id: `${fragment.id}-split-${Date.now()}`,
        start: splitTime,
        duration: fragment.duration - relativeTime,
        trimStart: hasPlaybackSource ? (fragment.trimStart ?? 0) + relativeTime : undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        fragments: [
          ...state.fragments.filter((f) => f.id !== id),
          firstFragment,
          secondFragment,
        ],
      };
    }),

    mergeFragments: (ids) => set((state) => {
      if (ids.length < 2) return state;

      const fragmentsToMerge = state.fragments
        .filter((f) => ids.includes(f.id))
        .sort((a, b) => a.start - b.start);

      if (fragmentsToMerge.length !== ids.length) return state;

      // Check if fragments are adjacent or overlapping (no gaps)
      for (let i = 1; i < fragmentsToMerge.length; i++) {
        const prevEnd = fragmentsToMerge[i - 1].start + fragmentsToMerge[i - 1].duration;
        if (prevEnd < fragmentsToMerge[i].start) {
          return state; // Gap between fragments
        }
      }

      const startTime = fragmentsToMerge[0].start;
      const endTime = safeMax(fragmentsToMerge.map((f) => f.start + f.duration));

      const mergedFragment: Fragment = {
        id: fragmentsToMerge[0].id,
        trackId: fragmentsToMerge[0].trackId,
        start: startTime,
        duration: endTime - startTime,
        prompt: fragmentsToMerge.map((f) => f.prompt).filter(Boolean).join(' '),
        references: dedupReferences(fragmentsToMerge.flatMap((f) => f.references)),
        sourceAssetId: fragmentsToMerge[0].sourceAssetId,
        trimStart: fragmentsToMerge[0].trimStart,
        status: 'draft',
        sceneId: fragmentsToMerge[0].sceneId,
        genParams: fragmentsToMerge[0].genParams,
        createdAt: fragmentsToMerge[0].createdAt,
        updatedAt: new Date(),
      };

      return {
        fragments: [
          ...state.fragments.filter((f) => !ids.includes(f.id)),
          mergedFragment,
        ],
      };
    }),

    createFragment: (trackId, startTime, duration = 5000) => {
      const state = get();

      // Find the gap available at startTime before the next fragment
      const trackFragments = state.fragments
        .filter((f) => f.trackId === trackId)
        .sort((a, b) => a.start - b.start);

      const nextFragment = trackFragments.find((f) => f.start > startTime);
      const gapEnd = nextFragment ? nextFragment.start : Infinity;
      const availableDuration = Math.min(duration, gapEnd - startTime);

      const newFragment: Fragment = {
        id: `fragment-${Date.now()}`,
        trackId,
        start: startTime,
        duration: Math.max(availableDuration, 500), // minimum 0.5s
        prompt: '',
        references: [],
        status: 'draft',
        genParams: getDefaultGenParams(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const newDuration = Math.max(
        state.duration,
        startTime + newFragment.duration
      );

      // Auto-select the new fragment via event
      storeEvents.emit({ type: 'SELECTION_SELECT_FRAGMENT', id: newFragment.id });

      set({
        fragments: [...state.fragments, newFragment],
        scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
        duration: newDuration,
      });
    },

    // Selection is now handled by selectionStore directly

    // Playback
    setPlayhead: (time) => {
      const clamped = Math.max(0, time);
      _playheadRef = clamped;
      set((s) => s.playhead === clamped ? s : { playhead: clamped });
    },

    getPlayheadRef: () => _playheadRef,

    setPlayheadRefOnly: (time) => {
      _playheadRef = Math.max(0, time);
    },

    play: () => set({ isPlaying: true }),

    pause: () => set({ isPlaying: false }),

    togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),

    setNativePreviewTransportControlled: (controlled) =>
      set({ nativePreviewTransportControlled: controlled }),

    // Zoom & Scroll

    /** Adjust scroll.x so the playhead stays at the same viewport position after zoom change. */
    adjustScrollForZoom: (oldZoom, newZoom) => {
      const state = get();
      const newScrollX = timeToPixel(state.playhead, newZoom - oldZoom) + state.scroll.x;
      return Math.max(0, newScrollX);
    },

    setZoom: (zoom) => {
      const state = get();
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
      if (clamped === state.zoom) return;
      set({ zoom: clamped, scroll: { x: state.adjustScrollForZoom(state.zoom, clamped), y: state.scroll.y } });
    },

    zoomIn: () => {
      const state = get();
      if (state.zoom >= ZOOM_MAX) return;
      const newZoom = Math.min(ZOOM_MAX, state.zoom + ZOOM_STEP);
      set({ zoom: newZoom, scroll: { x: state.adjustScrollForZoom(state.zoom, newZoom), y: state.scroll.y } });
    },

    zoomOut: () => {
      const state = get();
      if (state.zoom <= ZOOM_MIN) return;
      const newZoom = Math.max(ZOOM_MIN, state.zoom - ZOOM_STEP);
      set({ zoom: newZoom, scroll: { x: state.adjustScrollForZoom(state.zoom, newZoom), y: state.scroll.y } });
    },

    setZoomFromSlider: (value) => {
      const state = get();
      const normalized = value / ZOOM_SLIDER_STEPS;
      const logZoom = LOG_ZOOM_MIN + normalized * LOG_ZOOM_RANGE;
      const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.exp(logZoom)));
      if (newZoom === state.zoom) return;
      set({ zoom: newZoom, scroll: { x: state.adjustScrollForZoom(state.zoom, newZoom), y: state.scroll.y } });
    },

    getZoomSliderValue: () => {
      const state = get();
      const normalized = (Math.log(state.zoom) - LOG_ZOOM_MIN) / LOG_ZOOM_RANGE;
      return Math.round(normalized * ZOOM_SLIDER_STEPS);
    },

    setScroll: (x, y) => set({ scroll: { x: Math.max(0, x), y: Math.max(0, y) } }),

    // Tool Mode
    setToolMode: (mode) => set({ toolMode: mode }),

    // Selection Box
    startSelectionBox: (startX, startY) => set({
      selectionBox: { startX, startY, endX: startX, endY: startY },
    }),

    updateSelectionBox: (endX, endY) => set((state) => {
      if (!state.selectionBox) return state;
      return {
        selectionBox: { ...state.selectionBox, endX, endY },
      };
    }),

    confirmSelectionBox: () => set((state) => {
      if (!state.selectionBox) return state;

      const { startX, startY, endX, endY } = state.selectionBox;
      const minX = Math.min(startX, endX);
      const maxX = Math.max(startX, endX);
      const minY = Math.min(startY, endY);
      const maxY = Math.max(startY, endY);
      const zoom = state.zoom;

      const startTime = (minX / zoom) * 1000;
      const endTime = (maxX / zoom) * 1000;

      // Note: Y coordinates from TimelineCanvas are content coordinates
      // (already include scroll.y offset). Track positions are also content
      // coordinates (absolute positions in the scrollable content).
      // Both use the same coordinate system, so compare directly.

      // Check if selection overlaps with scene track
      const sceneTrackTop = TIME_RULER_HEIGHT;
      const sceneTrackBottom = TIME_RULER_HEIGHT + SCENE_TRACK_HEIGHT;

      // Find fragments that overlap with selection box
      const overlappingFragments: string[] = [];
      const overlappingScenes: string[] = [];

      // Check scene overlap
      if (minY < sceneTrackBottom && maxY > sceneTrackTop) {
        state.scenes.forEach(scene => {
          const sceneStart = (scene.start / 1000) * zoom;
          const sceneEnd = ((scene.start + scene.duration) / 1000) * zoom;

          // Check if scene overlaps with selection horizontally
          if (sceneEnd > minX && sceneStart < maxX) {
            overlappingScenes.push(scene.id);
          }
        });
      }

      // Check fragment overlap
      // Need to use visual position (sorted by order) not store index
      const videoTracks = state.tracks
        .filter(t => t.type === 'video')
        .sort((a, b) => b.order - a.order); // Descending: highest order at top
      const audioTracks = state.tracks
        .filter(t => t.type === 'audio')
        .sort((a, b) => a.order - b.order); // Ascending: lowest order at top (near divider)
      const videoAreaHeight = videoTracks.length * TRACK_HEIGHT;
      const audioAreaStart = TIME_RULER_HEIGHT + SCENE_TRACK_HEIGHT + videoAreaHeight + TRACK_DIVIDER_HEIGHT;

      state.fragments.forEach(fragment => {
        const track = state.tracks.find(t => t.id === fragment.trackId);
        if (!track) return;

        // Calculate visual Y position based on track type and order
        let trackTop: number;

        if (track.type === 'video') {
          const visualIndex = videoTracks.findIndex(t => t.id === track.id);
          trackTop = TIME_RULER_HEIGHT + SCENE_TRACK_HEIGHT + visualIndex * TRACK_HEIGHT;
        } else {
          const visualIndex = audioTracks.findIndex(t => t.id === track.id);
          trackTop = audioAreaStart + visualIndex * TRACK_HEIGHT;
        }
        const trackBottom = trackTop + TRACK_HEIGHT;

        // Check if fragment's track overlaps with selection vertically
        if (trackBottom > minY && trackTop < maxY) {
          const fragStart = (fragment.start / 1000) * zoom;
          const fragEnd = ((fragment.start + fragment.duration) / 1000) * zoom;

          // Check if fragment overlaps with selection horizontally
          if (fragEnd > minX && fragStart < maxX) {
            overlappingFragments.push(fragment.id);
          }
        }
      });

      // If there are overlapping fragments or scenes, select them instead of creating draft
      if (overlappingFragments.length > 0) {
        storeEvents.emit({ type: 'SELECTION_SELECT_FRAGMENTS', ids: overlappingFragments });
        return {
          selectionBox: null,
        };
      }

      if (overlappingScenes.length > 0) {
        storeEvents.emit({ type: 'SELECTION_SELECT_SCENES', ids: overlappingScenes });
        return {
          selectionBox: null,
        };
      }

      // No overlapping items - determine which track to create fragment on
      // Find tracks that overlap with selection box (using visual positions)
      const overlappingTracks: { trackId: string; overlapArea: number }[] = [];

      // Check video tracks (sorted by order descending - highest order at top)
      videoTracks.forEach((track, visualIndex) => {
        const trackTop = TIME_RULER_HEIGHT + SCENE_TRACK_HEIGHT + visualIndex * TRACK_HEIGHT;
        const trackBottom = trackTop + TRACK_HEIGHT;

        // Calculate vertical overlap
        const overlapTop = Math.max(minY, trackTop);
        const overlapBottom = Math.min(maxY, trackBottom);
        const overlapHeight = Math.max(0, overlapBottom - overlapTop);

        if (overlapHeight > 0) {
          overlappingTracks.push({
            trackId: track.id,
            overlapArea: overlapHeight * (maxX - minX),
          });
        }
      });

      // Check audio tracks (sorted by order ascending - lowest order at top, near divider)
      audioTracks.forEach((track, visualIndex) => {
        const trackTop = audioAreaStart + visualIndex * TRACK_HEIGHT;
        const trackBottom = trackTop + TRACK_HEIGHT;

        // Calculate vertical overlap
        const overlapTop = Math.max(minY, trackTop);
        const overlapBottom = Math.min(maxY, trackBottom);
        const overlapHeight = Math.max(0, overlapBottom - overlapTop);

        if (overlapHeight > 0) {
          overlappingTracks.push({
            trackId: track.id,
            overlapArea: overlapHeight * (maxX - minX),
          });
        }
      });

      // Sort by overlap area, pick the track with largest overlap
      overlappingTracks.sort((a, b) => b.overlapArea - a.overlapArea);

      if (overlappingTracks.length === 0) {
        return { selectionBox: null };
      }

      const targetTrackId = overlappingTracks[0].trackId;

      return {
        selectionBox: null,
        draftFragment: {
          trackId: targetTrackId,
          start: startTime,
          duration: endTime - startTime,
        },
      };
    }),

    cancelSelectionBox: () => set({ selectionBox: null }),

    // Draft Fragment
    setDraftFragment: (draft) => {
      // Also update selection via event
      if (draft) {
        storeEvents.emit({
          type: 'SELECTION_SELECT_DRAFT',
          data: {
            trackId: draft.trackId,
            start: draft.start,
            duration: draft.duration,
          },
        });
      } else {
        storeEvents.emit({ type: 'SELECTION_CLEAR' });
      }
      set({ draftFragment: draft, draftPrompt: '' });
    },

    setDraftPrompt: (prompt) => set({ draftPrompt: prompt }),

    confirmDraftFragment: (prompt, references = [], sourceAssetId) => {
      set((state) => {
        if (!state.draftFragment) return state;

        const newId = `fragment-${Date.now()}`;

        // Use provided prompt or fall back to stored draftPrompt
        const finalPrompt = prompt ?? state.draftPrompt ?? '';

        const newFragment: Fragment = {
          id: newId,
          trackId: state.draftFragment.trackId,
          start: state.draftFragment.start,
          duration: state.draftFragment.duration,
          prompt: finalPrompt,
          references,
          sourceAssetId,
          status: 'draft',
          genParams: getDefaultGenParams(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Select the newly created fragment via event
        storeEvents.emit({ type: 'SELECTION_SELECT_FRAGMENT', id: newId });

        const newDuration = Math.max(
          state.duration,
          newFragment.start + newFragment.duration
        );

        return {
          fragments: [...state.fragments, newFragment],
          draftFragment: null,
          draftPrompt: '',
          scenes: expandLastSceneIfNeeded(state.scenes, newDuration),
          duration: newDuration,
        };
      });
    },

    cancelDraftFragment: () => {
      // Also clear selection via event
      storeEvents.emit({ type: 'SELECTION_CLEAR' });
      set({ draftFragment: null, draftPrompt: '' });
    },

    // Scene management
    addScene: (scene) => set((state) => ({
      scenes: [...state.scenes, scene],
    })),

    updateScene: (id, updates) => set((state) => {
      // Update the scene
      const newScenes = state.scenes.map((s) =>
        s.id === id ? { ...s, ...updates, updatedAt: new Date() } : s
      );

      const newDuration = calculateTimelineDuration(state.fragments, newScenes);

      return {
        scenes: newScenes,
        duration: newDuration,
      };
    }),

    deleteScene: (id) => {
      if (useSelectionStore.getState().primaryIds.includes(id)) {
        storeEvents.emit({ type: 'SELECTION_CLEAR' });
      }

      set((state) => {
        const sceneIndex = state.scenes.findIndex((s) => s.id === id);
        if (sceneIndex === -1) return state;

        const scene = state.scenes[sceneIndex];
        const prevScene = state.scenes[sceneIndex - 1];
        const nextScene = state.scenes[sceneIndex + 1];

        // If there's a next scene, extend it to fill the gap
        if (nextScene) {
          return {
            scenes: state.scenes
              .filter((s) => s.id !== id)
              .map((s) =>
                s.id === nextScene.id
                  ? { ...s, start: scene.start, duration: scene.duration + nextScene.duration }
                  : s
              ),
          };
        }

        // If there's a previous scene, extend it to fill the gap
        if (prevScene) {
          return {
            scenes: state.scenes.map((s) =>
              s.id === prevScene.id
                ? { ...s, duration: prevScene.duration + scene.duration }
                : s
            ).filter((s) => s.id !== id),
          };
        }

        // This is the only scene, don't delete
        return state;
      });
    },

    deleteScenes: (ids) => {
      const selSet = new Set(useSelectionStore.getState().primaryIds);
      if (ids.some(id => selSet.has(id))) {
        storeEvents.emit({ type: 'SELECTION_CLEAR' });
      }

      const idSet = new Set(ids);
      set((state) => {
        // Don't delete if it would remove all scenes
        const remainingScenes = state.scenes.filter(s => !idSet.has(s.id));
        if (remainingScenes.length === 0) return state;

        // For batch deletion, extend the last remaining scene to absorb
        // any gaps created by deletion.
        const newDuration = calculateTimelineDuration(state.fragments, remainingScenes);

        return {
          scenes: expandLastSceneIfNeeded(remainingScenes, newDuration),
          duration: newDuration,
        };
      });
    },

    splitScene: (id, splitTime) => set((state) => {
      const scene = state.scenes.find((s) => s.id === id);
      if (!scene) return state;

      const relativeTime = splitTime - scene.start;
      if (relativeTime <= 0 || relativeTime >= scene.duration) return state;

      const firstScene: Scene = {
        ...scene,
        duration: relativeTime,
        updatedAt: new Date(),
      };

      const secondScene: Scene = {
        ...scene,
        id: `${scene.id}-split-${Date.now()}`,
        name: `${scene.name} (2)`,
        start: splitTime,
        duration: scene.duration - relativeTime,
        referenceIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return {
        scenes: [
          ...state.scenes.filter((s) => s.id !== id),
          firstScene,
          secondScene,
        ],
      };
    }),

    mergeScenes: (ids) => set((state) => {
      if (ids.length < 2) return state;

      const scenesToMerge = state.scenes
        .filter((s) => ids.includes(s.id))
        .sort((a, b) => a.start - b.start);

      if (scenesToMerge.length !== ids.length) return state;

      // Check if scenes are adjacent (no gaps)
      for (let i = 1; i < scenesToMerge.length; i++) {
        const prevEnd = scenesToMerge[i - 1].start + scenesToMerge[i - 1].duration;
        if (prevEnd < scenesToMerge[i].start) {
          return state; // Gap between scenes
        }
      }

      const startTime = scenesToMerge[0].start;
      const endTime = safeMax(scenesToMerge.map((s) => s.start + s.duration));

      const mergedScene: Scene = {
        id: scenesToMerge[0].id,
        name: scenesToMerge[0].name,
        start: startTime,
        duration: endTime - startTime,
        referenceIds: [...new Set(scenesToMerge.flatMap((s) => s.referenceIds))].slice(0, 2),
        createdAt: scenesToMerge[0].createdAt,
        updatedAt: new Date(),
      };

      return {
        scenes: [
          ...state.scenes.filter((s) => !ids.includes(s.id)),
          mergedScene,
        ],
      };
    }),

    getSceneAtTime: (time) => {
      const state = get();
      return state.scenes.find((s) => s.start <= time && s.start + s.duration > time);
    },

    // Clipboard
    copySelection: () => {
      const state = get();
      const selState = useSelectionStore.getState();
      const fragmentIds = selState.getSelectedIds('fragment');
      const sceneIds = selState.getSelectedIds('scene');
      const { fragments, scenes, tracks } = state;

      // Get selected fragments
      const selectedFragments = fragments.filter((f) => fragmentIds.includes(f.id));
      // Get selected scenes
      const selectedScenes = scenes.filter((s) => sceneIds.includes(s.id));

      if (selectedFragments.length === 0 && selectedScenes.length === 0) return;

      // Calculate base time and base track order (type-local)
      // Base fragment is the one with the earliest start time
      // baseTrackOrder is the type-local order of the base fragment's track
      let baseTime = Infinity;
      let baseFragmentTrackId: string | null = null;

      for (const fragment of selectedFragments) {
        if (fragment.start < baseTime) {
          baseTime = fragment.start;
          baseFragmentTrackId = fragment.trackId;
        }
      }

      for (const scene of selectedScenes) {
        if (scene.start < baseTime) {
          baseTime = scene.start;
          // Scenes don't have a track, so reset baseFragmentTrackId
          baseFragmentTrackId = null;
        }
      }

      // Calculate baseTrackOrder and baseTrackType from the base fragment's track
      const baseTrack = baseFragmentTrackId
        ? tracks.find((t) => t.id === baseFragmentTrackId)
        : undefined;
      const baseTrackOrder = baseTrack?.order ?? 0;
      const baseTrackType: 'video' | 'audio' = baseTrack?.type ?? 'video';

      // Deep copy with new IDs
      const copiedFragments: Fragment[] = selectedFragments.map((f) => ({
        ...f,
        id: `fragment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const copiedScenes: Scene[] = selectedScenes.map((s) => ({
        ...s,
        id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      set({
        clipboard: {
          fragments: copiedFragments,
          scenes: copiedScenes,
          baseTime: baseTime === Infinity ? 0 : baseTime,
          baseTrackOrder: baseTrackOrder,
          baseTrackType: baseTrackType,
        },
      });
    },

    cutSelection: () => {
      const state = get();
      const selState = useSelectionStore.getState();
      const fragmentIds = selState.getSelectedIds('fragment');
      const sceneIds = selState.getSelectedIds('scene');

      // First copy
      state.copySelection();

      // Then delete selected items
      if (fragmentIds.length > 0) {
        const newFragments = state.fragments.filter((f) => !fragmentIds.includes(f.id));
        const newDuration = calculateTimelineDuration(newFragments, state.scenes);

        storeEvents.emit({ type: 'SELECTION_CLEAR' });
        set({
          fragments: newFragments,
          duration: newDuration,
        });
      }

      if (sceneIds.length > 0) {
        // For scenes, we need to handle deletion carefully
        // For cut, we'll just remove them (simpler than deleteScene which extends neighbors)
        const newScenes = state.scenes.filter((s) => !sceneIds.includes(s.id));
        const newDuration = calculateTimelineDuration(state.fragments, newScenes);

        storeEvents.emit({ type: 'SELECTION_CLEAR' });
        set({
          scenes: newScenes,
          duration: newDuration,
        });
      }
    },

    pasteFromClipboard: () => set((state) => {
      const { clipboard, pasteIndicator, tracks, fragments, scenes, maxVideoTracks } = state;
      if (!clipboard) return state;

      // Determine paste target
      let targetTime: number;
      let targetTrackId: string | undefined;

      if (pasteIndicator) {
        targetTime = pasteIndicator.time;
        targetTrackId = pasteIndicator.trackId;
      } else {
        // Use playhead position
        targetTime = state.playhead;
        targetTrackId = undefined; // Scene track
      }

      const timeOffset = targetTime - clipboard.baseTime;

      // Calculate type-local order offset for fragment pasting
      // Only applies when pasting to a specific track (not scene track)
      let trackOrderOffset = 0;
      if (targetTrackId !== undefined) {
        const targetTrack = tracks.find((t) => t.id === targetTrackId);
        if (targetTrack && targetTrack.type === clipboard.baseTrackType) {
          trackOrderOffset = targetTrack.order - clipboard.baseTrackOrder;
        } else {
          // Target track is a different type or not found — fall back to scene track
          targetTrackId = undefined;
        }
      }

      const newFragments: Fragment[] = [];
      const tracksToAdd: Track[] = [];
      let tracksToAddBefore = 0; // Number of tracks to insert before existing tracks (per type)
      let updatedScenes: Scene[] = []; // For scene paste processing

      // Process fragments
      if (targetTrackId !== undefined) {
        for (const clipFragment of clipboard.fragments) {
          const sourceTrack = tracks.find((t) => t.id === clipFragment.trackId);
          if (!sourceTrack) continue;

          // Skip fragments whose source track type doesn't match the base
          if (sourceTrack.type !== clipboard.baseTrackType) continue;

          const targetOrder = sourceTrack.order + trackOrderOffset;

          // Check if we need to create a new track
          // First check in existing tracks, then in tracks being added
          let targetTrack: Track | undefined;

          // Handle negative order (insert before existing tracks)
          if (targetOrder < 0) {
            // Check if track exists in tracksToAdd (for multi-fragment paste)
            targetTrack = tracksToAdd.find((t) => t.type === sourceTrack.type && t.order === targetOrder);

            if (!targetTrack) {
              // Check if we can create a video track
              const existingSameTypeTracks = tracks.filter((t) => t.type === sourceTrack.type);
              const newSameTypeTracks = tracksToAdd.filter((t) => t.type === sourceTrack.type);
              if (sourceTrack.type === 'video' && existingSameTypeTracks.length + newSameTypeTracks.length >= maxVideoTracks) {
                continue;
              }

              // Create new track before existing tracks
              const newTrack: Track = {
                id: `track-${sourceTrack.type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                type: sourceTrack.type,
                name: t(sourceTrack.type === 'video' ? 'timeline.videoTrack' : 'timeline.audioTrack', { index: Math.abs(targetOrder) }),
                muted: false,
                locked: false,
                order: targetOrder,
              };
              tracksToAdd.push(newTrack);
              tracksToAddBefore = Math.max(tracksToAddBefore, Math.abs(targetOrder));
              targetTrack = newTrack;
            }
          } else {
            // Non-negative order: find existing track of same type with matching order
            targetTrack = tracks.find((t) => t.type === sourceTrack.type && t.order === targetOrder);

            if (!targetTrack) {
              // Check if track exists in tracksToAdd (for multi-fragment paste)
              targetTrack = tracksToAdd.find((t) => t.type === sourceTrack.type && t.order === targetOrder);
            }

            if (!targetTrack) {
              // Check if we can create a video track
              const existingSameTypeTracks = tracks.filter((t) => t.type === sourceTrack.type);
              const newSameTypeTracks = tracksToAdd.filter((t) => t.type === sourceTrack.type);
              if (sourceTrack.type === 'video' && existingSameTypeTracks.length + newSameTypeTracks.length >= maxVideoTracks) {
                continue;
              }

              // Create new track
              const newTrack: Track = {
                id: `track-${sourceTrack.type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                type: sourceTrack.type,
                name: t(sourceTrack.type === 'video' ? 'timeline.videoTrack' : 'timeline.audioTrack', { index: targetOrder + 1 }),
                muted: false,
                locked: false,
                order: targetOrder,
              };
              tracksToAdd.push(newTrack);
              targetTrack = newTrack;
            }
          }

          if (!targetTrack) continue;

          const newFragment: Fragment = {
            ...clipFragment,
            id: `fragment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            trackId: targetTrack.id,
            start: Math.max(0, clipFragment.start + timeOffset),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          newFragments.push(newFragment);
        }
      }

      // Process scenes - scenes have special constraints:
      // 1. Must be continuous (no gaps)
      // 2. Always paste at playhead position (ignore pasteIndicator for scenes)
      // 3. Need to rebuild scene list to maintain continuity
      if (clipboard.scenes.length > 0) {
        // For scenes, always use playhead as target position
        updatedScenes = pasteScenesAtPosition(
          scenes,
          clipboard.scenes,
          state.playhead,
          clipboard.baseTime
        );
      }

      // Check if there's anything to paste
      if (newFragments.length === 0 && clipboard.scenes.length === 0) return state;

      // Handle overlaps for fragments only (scenes handled above)
      let updatedFragments = [...fragments];

      // For fragments, remove any that overlap with pasted fragments
      for (const newFrag of newFragments) {
        updatedFragments = updatedFragments.filter((f) => {
          if (f.trackId !== newFrag.trackId) return true;
          // Check overlap
          const fEnd = f.start + f.duration;
          const nEnd = newFrag.start + newFrag.duration;
          return fEnd <= newFrag.start || f.start >= nEnd;
        });
      }

      // Use updatedScenes if we processed scenes, otherwise use original scenes
      const finalScenes = clipboard.scenes.length > 0 ? updatedScenes : scenes;

      // Build final tracks list
      let allTracks: Track[];

      if (tracksToAddBefore > 0) {
        // Need to insert tracks before existing ones
        // Only shift the order of existing tracks that are the same type as the new tracks
        const newTrackTypes = [...new Set(tracksToAdd.map((t) => t.type))];

        const adjustedExistingTracks = tracks.map((t) => ({
          ...t,
          order: newTrackTypes.includes(t.type) ? t.order + tracksToAddBefore : t.order,
        }));

        // Adjust tracksToAdd to have correct order (0-based from negative indices)
        const adjustedNewTracks = tracksToAdd.map((t) => ({
          ...t,
          order: t.order + tracksToAddBefore, // Convert negative to positive
        }));

        // Combine — existing tracks keep relative order, new tracks inserted
        allTracks = [...adjustedExistingTracks, ...adjustedNewTracks];
      } else {
        // Normal case: append new tracks after existing ones
        allTracks = [...tracks, ...tracksToAdd];
      }

      // Add new items
      const allFragments = [...updatedFragments, ...newFragments];
      const allScenes = finalScenes;

      // Calculate new duration
      const maxFragmentEnd = safeMax(allFragments.map(f => f.start + f.duration));
      const maxSceneEnd = safeMax(allScenes.map(s => s.start + s.duration));
      const newDuration = Math.max(maxFragmentEnd, maxSceneEnd);

      return {
        fragments: allFragments,
        scenes: expandLastSceneIfNeeded(allScenes, newDuration),
        tracks: allTracks,
        duration: newDuration,
        pasteIndicator: null,
      };
    }),

    setPasteIndicator: (indicator) => set({ pasteIndicator: indicator }),

    clearPasteIndicator: () => set({ pasteIndicator: null }),

    // Reset
    reset: () => {
      _playheadRef = 0;
      set(initialState);
    },

    // Initialize default state (tracks and scenes)
    // Defensive fallback — normal flow is handled by ensureProject() in projectStore
    initializeDefaults: () => {
      const state = get();
      const { tracks, scenes } = state;

      // Only initialize if empty
      if (tracks.length === 0) {
        for (const track of createDefaultTracks()) {
          state.addTrack(track);
        }
      }

      if (scenes.length === 0) {
        state.addScene(createDefaultScene());
      }
    },

    // Snap actions
    toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

    setSnapEnabled: (enabled) => set({ snapEnabled: enabled }),

    setActiveSnapLines: (lines) => set({ activeSnapLines: lines }),

    clearActiveSnapLines: () => set({ activeSnapLines: [] }),
  }))
);

// ---------------------------------------------------------------------------
// Subscribe to storeEvents — SNAPSHOT_RESTORED from undoManager
// ---------------------------------------------------------------------------
storeEvents.subscribe((event) => {
  if (event.type === 'SNAPSHOT_RESTORED') {
    useTimelineStore.setState({
      tracks: event.snapshot.tracks,
      fragments: event.snapshot.fragments,
      scenes: event.snapshot.scenes,
      duration: event.snapshot.duration,
    });
  }
});
