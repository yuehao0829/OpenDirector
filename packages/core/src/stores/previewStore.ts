/**
 * Preview Store
 *
 * Manages preview state for both asset preview and timeline preview modes.
 *
 * Behavior:
 * - Asset mode: Independent playback state (play/pause/seek controls video directly)
 * - Timeline mode: Delegates to timelineStore for playback (video syncs with playhead)
 * - Auto-stop on source change: setAssetPreview pauses current playback
 */

import { create } from 'zustand';

type PreviewMode = 'asset' | 'timeline' | 'reference';
type AssetPreviewType = 'video' | 'image' | 'audio';

interface PreviewState {
  // Mode
  mode: PreviewMode;

  // Asset mode state
  assetId: string | null;
  assetType: AssetPreviewType | null;

  // Playback state (independent for asset mode)
  isPlaying: boolean;
  currentTime: number;  // milliseconds
  duration: number;     // milliseconds
  playbackRate: number;

  // Actions
  setAssetPreview: (assetId: string, assetType: AssetPreviewType, duration?: number) => void;
  setReferencePreview: (assetId: string, assetType: AssetPreviewType, duration?: number) => void;
  setPreviewMode: (mode: PreviewMode, assetId: string, assetType: AssetPreviewType, duration?: number) => void;
  setTimelinePreview: () => void;
  clearPreview: () => void;

  // Playback actions
  play: () => void;
  pause: () => void;
  togglePlayback: () => void;
  seek: (time: number) => void;
  setTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setPlaybackRate: (rate: number) => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  // Initial state
  mode: 'timeline',
  assetId: null,
  assetType: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,

  // Set any non-timeline preview mode - auto-stops current playback
  setPreviewMode: (mode, assetId, assetType, duration = 0) => {
    set({ mode, assetId, assetType, isPlaying: false, currentTime: 0, duration });
  },

  // Convenience: set asset preview mode
  setAssetPreview: (assetId, assetType, duration = 0) => {
    set({ mode: 'asset', assetId, assetType, isPlaying: false, currentTime: 0, duration });
  },

  // Convenience: set reference preview mode
  setReferencePreview: (assetId, assetType, duration = 0) => {
    set({ mode: 'reference', assetId, assetType, isPlaying: false, currentTime: 0, duration });
  },

  // Set timeline preview mode - auto-stops current playback
  setTimelinePreview: () => {
    set({
      mode: 'timeline',
      assetId: null,
      assetType: null,
      isPlaying: false,  // Auto-stop on source change
      currentTime: 0,
    });
  },

  // Clear preview
  clearPreview: () => {
    set({
      mode: 'timeline',
      assetId: null,
      assetType: null,
      isPlaying: false,
      currentTime: 0,
    });
  },

  // Playback actions (primarily for asset mode)
  play: () => set({ isPlaying: true }),

  pause: () => set({ isPlaying: false }),

  togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),

  seek: (time) => set((state) => ({
    currentTime: Math.max(0, Math.min(time, state.duration)),
  })),

  setTime: (time) => set({ currentTime: Math.max(0, time) }),

  setDuration: (duration) => set({ duration: Math.max(0, duration) }),

  setPlaybackRate: (rate) => set({ playbackRate: Math.max(0.25, Math.min(2, rate)) }),
}));
