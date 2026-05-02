import { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Fragment as FragmentType, SnapLine } from '@opendirector/core/types/timeline';
import { findNearestValidGroupDelta, findSnapPointsForDrag } from '@opendirector/core/utils/snap';
import { pixelToTime } from '@opendirector/core/utils/timeline';
import { clsx } from 'clsx';
import { Track } from './Track';
import { Playhead } from './Playhead';
import { TimeRuler } from './TimeRuler';
import { Toolbar } from './Toolbar';
import { SceneTrack } from './SceneTrack';
import { DraftFragment } from './DraftFragment';
import { PasteIndicator } from './PasteIndicator';
import { TrackDivider } from './TrackDivider';
import { FragmentContextMenu } from './FragmentContextMenu';
import { TrackContextMenu } from './TrackContextMenu';
import { SceneContextMenu } from './SceneContextMenu';
import { TrackAreaContextMenu } from './TrackAreaContextMenu';
import { SnapLines } from './SnapLine';
import { useTimelineShortcuts } from '../../hooks/useTimelineShortcuts';
import { TRACK_HEADER_WIDTH, TRACK_HEIGHT, MAX_TIMELINE_DURATION, TRACKS_AREA_OFFSET, TRACK_DIVIDER_HEIGHT } from './constants';
import './fragment-generating.css';

interface DragSelectionItem {
  fragmentId: string;
  prompt: string;
  start: number;
  duration: number;
  trackId: string;
  trackType: 'video' | 'audio';
  trackOrder: number;
}

interface DragGhost {
  anchorFragmentId: string;
  startX: number; // screen X
  anchorTrackType: 'video' | 'audio';
  items: DragSelectionItem[];
}

interface DragPreviewState {
  delta: number;
  trackIds: Record<string, string>;
  snapLines: SnapLine[];
}

// Unified context menu state
type ContextMenuState =
  | { type: 'fragment'; x: number; y: number; fragmentId: string; rightClickTime: number }
  | { type: 'scene'; x: number; y: number; rightClickTime: number; sceneId: string }
  | { type: 'trackArea'; x: number; y: number; rightClickTime: number; trackId: string }
  | { type: 'track'; x: number; y: number; trackId: string }
  | null;

