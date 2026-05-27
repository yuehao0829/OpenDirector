import { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Fragment as FragmentType, SnapLine } from '@opendirector/core/types/timeline';
import { findNearestValidGroupDelta, findSnapPointsForDrag } from '@opendirector/core/utils/snap';
import { pixelToTime } from '@opendirector/core/utils/timeline';
import { clsx } from 'clsx';
import { Track } from './Track';
import { TrackHeader } from './TrackHeader';
import { PlayheadHandle, PlayheadLine } from './Playhead';
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
import { Layers } from 'lucide-react';
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
  const rulerScrollRef = useRef<HTMLDivElement>(null);
  const headersScrollRef = useRef<HTMLDivElement>(null);
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
  const [viewportWidth, setViewportWidth] = useState(800);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  const handleTrackContextMenu = useCallback((e: React.MouseEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ type: 'track', x: e.clientX, y: e.clientY, trackId });
  }, []);

  // Separate tracks by type for Jianying-style layout
  const { videoTracks, audioTracks } = useMemo(() => {
    const videoTracks = tracks
      .filter((t) => t.type === 'video')
      .sort((a, b) => b.order - a.order);
    const audioTracks = tracks
      .filter((t) => t.type === 'audio')
      .sort((a, b) => a.order - b.order);
    return { videoTracks, audioTracks };
  }, [tracks]);

  const videoTrackCount = videoTracks.length;
  const audioTrackCount = audioTracks.length;

  const draggedFragmentIds = useMemo(
    () => new Set(fragmentDrag?.items.map((item) => item.fragmentId) ?? []),
    [fragmentDrag]
  );

  // Helper: Get visual Y position for a track by trackId
  const getTrackVisualY = useCallback((trackId: string): number => {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return 0;

    if (track.type === 'video') {
      const visualIndex = videoTracks.findIndex((t) => t.id === track.id);
      return visualIndex * TRACK_HEIGHT;
    } else if (track.type === 'audio') {
      const visualIndex = audioTracks.findIndex((t) => t.id === track.id);
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

  // Sync ruler and header scroll containers to match the given scroll position
  const syncAuxScroll = useCallback((scrollLeft: number, scrollTop: number) => {
    if (rulerScrollRef.current) {
      rulerScrollRef.current.scrollLeft = scrollLeft;
    }
    if (headersScrollRef.current) {
      headersScrollRef.current.scrollTop = scrollTop;
    }
  }, []);

  // Scroll synchronization: content area drives ruler and headers
  // Guard pattern: compare against store state to avoid re-emitting scroll
  // values that were just written by useLayoutEffect (scroll events fire
  // asynchronously after useLayoutEffect, so a simple ref guard can't work).
  const handleContentScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const storeScroll = useTimelineStore.getState().scroll;

    syncAuxScroll(target.scrollLeft, target.scrollTop);

    // Skip setScroll if the values match what the store already has
    // (this happens when useLayoutEffect wrote scrollLeft/scrollTop and
    // the browser asynchronously dispatches a scroll event for it)
    if (Math.abs(target.scrollLeft - storeScroll.x) < 1 && Math.abs(target.scrollTop - storeScroll.y) < 1) {
      return;
    }

    setScroll(target.scrollLeft, target.scrollTop);
  }, [setScroll, syncAuxScroll]);

  // Sync store scroll state to DOM scroll position
  // Must use useLayoutEffect to avoid a one-frame desync when zoom changes:
  // zoom + scroll update atomically in Zustand, but DOM scrollLeft is stale
  // until we write it — useLayoutEffect writes before the browser paints.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (container.scrollLeft !== scroll.x || container.scrollTop !== scroll.y) {
      container.scrollLeft = scroll.x;
      container.scrollTop = scroll.y;
      syncAuxScroll(scroll.x, scroll.y);
    }
  }, [scroll.x, scroll.y, syncAuxScroll]);

  // Track viewport width from content scroll area
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

  // Playback animation
  useEffect(() => {
    if (!isPlaying) return;
    if (nativePreviewTransportControlled) {
      return;
    }

    let lastTime = performance.now();
    let animationId: number;
    let cancelled = false;
    let lastSyncTime = 0;
    const SYNC_INTERVAL = 100;

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
        state.setPlayheadRefOnly(newPlayhead);

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
  }, [fragments, tracks]);

  // Find the nearest valid track for the fragment type
  const findNearestValidTrack = useCallback((clientY: number, trackType: 'video' | 'audio') => {
    const containerRect = scrollContainerRef.current?.getBoundingClientRect();
    if (!containerRect) return -1;

    const contentY = clientY - containerRect.top + scroll.y;
    const relativeY = contentY;

    if (relativeY < 0) return -1;

    const videoAreaHeight = videoTrackCount * TRACK_HEIGHT;
    const dividerTop = videoAreaHeight;
    const dividerBottom = videoAreaHeight + TRACK_DIVIDER_HEIGHT;
    const audioAreaStart = dividerBottom;

    let hoveredTrack: { track: typeof tracks[0]; storeIndex: number } | null = null;

    if (relativeY < dividerTop) {
      const visualIndex = Math.floor(relativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < videoTrackCount) {
        hoveredTrack = {
          track: videoTracks[visualIndex],
          storeIndex: tracks.findIndex((t) => t.id === videoTracks[visualIndex].id),
        };
      }
    } else if (relativeY >= audioAreaStart) {
      const audioRelativeY = relativeY - audioAreaStart;
      const visualIndex = Math.floor(audioRelativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < audioTrackCount) {
        hoveredTrack = {
          track: audioTracks[visualIndex],
          storeIndex: tracks.findIndex((t) => t.id === audioTracks[visualIndex].id),
        };
      }
    }

    if (hoveredTrack && hoveredTrack.track.type === trackType) {
      return hoveredTrack.storeIndex;
    }

    const sameTypeTracks = tracks
      .map((t, i) => ({ track: t, index: i }))
      .filter(({ track }) => track.type === trackType);

    if (sameTypeTracks.length === 0) return -1;

    if (!hoveredTrack) {
      return sameTypeTracks[0].index;
    }

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

  // Helper: convert clientX to timeline time from a given scroll container
  const clientXToTime = useCallback((clientX: number, containerRef: React.RefObject<HTMLDivElement | null>): number => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const contentX = clientX - rect.left + el.scrollLeft;
    return pixelToTime(contentX, zoom);
  }, [zoom]);

  // Handle click to move playhead (from ruler area)
  const handleTimeRulerClick = (e: React.MouseEvent) => {
    if (!rulerScrollRef.current) return;
    const newTime = clientXToTime(e.clientX, rulerScrollRef);
    if (isPlaying) {
      pause();
    }
    setPlayhead(Math.max(0, newTime));
  };

  // Helper: determine track from Y coordinate
  const getTrackIdAtY = useCallback((clientY: number): string | null => {
    const containerRect = scrollContainerRef.current?.getBoundingClientRect();
    if (!containerRect) return null;

    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;
    const contentY = clientY - containerRect.top + currentScrollY;
    const relativeY = contentY;

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
    e.preventDefault();

    const target = e.target as HTMLElement;

    // 1. Check if right-clicked on a fragment
    const fragmentEl = target.closest('[data-fragment-id]');
    if (fragmentEl) {
      const fragmentId = fragmentEl.getAttribute('data-fragment-id');
      if (fragmentId) {
        const selState = useSelectionStore.getState();
        if (!(selState.primaryType === 'fragment' && selState.primaryIds.includes(fragmentId))) {
          selectFragment(fragmentId);
        }
        const rightClickTime = clientXToTime(e.clientX, scrollContainerRef);
        setContextMenu({ type: 'fragment', x: e.clientX, y: e.clientY, fragmentId, rightClickTime });
        return;
      }
    }

    // 2. Check if right-clicked on a scene
    const sceneEl = target.closest('[data-scene]');
    if (sceneEl) {
      const sceneId = sceneEl.getAttribute('data-scene');
      if (sceneId) {
        handleSceneSelect(sceneId);
        const rightClickTime = clientXToTime(e.clientX, scrollContainerRef);
        setContextMenu({ type: 'scene', x: e.clientX, y: e.clientY, rightClickTime, sceneId });
        return;
      }
    }

    // 3. Check if right-clicked in a track area (not on header)
    const trackId = getTrackIdAtY(e.clientY);
    if (trackId) {
      const rightClickTime = clientXToTime(e.clientX, scrollContainerRef);
      setContextMenu({ type: 'trackArea', x: e.clientX, y: e.clientY, rightClickTime, trackId });
      return;
    }

    // 4. Time ruler or empty area — close any open menu
    setContextMenu(null);
  };

  // Select scene if not already the primary selection
  const handleSceneSelect = useCallback((sceneId: string) => {
    const selState = useSelectionStore.getState();
    if (!(selState.primaryType === 'scene' && selState.primaryIds.includes(sceneId))) {
      selectScene(sceneId);
    }
  }, [selectScene]);

  // Separate handler because the ruler is in its own scroll container;
  // clientXToTime must use rulerScrollRef, not the main content container.
  const handleRulerContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();

    const target = e.target as HTMLElement;
    const sceneEl = target.closest('[data-scene]');
    if (sceneEl) {
      const sceneId = sceneEl.getAttribute('data-scene');
      if (sceneId) {
        handleSceneSelect(sceneId);
        const rightClickTime = clientXToTime(e.clientX, rulerScrollRef);
        setContextMenu({ type: 'scene', x: e.clientX, y: e.clientY, rightClickTime, sceneId });
        return;
      }
    }

    setContextMenu(null);
  };

  // Handle right-click in headers area (for track header context menus)
  const handleHeadersContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const trackHeaderEl = target.closest('[data-track-id]');
    if (trackHeaderEl) {
      const trackId = trackHeaderEl.getAttribute('data-track-id');
      if (trackId) {
        setContextMenu({ type: 'track', x: e.clientX, y: e.clientY, trackId });
        return;
      }
    }
    setContextMenu(null);
  }, []);

  // Handle mouse down for selection box
  const handleMouseDown = (e: React.MouseEvent) => {
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
      if (draftPrompt.trim()) {
        confirmDraftFragment(draftPrompt.trim());
      } else {
        setDraftFragment(null);
      }
      return;
    }

    if (toolMode !== 'select') return;
    if (fragmentDrag) return;

    const rect = scrollContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentScrollX = scrollContainerRef.current?.scrollLeft ?? scroll.x;
    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;

    const x = e.clientX - rect.left + currentScrollX;
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

    const currentScrollX = scrollContainerRef.current?.scrollLeft ?? scroll.x;
    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;

    const x = e.clientX - rect.left + currentScrollX;
    const y = e.clientY - rect.top + currentScrollY;

    updateSelectionBox(x, y);
  };

  // Handle mouse up for selection box
  const handleMouseUp = (e: React.MouseEvent) => {
    const trySetPasteIndicator = () => {
    if (!clipboard || clipboard.fragments.length === 0) return;

    const rect = scrollContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentScrollX = scrollContainerRef.current?.scrollLeft ?? scroll.x;
    const currentScrollY = scrollContainerRef.current?.scrollTop ?? scroll.y;

    const x = e.clientX - rect.left + currentScrollX;
    const y = e.clientY - rect.top + currentScrollY;

    const clickTime = (x / zoom) * 1000;

    const relativeY = y;

    if (relativeY < 0) return;

    const videoAreaHeight = videoTrackCount * TRACK_HEIGHT;
    const audioAreaStart = videoAreaHeight + TRACK_DIVIDER_HEIGHT;

    let clickedTrackId: string | null = null;

    if (relativeY < videoAreaHeight) {
      const visualIndex = Math.floor(relativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < videoTrackCount) {
        clickedTrackId = videoTracks[visualIndex].id;
      }
    } else if (relativeY >= audioAreaStart) {
      const audioRelativeY = relativeY - audioAreaStart;
      const visualIndex = Math.floor(audioRelativeY / TRACK_HEIGHT);
      if (visualIndex >= 0 && visualIndex < audioTrackCount) {
        clickedTrackId = audioTracks[visualIndex].id;
      }
    }

    if (!clickedTrackId) return;

    const clickedOnFragment = fragments.some(f => {
      if (f.trackId !== clickedTrackId) return false;
      const fragStart = (f.start / 1000) * zoom;
      const fragEnd = ((f.start + f.duration) / 1000) * zoom;
      return x >= fragStart && x <= fragEnd;
    });

    if (!clickedOnFragment) {
      setPasteIndicator({ time: clickTime, trackId: clickedTrackId });
    }
  };

    let selectionConfirmed = false;
    if (isDragging && selectionBox) {
      const minX = Math.min(selectionBox.startX, selectionBox.endX);
      const maxX = Math.max(selectionBox.startX, selectionBox.endX);
      const width = maxX - minX;

      if (width >= 10) {
        confirmSelectionBox();
        selectionConfirmed = true;
      } else {
        trySetPasteIndicator();
      }
    } else {
      trySetPasteIndicator();
    }

    const target = e.target as HTMLElement;
    const clickedOnFragment = target.closest('[data-fragment-id]');
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

  // Calculate timeline dimensions
  const minVisibleDuration = 120000;
  const bufferDuration = Math.max(60000, duration * 0.2);
  const contentDuration = Math.max(duration + bufferDuration, minVisibleDuration);
  const timelineDuration = Math.min(contentDuration, MAX_TIMELINE_DURATION);
  const timelineWidth = Math.max(timelineDuration * zoom / 1000 + 200, 2000);
  const playheadX = (playhead / 1000) * zoom;

  // Track content height (no ruler/scene offset needed in content area)
  const trackContentHeight = (videoTrackCount + audioTrackCount) * TRACK_HEIGHT + TRACK_DIVIDER_HEIGHT;

  const handleMouseLeave = () => {
    if (isDragging && selectionBox) {
      cancelSelectionBox();
      setIsDragging(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <Toolbar />

      <div
        className="flex-1 relative min-h-0"
        style={{
          display: 'grid',
          gridTemplateColumns: `${TRACK_HEADER_WIDTH}px 1fr`,
          gridTemplateRows: `${TRACKS_AREA_OFFSET}px 1fr`,
        }}
        data-testid="timeline-canvas"
      >
        {/* Top-left: Corner Block (fixed) */}
        <div className="bg-zinc-900 border-r border-b border-zinc-800 z-20 flex items-center justify-center min-w-0 min-h-0">
          <Layers size={14} className="text-cyan-400" />
        </div>

        {/* Top-right: Ruler scroll area (horizontal only) */}
        <div
          ref={rulerScrollRef}
          className="overflow-x-auto overflow-y-hidden border-b border-zinc-800 min-w-0 min-h-0"
          style={{ scrollbarWidth: 'none' }}
          onContextMenu={handleRulerContextMenu}
        >
          <div style={{ width: timelineWidth + viewportWidth, position: 'relative' }}>
            <PlayheadHandle x={playheadX} />
            <TimeRuler
              width={timelineWidth}
              zoom={zoom}
              scrollX={scroll.x}
              viewportWidth={viewportWidth}
              onClick={handleTimeRulerClick}
            />
            <SceneTrack
              width={timelineWidth}
              zoom={zoom}
              scrollX={scroll.x}
              viewportWidth={viewportWidth}
            />

            {/* Scene paste indicator (in ruler area) */}
            {pasteIndicator && pasteIndicator.trackId === undefined && (
              <PasteIndicator
                x={(pasteIndicator.time / 1000) * zoom}
              />
            )}
          </div>
        </div>

        {/* Bottom-left: Headers scroll area (vertical only) */}
        <div
          ref={headersScrollRef}
          className="overflow-y-auto overflow-x-hidden bg-zinc-900 border-r border-zinc-800 min-w-0 min-h-0"
          style={{ scrollbarWidth: 'none' }}
          onContextMenu={handleHeadersContextMenu}
        >
          {/* Video track headers */}
          {videoTracks.map((track) => (
            <TrackHeader
              key={track.id}
              track={track}
              onContextMenu={(e) => handleTrackContextMenu(e, track.id)}
            />
          ))}
          {/* Divider header spacer */}
          {(videoTrackCount > 0 || audioTrackCount > 0) && (
            <div className="border-b border-zinc-800" style={{ height: TRACK_DIVIDER_HEIGHT }} />
          )}
          {/* Audio track headers */}
          {audioTracks.map((track) => (
            <TrackHeader
              key={track.id}
              track={track}
              onContextMenu={(e) => handleTrackContextMenu(e, track.id)}
            />
          ))}
        </div>

        {/* Bottom-right: Main content scroll area */}
        <div
          ref={scrollContainerRef}
          className="overflow-auto bg-zinc-950 relative min-w-0 min-h-0"
          onScroll={handleContentScroll}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onMouseDown={handleMouseDown}
          onContextMenu={handleContextMenu}
        >
          <div
            ref={containerRef}
            className="relative"
            style={{ width: timelineWidth + viewportWidth, minHeight: trackContentHeight }}
            data-testid="tracks-container"
          >
            {/* Video Tracks */}
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
              />
            ))}

            {/* Track Divider */}
            {(videoTrackCount > 0 || audioTrackCount > 0) && (
              <TrackDivider width={timelineWidth} viewportWidth={viewportWidth} />
            )}

            {/* Audio Tracks */}
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
              />
            ))}

            {/* Playhead line in content area */}
            <PlayheadLine x={playheadX} contentHeight={trackContentHeight} />

            {/* Drag Ghosts */}
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
                  left: (item.start / 1000) * zoom,
                  width: Math.max((item.duration / 1000) * zoom, 20),
                  top: getTrackVisualY(item.trackId) + 2,
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

            {/* Paste Indicator (track only) */}
            {pasteIndicator && pasteIndicator.trackId !== undefined && (
              <PasteIndicator
                x={(pasteIndicator.time / 1000) * zoom}
                visualY={getTrackVisualY(pasteIndicator.trackId)}
              />
            )}

            {/* Selection Box */}
            {selectionBox && (
              <div
                className="absolute pointer-events-none border border-blue-500 border-dashed bg-blue-500/10 z-20"
                style={{
                  left: Math.min(selectionBox.startX, selectionBox.endX),
                  top: Math.min(selectionBox.startY, selectionBox.endY),
                  width: Math.abs(selectionBox.endX - selectionBox.startX),
                  height: Math.abs(selectionBox.endY - selectionBox.startY),
                }}
              />
            )}

            {/* Snap Lines */}
            <SnapLines snapLines={activeSnapLines} zoom={zoom} />
          </div>
        </div>
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