export function TimelineCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const ghostElementRefs = useRef(new Map<string, HTMLDivElement>());
  const fragmentDragPreviewRef = useRef<DragPreviewState | null>(null);
  const activeSnapLinesSignatureRef = useRef('');

  const tracks = useTimelineStore((s) => s.tracks);
  const fragments = useTimelineStore((s) => s.fragments);
  const zoom = useTimelineStore((s) => s.zoom);
  const scroll = useTimelineStore((s) => s.scroll);
  const playhead = useTimelineStore((s) => s.playhead);
  const duration = useTimelineStore((s) => s.duration);
  const setScroll = useTimelineStore((s) => s.setScroll);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const toolMode = useTimelineStore((s) => s.toolMode);
  const selectionBox = useTimelineStore((s) => s.selectionBox);
  const startSelectionBox = useTimelineStore((s) => s.startSelectionBox);
  const updateSelectionBox = useTimelineStore((s) => s.updateSelectionBox);
  const confirmSelectionBox = useTimelineStore((s) => s.confirmSelectionBox);
  const cancelSelectionBox = useTimelineStore((s) => s.cancelSelectionBox);
  const draftFragment = useTimelineStore((s) => s.draftFragment);
  const draftPrompt = useTimelineStore((s) => s.draftPrompt);
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const nativePreviewTransportControlled = useTimelineStore(
    (s) => s.nativePreviewTransportControlled,
  );
  const setDraftFragment = useTimelineStore((s) => s.setDraftFragment);
  const confirmDraftFragment = useTimelineStore((s) => s.confirmDraftFragment);
  const pause = useTimelineStore((s) => s.pause);
  const clearAllSelections = useSelectionStore((s) => s.clear);
  const initializeDefaults = useTimelineStore((s) => s.initializeDefaults);
  const clipboard = useTimelineStore((s) => s.clipboard);
  const pasteIndicator = useTimelineStore((s) => s.pasteIndicator);
  const setPasteIndicator = useTimelineStore((s) => s.setPasteIndicator);
  const moveFragments = useTimelineStore((s) => s.moveFragments);
  const selectFragment = useSelectionStore((s) => s.selectFragment);
  const selectScene = useSelectionStore((s) => s.selectScene);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const snapThreshold = useTimelineStore((s) => s.snapThreshold);
  const setActiveSnapLines = useTimelineStore((s) => s.setActiveSnapLines);
  const clearActiveSnapLines = useTimelineStore((s) => s.clearActiveSnapLines);
  const activeSnapLines = useTimelineStore((s) => s.activeSnapLines);

  const [isDragging, setIsDragging] = useState(false);
  const [fragmentDrag, setFragmentDrag] = useState<DragGhost | null>(null);
  const [viewportWidth, setViewportWidth] = useState(800); // Default viewport width
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  const handleTrackContextMenu = useCallback((e: React.MouseEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ type: 'track', x: e.clientX, y: e.clientY, trackId });
  }, []);

  // Separate tracks by type for Jianying-style layout
  // Video tracks: order increases upward (order=0 at bottom, near divider)
  // Audio tracks: order increases downward (lowest audio order at top, near divider)
  const { videoTracks, audioTracks } = useMemo(() => {
    const videoTracks = tracks
      .filter((t) => t.type === 'video')
      .sort((a, b) => b.order - a.order); // Descending: highest order first (top)
    const audioTracks = tracks
      .filter((t) => t.type === 'audio')
      .sort((a, b) => a.order - b.order); // Ascending: lowest order first (top, near divider)
    return { videoTracks, audioTracks };
  }, [tracks]);

  // Calculate track position info for index conversion
  const videoTrackCount = videoTracks.length;
  const audioTrackCount = audioTracks.length;

  const draggedFragmentIds = useMemo(
    () => new Set(fragmentDrag?.items.map((item) => item.fragmentId) ?? []),
    [fragmentDrag]
  );

  // Helper: Get visual Y position for a track by trackId
  // Returns the Y offset from TRACKS_AREA_OFFSET for ghost/indicator positioning
  const getTrackVisualY = useCallback((trackId: string): number => {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return 0;

    if (track.type === 'video') {
      // Find position in videoTracks array (sorted descending by order)
      const visualIndex = videoTracks.findIndex((t) => t.id === track.id);
      return visualIndex * TRACK_HEIGHT;
    } else if (track.type === 'audio') {
      // Find position in audioTracks array (sorted ascending by order)
      const visualIndex = audioTracks.findIndex((t) => t.id === track.id);
      // Audio tracks start after video tracks and divider
      return videoTrackCount * TRACK_HEIGHT + TRACK_DIVIDER_HEIGHT + visualIndex * TRACK_HEIGHT;
    }
    return 0;
  }, [tracks, videoTracks, audioTracks, videoTrackCount]);

  const resolveTrackIdsForDrag = useCallback((
    items: DragSelectionItem[],
    anchorFragmentId: string,
    targetTrackIndex: number
  ): Record<string, string> => {
    const originalTrackIds = Object.fromEntries(items.map((item) => [item.fragmentId, item.trackId]));
    if (targetTrackIndex < 0) return originalTrackIds;

    const anchorItem = items.find((item) => item.fragmentId === anchorFragmentId) ?? null;
    const targetTrack = tracks[targetTrackIndex];
    if (!anchorItem || !targetTrack || targetTrack.type !== anchorItem.trackType) {
      return originalTrackIds;
    }

    const orderOffset = targetTrack.order - anchorItem.trackOrder;
    if (orderOffset === 0) return originalTrackIds;

    const resolvedEntries: Array<[string, string]> = [];
    for (const item of items) {
      const resolvedTrack = tracks.find(
        (track) => track.type === item.trackType && track.order === item.trackOrder + orderOffset
      );
      if (!resolvedTrack) {
        return originalTrackIds;
      }
      resolvedEntries.push([item.fragmentId, resolvedTrack.id]);
    }

    return Object.fromEntries(resolvedEntries);
  }, [tracks]);

  const applyFragmentDragPreview = useCallback((
    dragState: DragGhost,
    preview: DragPreviewState,
  ) => {
    fragmentDragPreviewRef.current = preview;
    const deltaX = (preview.delta / 1000) * zoom;

    dragState.items.forEach((item) => {
      const ghost = ghostElementRefs.current.get(item.fragmentId);
      if (!ghost) return;

      const targetTrackId = preview.trackIds[item.fragmentId] ?? item.trackId;
      const deltaY = getTrackVisualY(targetTrackId) - getTrackVisualY(item.trackId);
      ghost.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    });
  }, [getTrackVisualY, zoom]);

  const updateActiveSnapLines = useCallback((lines: SnapLine[]) => {
    const signature = lines.map((line) => `${line.type}:${line.time}`).join('|');
    if (signature === activeSnapLinesSignatureRef.current) {
      return;
    }

    activeSnapLinesSignatureRef.current = signature;
    if (lines.length > 0) {
      setActiveSnapLines(lines);
    } else {
      clearActiveSnapLines();
    }
  }, [clearActiveSnapLines, setActiveSnapLines]);

  // Initialize keyboard shortcuts
  useTimelineShortcuts();

  // Sync store scroll state to DOM scroll position
  // This is needed because setScroll() only updates the store,
  // but the actual DOM scroll position might be different.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Only sync if there's a difference to avoid triggering onScroll unnecessarily
    if (container.scrollLeft !== scroll.x || container.scrollTop !== scroll.y) {
      container.scrollLeft = scroll.x;
      container.scrollTop = scroll.y;
    }
  }, [scroll.x, scroll.y]);

  // Track viewport width for TimeRuler
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const updateViewportWidth = () => {
      setViewportWidth(container.clientWidth);
    };

    updateViewportWidth();

    const resizeObserver = new ResizeObserver(updateViewportWidth);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // Playback animation: write playhead ref at 60fps, sync to Zustand at ~10fps.
  // When the native preview session has taken over transport ownership, Rust
  // drives playhead timing and pushes position updates back into the store.
  useEffect(() => {
    if (!isPlaying) return;
    if (nativePreviewTransportControlled) {
      return;
    }

    // When no native preview session is active, JS rAF drives playhead updates.
    let lastTime = performance.now();
    let animationId: number;
    let cancelled = false;
    let lastSyncTime = 0;
    const SYNC_INTERVAL = 100; // ms — sync ref → Zustand at ~10fps for UI

    const animate = (currentTime: number) => {
      if (cancelled) return;

      const state = useTimelineStore.getState();
      if (!state.isPlaying) return;

      const delta = currentTime - lastTime;
      lastTime = currentTime;

      const currentPlayhead = state.getPlayheadRef();
      const maxDuration = Math.max(state.duration, 60000);
      const newPlayhead = currentPlayhead + delta;

      if (newPlayhead >= maxDuration) {
        state.setPlayhead(maxDuration);
        state.pause();
      } else {
        // Write ref immediately (no Zustand update, zero re-renders)
        state.setPlayheadRefOnly(newPlayhead);

        // Low-freq sync to Zustand for UI updates (time code, playhead line, etc.)
        if (currentTime - lastSyncTime >= SYNC_INTERVAL) {
          state.setPlayhead(newPlayhead);
          lastSyncTime = currentTime;
        }

        animationId = requestAnimationFrame(animate);
      }
    };

    animationId = requestAnimationFrame(animate);
    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
    };
  }, [isPlaying, nativePreviewTransportControlled]);

  // Handle fragment drag start
  const handleFragmentDragStart = useCallback((e: React.MouseEvent, fragment: FragmentType) => {
    e.preventDefault();

    const track = tracks.find((t) => t.id === fragment.trackId);
    if (!track) return;

    const selectionState = useSelectionStore.getState();
    const dragIds = selectionState.primaryType === 'fragment' && selectionState.primaryIds.includes(fragment.id)
      ? selectionState.primaryIds
      : [fragment.id];

    const items: DragSelectionItem[] = dragIds
      .map((id) => {
        const selectedFragment = fragments.find((candidate) => candidate.id === id);
        if (!selectedFragment) return null;

        const selectedTrack = tracks.find((candidate) => candidate.id === selectedFragment.trackId);
        if (!selectedTrack) return null;

        return {
          fragmentId: selectedFragment.id,
          prompt: selectedFragment.prompt,
          start: selectedFragment.start,
          duration: selectedFragment.duration,
          trackId: selectedFragment.trackId,
          trackType: selectedTrack.type,
          trackOrder: selectedTrack.order,
        };
      })
      .filter((item): item is DragSelectionItem => item !== null);

    if (items.length === 0) return;

    setFragmentDrag({
      anchorFragmentId: fragment.id,
      startX: e.clientX,
      anchorTrackType: track.type,
      items,
    });
    fragmentDragPreviewRef.current = {
      delta: 0,
      trackIds: Object.fromEntries(items.map((item) => [item.fragmentId, item.trackId])),
      snapLines: [],
    };
    activeSnapLinesSignatureRef.current = '';

    // Selection is handled by Fragment component's handleMouseDown
  }, [fragments, tracks]);

  // Find the nearest valid track for the fragment type
  // Returns Store array index for the fragment type
  //
  // Layout:
  // - Video tracks: rendered top to bottom in descending order (highest order at top)
  // - TrackDivider: separator between video and audio
  // - Audio tracks: rendered top to bottom in ascending order (lowest order at top, near divider)
  const findNearestValidTrack = useCallback((clientY: number, trackType: 'video' | 'audio') => {
    const containerRect = scrollContainerRef.current?.getBoundingClientRect();
    if (!containerRect) return -1;

    const contentY = clientY - containerRect.top + scroll.y;
    const relativeY = contentY - TRACKS_AREA_OFFSET;

    if (relativeY < 0) return -1;

    // Calculate boundaries
    const videoAreaHeight = videoTrackCount * TRACK_HEIGHT;
    const dividerTop = videoAreaHeight;
    const dividerBottom = videoAreaHeight + TRACK_DIVIDER_HEIGHT;
    const audioAreaStart = dividerBottom;

    let hoveredTrack: { track: typeof tracks[0]; storeIndex: number } | null = null;

    if (relativeY < dividerTop) {
      // Hovering in video tracks area
      const visualIndex = Math.floor(relativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < videoTrackCount) {
        hoveredTrack = {
          track: videoTracks[visualIndex],
          storeIndex: tracks.findIndex((t) => t.id === videoTracks[visualIndex].id),
        };
      }
    } else if (relativeY >= audioAreaStart) {
      // Hovering in audio tracks area
      const audioRelativeY = relativeY - audioAreaStart;
      const visualIndex = Math.floor(audioRelativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < audioTrackCount) {
        hoveredTrack = {
          track: audioTracks[visualIndex],
          storeIndex: tracks.findIndex((t) => t.id === audioTracks[visualIndex].id),
        };
      }
    }
    // Note: hovering on divider (dividerTop <= relativeY < audioAreaStart) returns null

    // If hovering over matching type, use that track
    if (hoveredTrack && hoveredTrack.track.type === trackType) {
      return hoveredTrack.storeIndex;
    }

    // Find the nearest track of the same type
    const sameTypeTracks = tracks
      .map((t, i) => ({ track: t, index: i }))
      .filter(({ track }) => track.type === trackType);

    if (sameTypeTracks.length === 0) return -1;

    // If no track is hovered (e.g., on divider or outside), return first of same type
    if (!hoveredTrack) {
      return sameTypeTracks[0].index;
    }

    // Find nearest track of same type by store index distance
    let nearestIndex = sameTypeTracks[0].index;
    let nearestDistance = Math.abs(hoveredTrack.storeIndex - nearestIndex);

    for (const { index } of sameTypeTracks) {
      const distance = Math.abs(hoveredTrack.storeIndex - index);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }

    return nearestIndex;
  }, [tracks, videoTracks, audioTracks, videoTrackCount, audioTrackCount, scroll.y]);

  const computeDragPreview = useCallback((dragState: DragGhost, clientX: number, clientY: number) => {
    const store = useTimelineStore.getState();
    const targetTrackIndex = findNearestValidTrack(clientY, dragState.anchorTrackType);
    const nextTrackIds = resolveTrackIdsForDrag(dragState.items, dragState.anchorFragmentId, targetTrackIndex);
    const groupMoveItems = dragState.items.map((item) => ({
      fragmentId: item.fragmentId,
      start: item.start,
      duration: item.duration,
      targetTrackId: nextTrackIds[item.fragmentId] ?? item.trackId,
    }));
    const minDelta = -Math.min(...dragState.items.map((item) => item.start));
    const proposedDelta = Math.max(minDelta, pixelToTime(clientX - dragState.startX, zoom));
    const excludeFragmentIds = dragState.items.map((item) => item.fragmentId);

    let nextDelta = proposedDelta;
    let nextSnapLines: SnapLine[] = [];
    if (snapEnabled) {
      let bestCandidate: { delta: number; distance: number; snapLines: SnapLine[] } | null = null;
      const orderedItems = [
        ...dragState.items.filter((item) => item.fragmentId === dragState.anchorFragmentId),
        ...dragState.items.filter((item) => item.fragmentId !== dragState.anchorFragmentId),
      ];

      for (const item of orderedItems) {
        const snapResult = findSnapPointsForDrag(
          item.start + proposedDelta,
          item.duration,
          {
            playhead: store.getPlayheadRef(),
            fragments: store.fragments,
            scenes: store.scenes,
            excludeFragmentIds,
            trackId: nextTrackIds[item.fragmentId],
          },
          zoom,
          snapThreshold
        );

        if (snapResult.snapLines.length === 0) continue;

        const candidateDelta = snapResult.time - item.start;
        if (candidateDelta < minDelta) continue;

        const candidateGroupResult = findNearestValidGroupDelta(
          candidateDelta,
          groupMoveItems,
          store.fragments,
          minDelta,
        );
        if (candidateGroupResult.adjusted || candidateGroupResult.delta !== candidateDelta) {
          continue;
        }

        const distance = Math.abs(candidateDelta - proposedDelta);
        if (!bestCandidate || distance < bestCandidate.distance) {
          bestCandidate = {
            delta: candidateDelta,
            distance,
            snapLines: snapResult.snapLines,
          };
        }
      }

      if (bestCandidate) {
        nextDelta = bestCandidate.delta;
        nextSnapLines = bestCandidate.snapLines;
      }
    }

    const overlapResult = findNearestValidGroupDelta(
      nextDelta,
      groupMoveItems,
      store.fragments,
      minDelta
    );

    if (overlapResult.adjusted && overlapResult.delta !== nextDelta) {
      nextSnapLines = [];
    }

    return {
      delta: overlapResult.delta,
      trackIds: nextTrackIds,
      snapLines: nextSnapLines,
    };
  }, [findNearestValidTrack, resolveTrackIdsForDrag, snapEnabled, snapThreshold, zoom]);

  // Handle global mouse move for fragment drag
  useEffect(() => {
    if (!fragmentDrag) return;

    const handleMouseMove = (e: MouseEvent) => {
      const preview = computeDragPreview(fragmentDrag, e.clientX, e.clientY);
      updateActiveSnapLines(preview.snapLines);
      applyFragmentDragPreview(fragmentDrag, preview);
    };

    const handleFragmentDragMouseUp = (e: MouseEvent) => {
      if (!fragmentDrag) return;

      const preview = computeDragPreview(fragmentDrag, e.clientX, e.clientY);
      updateActiveSnapLines([]);
      const updates = fragmentDrag.items
        .map((item) => ({
          id: item.fragmentId,
          newStart: item.start + preview.delta,
          newTrackId: preview.trackIds[item.fragmentId] ?? item.trackId,
        }))
        .filter((update) => {
          const currentFragment = fragments.find((fragment) => fragment.id === update.id);
          if (!currentFragment) return false;
          return currentFragment.start !== update.newStart || currentFragment.trackId !== update.newTrackId;
        });

      if (updates.length > 0) {
        moveFragments(updates);
      }

      fragmentDragPreviewRef.current = null;
      ghostElementRefs.current.clear();
      setFragmentDrag(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleFragmentDragMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleFragmentDragMouseUp);
    };
  }, [applyFragmentDragPreview, computeDragPreview, fragmentDrag, fragments, moveFragments, updateActiveSnapLines]);

  useEffect(() => {
    if (fragmentDrag) {
      applyFragmentDragPreview(fragmentDrag, fragmentDragPreviewRef.current ?? {
        delta: 0,
        trackIds: Object.fromEntries(
          fragmentDrag.items.map((item) => [item.fragmentId, item.trackId]),
        ),
        snapLines: [],
      });
      return;
    }

    fragmentDragPreviewRef.current = null;
    ghostElementRefs.current.clear();
    updateActiveSnapLines([]);
  }, [applyFragmentDragPreview, fragmentDrag, updateActiveSnapLines]);

  // Handle scroll
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScroll(e.currentTarget.scrollLeft, e.currentTarget.scrollTop);
  };

  // Handle click to move playhead
  const handleTimeRulerClick = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;

    const rect = scrollContainerRef.current.getBoundingClientRect();
    // TimeRuler uses natural scroll, so click position is in viewport coordinates.
    // Need to add scroll.x to convert to content coordinates.
    const viewportX = e.clientX - rect.left - TRACK_HEADER_WIDTH;
    const contentX = viewportX + scroll.x;
    const newTime = (contentX / zoom) * 1000;
    if (isPlaying) {
      pause();
    }
    setPlayhead(Math.max(0, newTime));
  };

  // Helper: calculate right-click time from clientX
  const getRightClickTime = useCallback((clientX: number): number => {
    const rect = scrollContainerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const currentScrollX = scrollContainerRef.current?.scrollLeft ?? scroll.x;
    const contentX = clientX - rect.left - TRACK_HEADER_WIDTH + currentScrollX;
    return (contentX / zoom) * 1000;
  }, [zoom, scroll.x]);

  // Helper: determine track from Y coordinate
  const getTrackIdAtY = useCallback((clientY: number): string | null => {
    const containerRect = scrollContainerRef.current?.getBoundingClientRect();
    if (!containerRect) return null;

    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;
    const contentY = clientY - containerRect.top + currentScrollY;
    const relativeY = contentY - TRACKS_AREA_OFFSET;

    if (relativeY < 0) return null;

    const videoAreaHeight = videoTrackCount * TRACK_HEIGHT;
    const audioAreaStart = videoAreaHeight + TRACK_DIVIDER_HEIGHT;

    if (relativeY < videoAreaHeight) {
      const visualIndex = Math.floor(relativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < videoTrackCount) {
        return videoTracks[visualIndex].id;
      }
    } else if (relativeY >= audioAreaStart) {
      const audioRelativeY = relativeY - audioAreaStart;
      const visualIndex = Math.floor(audioRelativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < audioTrackCount) {
        return audioTracks[visualIndex].id;
      }
    }

    return null;
  }, [videoTracks, audioTracks, videoTrackCount, audioTrackCount, scroll.y]);

  // Handle right-click context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    // Always suppress browser default
    e.preventDefault();

    const target = e.target as HTMLElement;

    // 1. Check if right-clicked on a fragment
    const fragmentEl = target.closest('[data-fragment-id]');
    if (fragmentEl) {
      const fragmentId = fragmentEl.getAttribute('data-fragment-id');
      if (fragmentId) {
        // Select the fragment if not already selected (right-click doesn't trigger mousedown)
        const selState = useSelectionStore.getState();
        if (!(selState.primaryType === 'fragment' && selState.primaryIds.includes(fragmentId))) {
          selectFragment(fragmentId);
        }
        const rightClickTime = getRightClickTime(e.clientX);
        setContextMenu({ type: 'fragment', x: e.clientX, y: e.clientY, fragmentId, rightClickTime });
        return;
      }
    }

    // 2. Check if right-clicked on a scene
    const sceneEl = target.closest('[data-scene]');
    if (sceneEl) {
      const sceneId = sceneEl.getAttribute('data-scene');
      if (sceneId) {
        const selState = useSelectionStore.getState();
        if (!(selState.primaryType === 'scene' && selState.primaryIds.includes(sceneId))) {
          selectScene(sceneId);
        }
        const rightClickTime = getRightClickTime(e.clientX);
        setContextMenu({ type: 'scene', x: e.clientX, y: e.clientY, rightClickTime, sceneId });
        return;
      }
    }

    // 3. Check if right-clicked in a track area (not on header)
    const trackId = getTrackIdAtY(e.clientY);
    if (trackId) {
      const rightClickTime = getRightClickTime(e.clientX);
      setContextMenu({ type: 'trackArea', x: e.clientX, y: e.clientY, rightClickTime, trackId });
      return;
    }

    // 4. Time ruler or empty area — close any open menu
    setContextMenu(null);
  };

  // Handle mouse down for selection box
  const handleMouseDown = (e: React.MouseEvent) => {
    // Close context menu on any left-click
    setContextMenu(null);

    const isTimeRulerMouseDown =
      e.target instanceof HTMLElement && e.target.closest('[data-testid="time-ruler"]');

    if (isTimeRulerMouseDown && !draftFragment) {
      return;
    }

    if (!isTimeRulerMouseDown && isPlaying) {
      pause();
    }

    if (draftFragment) {
      // If user has typed a prompt, auto-create the fragment before clearing
      if (draftPrompt.trim()) {
        confirmDraftFragment(draftPrompt.trim());
      } else {
        setDraftFragment(null);
      }
      return;
    }

    if (toolMode !== 'select') return;
    if (fragmentDrag) return; // Don't start selection box during fragment drag

    const rect = scrollContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // IMPORTANT: Get scroll position directly from DOM, not from React state.
    // React batches state updates, so scroll.x might be stale when this handler runs
    // immediately after a scroll event (e.g., user scrolls then clicks without releasing mouse).
    // Using DOM scrollLeft/scrollTop ensures we always have the current scroll position.
    const currentScrollX = scrollContainerRef.current?.scrollLeft ?? scroll.x;
    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;

    const x = e.clientX - rect.left - TRACK_HEADER_WIDTH + currentScrollX;
    const y = e.clientY - rect.top + currentScrollY;

    setIsDragging(true);
    startSelectionBox(x, y);
  };

  // Handle mouse move for selection box
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || toolMode !== 'select') return;
    if (fragmentDrag) return;

    const rect = scrollContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // IMPORTANT: Get scroll position directly from DOM, not from React state.
    // Same reason as handleMouseDown - ensures current scroll position.
    const currentScrollX = scrollContainerRef.current?.scrollLeft ?? scroll.x;
    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;

    const x = e.clientX - rect.left - TRACK_HEADER_WIDTH + currentScrollX;
    const y = e.clientY - rect.top + currentScrollY;

    updateSelectionBox(x, y);
  };

  // Handle mouse up for selection box
  const handleMouseUp = (e: React.MouseEvent) => {
    // Helper function to set paste indicator from click position
    const trySetPasteIndicator = () => {
    if (!clipboard || clipboard.fragments.length === 0) return;

    const rect = scrollContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentScrollX = scrollContainerRef.current?.scrollLeft ?? scroll.x;
    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;

    const x = e.clientX - rect.left - TRACK_HEADER_WIDTH + currentScrollX;
    const y = e.clientY - rect.top + currentScrollY;

    // Calculate click time
    const clickTime = (x / zoom) * 1000;

    // Determine track from Y position using grouped layout
    const relativeY = y - TRACKS_AREA_OFFSET;

    if (relativeY < 0) return;

    // Calculate boundaries for grouped layout
    const videoAreaHeight = videoTrackCount * TRACK_HEIGHT;
    const audioAreaStart = videoAreaHeight + TRACK_DIVIDER_HEIGHT;

    let clickedTrackId: string | null = null;

    if (relativeY < videoAreaHeight) {
      // Clicked in video tracks area
      const visualIndex = Math.floor(relativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < videoTrackCount) {
        clickedTrackId = videoTracks[visualIndex].id;
      }
    } else if (relativeY >= audioAreaStart) {
      // Clicked in audio tracks area
      const audioRelativeY = relativeY - audioAreaStart;
      const visualIndex = Math.floor(audioRelativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < audioTrackCount) {
        clickedTrackId = audioTracks[visualIndex].id;
      }
    }
    // Note: clicking on divider does nothing

    if (!clickedTrackId) return;

    // Check if click is on an existing fragment
    const clickedOnFragment = fragments.some(f => {
      if (f.trackId !== clickedTrackId) return false;
      const fragStart = (f.start / 1000) * zoom;
      const fragEnd = ((f.start + f.duration) / 1000) * zoom;
      return x >= fragStart && x <= fragEnd;
    });

    // Allow setting paste indicator if not clicking on an existing fragment
    if (!clickedOnFragment) {
      setPasteIndicator({ time: clickTime, trackId: clickedTrackId });
    }
  };

    // Handle selection box confirmation if dragging occurred with sufficient width
    let selectionConfirmed = false;
    if (isDragging && selectionBox) {
      const minX = Math.min(selectionBox.startX, selectionBox.endX);
      const maxX = Math.max(selectionBox.startX, selectionBox.endX);
      const width = maxX - minX;

      if (width >= 10) {
        confirmSelectionBox();
        selectionConfirmed = true;
      } else {
        // Small drag - try to set paste indicator
        trySetPasteIndicator();
      }
    } else {
      // No selection box - just a click, try to set paste indicator
      trySetPasteIndicator();
    }

    // Only clear selections if we didn't just confirm a selection box
    // AND the click wasn't on a fragment (fragments handle their own selection)
    // Check if the Event target is a fragment element
    const target = e.target as HTMLElement;
    const clickedOnFragment = target.closest('[data-fragment-id]');

    // Don't clear selection if we're in the middle of a fragment drag
    // (Fragment is temporarily removed from DOM during drag, so clickedOnFragment will be false)
    // The global mouseup handler for fragment drag will handle the final selection
    const isFragmentDragInProgress = fragmentDrag !== null;

    if (!selectionConfirmed && !clickedOnFragment && !isFragmentDragInProgress) {
      clearAllSelections();
    }
    cancelSelectionBox();
    setIsDragging(false);
  };

  // Initialize default tracks and scene on mount
  useEffect(() => {
    initializeDefaults();
  }, [initializeDefaults]);

  // Calculate timeline width based on actual content duration and zoom
  // Add buffer for editing space, but cap at MAX_TIMELINE_DURATION
  // Use at least 2 minutes of visible content for usability
  const minVisibleDuration = 120000; // 2 minutes minimum visible duration
  const bufferDuration = Math.max(60000, duration * 0.2); // 20% buffer or 1 minute minimum
  const contentDuration = Math.max(duration + bufferDuration, minVisibleDuration);
  const timelineDuration = Math.min(contentDuration, MAX_TIMELINE_DURATION);
  const timelineWidth = Math.max(timelineDuration * zoom / 1000 + 200, 2000);
  const playheadX = (playhead / 1000) * zoom;

  // Calculate content height for playhead (time ruler + scene track + video tracks + divider + audio tracks)
  const contentHeight = TRACKS_AREA_OFFSET + (videoTrackCount + audioTrackCount) * TRACK_HEIGHT + TRACK_DIVIDER_HEIGHT;

  // Handle mouse leave - only cancel active selection box drag, don't clear existing selections
  const handleMouseLeave = () => {
    // Only cancel selection box if we're in the middle of dragging one
    if (isDragging && selectionBox) {
      cancelSelectionBox();
      setIsDragging(false);
    }
    // Don't clear existing fragment/scene selections when mouse leaves
  };

  return (
    <div className="flex flex-col h-full">
      <Toolbar />

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto bg-zinc-950 relative"
        data-testid="timeline-canvas"
        onScroll={handleScroll}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
      >
        {/* Playhead - positioned in content coordinates, natural scroll */}
        <Playhead x={playheadX} contentHeight={contentHeight} />

        {/* Time Ruler */}
        <TimeRuler
          width={timelineWidth}
          zoom={zoom}
          scrollX={scroll.x}
          viewportWidth={viewportWidth}
          onClick={handleTimeRulerClick}
        />

        {/* Scene Track */}
        <SceneTrack
          width={timelineWidth}
          zoom={zoom}
          scrollX={scroll.x}
          viewportWidth={viewportWidth}
        />

        {/* Tracks Container - scrolls naturally with the scroll container */}
        {/* Jianying-style layout:
            - Video tracks: order increases upward (highest order at top)
            - TrackDivider: visual separator
            - Audio tracks: order increases downward (lowest order at top, near divider)
        */}
        <div
          ref={containerRef}
          className="relative"
          style={{ width: timelineWidth + viewportWidth }}
          data-testid="tracks-container"
        >
          {/* Video Tracks - sorted descending by order (highest at top) */}
          {videoTracks.map((track) => (
            <Track
              key={track.id}
              track={track}
              fragments={fragments.filter((f) => f.trackId === track.id && !draggedFragmentIds.has(f.id))}
              zoom={zoom}
              width={timelineWidth}
              scrollX={scroll.x}
              viewportWidth={viewportWidth}
              onFragmentDragStart={handleFragmentDragStart}
              onTrackContextMenu={(e) => handleTrackContextMenu(e, track.id)}
            />
          ))}

          {/* Track Divider - separator between video and audio */}
          {(videoTrackCount > 0 || audioTrackCount > 0) && (
            <TrackDivider width={timelineWidth} viewportWidth={viewportWidth} />
          )}

          {/* Audio Tracks - sorted ascending by order (lowest at top, near divider) */}
          {audioTracks.map((track) => (
            <Track
              key={track.id}
              track={track}
              fragments={fragments.filter((f) => f.trackId === track.id && !draggedFragmentIds.has(f.id))}
              zoom={zoom}
              width={timelineWidth}
              scrollX={scroll.x}
              viewportWidth={viewportWidth}
              onFragmentDragStart={handleFragmentDragStart}
              onTrackContextMenu={(e) => handleTrackContextMenu(e, track.id)}
            />
          ))}
        </div>

        {/* Drag Ghosts - render in content coordinates */}
        {fragmentDrag && fragmentDrag.items.map((item) => (
          <div
            key={item.fragmentId}
            ref={(element) => {
              if (element) {
                ghostElementRefs.current.set(item.fragmentId, element);
              } else {
                ghostElementRefs.current.delete(item.fragmentId);
              }
            }}
            className={clsx(
              'absolute rounded border z-50 pointer-events-none',
              item.trackType === 'audio'
                ? 'border-blue-400 bg-blue-900/50'
                : 'border-amber-400 bg-amber-900/50',
            )}
            style={{
              left: (item.start / 1000) * zoom + TRACK_HEADER_WIDTH,
              width: Math.max((item.duration / 1000) * zoom, 20),
              top: TRACKS_AREA_OFFSET + getTrackVisualY(item.trackId) + 2,
              height: TRACK_HEIGHT - 4,
            }}
          >
            <div className="absolute inset-x-0 top-0 p-1 overflow-hidden pointer-events-none">
              <p className="text-xs text-white truncate">
                {item.prompt || 'Empty fragment'}
              </p>
            </div>
          </div>
        ))}

        {/* Draft Fragment */}
        {draftFragment && (
          <DraftFragment
            draft={draftFragment}
            zoom={zoom}
            scrollX={scroll.x}
            scrollY={scroll.y}
            visualY={getTrackVisualY(draftFragment.trackId)}
          />
        )}

        {/* Paste Indicator */}
        {pasteIndicator && (
          <PasteIndicator
            x={(pasteIndicator.time / 1000) * zoom}
            visualY={pasteIndicator.trackId !== undefined ? getTrackVisualY(pasteIndicator.trackId) : undefined}
          />
        )}

        {/* Selection Box - render in content coordinates */}
        {selectionBox && (
          <div
            className="absolute pointer-events-none border border-blue-500 border-dashed bg-blue-500/10 z-20"
            style={{
              left: TRACK_HEADER_WIDTH + Math.min(selectionBox.startX, selectionBox.endX),
              top: Math.min(selectionBox.startY, selectionBox.endY),
              width: Math.abs(selectionBox.endX - selectionBox.startX),
              height: Math.abs(selectionBox.endY - selectionBox.startY),
            }}
          />
        )}

        {/* Snap Lines - render for visual feedback during drag/resize */}
        <SnapLines snapLines={activeSnapLines} zoom={zoom} />
      </div>

      {/* Context Menus */}
      {contextMenu?.type === 'fragment' && (
        <FragmentContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          fragmentId={contextMenu.fragmentId}
          rightClickTime={contextMenu.rightClickTime}
          onClose={() => setContextMenu(null)}
        />
      )}
      {contextMenu?.type === 'scene' && (
        <SceneContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sceneId={contextMenu.sceneId}
          rightClickTime={contextMenu.rightClickTime}
          onClose={() => setContextMenu(null)}
        />
      )}
      {contextMenu?.type === 'trackArea' && (
        <TrackAreaContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          trackId={contextMenu.trackId}
          rightClickTime={contextMenu.rightClickTime}
          onClose={() => setContextMenu(null)}
        />
      )}
      {contextMenu?.type === 'track' && (
        <TrackContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          trackId={contextMenu.trackId}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
