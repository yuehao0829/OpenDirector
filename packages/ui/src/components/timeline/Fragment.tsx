import { useRef, useCallback, useState, useEffect } from 'react';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Fragment as FragmentType } from '@opendirector/core/types/timeline';
import { findSnapPoint, wouldCreateOverlap } from '@opendirector/core/utils/snap';
import { pixelToTime } from '@opendirector/core/utils/timeline';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { parseAssetDragData, buildReferencesFromDragData } from './drag-types';

interface FragmentProps {
  fragment: FragmentType;
  zoom: number;
  isSelected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.MouseEvent, fragment: FragmentType) => void;
}

const EDGE_THRESHOLD = 8;
const MIN_DURATION = 1000; // Minimum 1 second duration
const DRAG_THRESHOLD = 3; // Minimum pixels to move before considering it a drag

const FRAGMENT_THEME = {
  video: {
    statusColors: {
      draft: 'border-dashed border-amber-600 bg-amber-900/20',
      generating: '',
      completed: 'border-amber-500 bg-amber-900/30',
      failed: 'border-red-500 bg-red-900/30',
    },
    generatingClass: 'fragment-generating fragment-generating-video',
    selectedRing: 'ring-2 ring-amber-400 ring-offset-1 ring-offset-zinc-900',
    dragOverRing: 'ring-2 ring-amber-300 ring-offset-1 ring-offset-zinc-900',
  },
  audio: {
    statusColors: {
      draft: 'border-dashed border-blue-600 bg-blue-900/20',
      generating: '',
      completed: 'border-blue-500 bg-blue-900/30',
      failed: 'border-red-500 bg-red-900/30',
    },
    generatingClass: 'fragment-generating fragment-generating-audio',
    selectedRing: 'ring-2 ring-blue-400 ring-offset-1 ring-offset-zinc-900',
    dragOverRing: 'ring-2 ring-blue-300 ring-offset-1 ring-offset-zinc-900',
  },
} as const;

export function Fragment({ fragment, zoom, isSelected, onClick, onDragStart }: FragmentProps) {
  const selectFragment = useSelectionStore((s) => s.selectFragment);
  const focusFragment = useSelectionStore((s) => s.focusFragment);
  const toggleFragment = useSelectionStore((s) => s.toggleFragment);
  const updateFragment = useTimelineStore((s) => s.updateFragment);
  const applyFragmentTiming = useTimelineStore((s) => s.applyFragmentTiming);
  const toolMode = useTimelineStore((s) => s.toolMode);
  const tracks = useTimelineStore((s) => s.tracks);
  const getAssetById = useAssetStore((s) => s.getAssetById);
  const fragmentRef = useRef<HTMLDivElement>(null);

  // Drop state
  const [isDragOver, setIsDragOver] = useState(false);

  // Resize state - track with ref for stable event handlers
  // ALL mutable state lives here so the effect never needs to re-create listeners
  const resizeStateRef = useRef<{
    isResizing: 'left' | 'right' | null;
    pendingEdge: 'left' | 'right' | null;
    startX: number;
    startDuration: number;
    startStart: number;      // fragment.start at drag begin
    startEnd: number;        // fragment.start + fragment.duration at drag begin (right edge anchor)
    fragmentId: string;
    fragmentTrackId: string;
    startTrimStart: number;  // fragment.trimStart at drag begin
    hasMoved: boolean;
  }>({
    isResizing: null,
    pendingEdge: null,
    startX: 0,
    startDuration: 0,
    startStart: 0,
    startEnd: 0,
    fragmentId: '',
    fragmentTrackId: '',
    startTrimStart: 0,
    hasMoved: false,
  });

  // Track if we have an active resize (for cursor and conditional rendering)
  const [isResizing, setIsResizing] = useState<'left' | 'right' | null>(null);
  const resizePreviewRef = useRef<{
    start: number;
    duration: number;
    trimStart?: number;
  } | null>(null);
  const [resizePreview, setResizePreview] = useState<{
    start: number;
    duration: number;
    trimStart?: number;
  } | null>(null);

  const displayedStart = resizePreview?.start ?? fragment.start;
  const displayedDuration = resizePreview?.duration ?? fragment.duration;

  const left = (displayedStart / 1000) * zoom;
  const width = (displayedDuration / 1000) * zoom;

  // Get the current track's type
  const currentTrack = tracks.find((t) => t.id === fragment.trackId);
  const currentTrackType = currentTrack?.type ?? 'video';
  const theme = FRAGMENT_THEME[currentTrackType];

  const isGenerating = fragment.status === 'generating';

  const updateResizePreview = useCallback((nextPreview: {
    start: number;
    duration: number;
    trimStart?: number;
  } | null) => {
    const currentPreview = resizePreviewRef.current;
    if (
      currentPreview?.start === nextPreview?.start &&
      currentPreview?.duration === nextPreview?.duration &&
      currentPreview?.trimStart === nextPreview?.trimStart
    ) {
      return;
    }
    resizePreviewRef.current = nextPreview;
    setResizePreview(nextPreview);
  }, []);

  // Handle resize mouse down - start pending state
  const handleResizeStart = useCallback((e: React.MouseEvent, edge: 'left' | 'right') => {
    if (e.button !== 0) return; // Only handle left click
    if (toolMode !== 'select') return;

    e.stopPropagation();
    e.preventDefault();

    // Initialize resize state in ref
    resizeStateRef.current = {
      isResizing: null,
      pendingEdge: edge,
      startX: e.clientX,
      startDuration: fragment.duration,
      startStart: fragment.start,
      startEnd: fragment.start + fragment.duration,
      fragmentId: fragment.id,
      fragmentTrackId: fragment.trackId,
      startTrimStart: fragment.trimStart ?? 0,
      hasMoved: false,
    };

    selectFragment(fragment.id);
  }, [toolMode, fragment, selectFragment]);

  // Handle resize mouse move and up
  // IMPORTANT: This effect MUST NOT depend on any values that change during resize
  // (fragment.start, fragment.duration, zoom, etc.). Everything is read from
  // the ref or store.getState() inside the handlers to avoid listener churn.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const st = resizeStateRef.current;
      const deltaX = e.clientX - st.startX;

      // Check if we've moved enough to consider this a resize
      if (!st.hasMoved && Math.abs(deltaX) >= DRAG_THRESHOLD) {
        st.hasMoved = true;
        if (st.pendingEdge) {
          st.isResizing = st.pendingEdge;
          st.pendingEdge = null;
          setIsResizing(st.isResizing);
        }
      }

      if (!st.isResizing) return;

      const store = useTimelineStore.getState();
      const currentZoom = store.zoom;

      // Source duration cap
      const fragment = store.fragments.find(f => f.id === st.fragmentId);
      const sourceAsset = fragment?.sourceAssetId
        ? useAssetStore.getState().getAssetById(fragment.sourceAssetId)
        : null;
      const currentTrimStart = fragment?.trimStart ?? 0;
      const maxDuration = sourceAsset?.duration
        ? Math.max(0, sourceAsset.duration - currentTrimStart)
        : Infinity;
      const effectiveMin = maxDuration !== Infinity && maxDuration < MIN_DURATION
        ? maxDuration : MIN_DURATION;

      // Build snap context — exclude self, check ALL tracks
      const snapContext = {
        playhead: store.playhead,
        fragments: store.fragments,
        scenes: store.scenes,
        excludeFragmentIds: [st.fragmentId],
      };

      if (st.isResizing === 'right') {
        const deltaTime = pixelToTime(deltaX, currentZoom);
        let newDuration = Math.max(effectiveMin, Math.min(maxDuration, st.startDuration + deltaTime));
        let newEnd = st.startStart + newDuration; // anchor: original start

        // Apply snapping
        if (store.snapEnabled) {
          const snapResult = findSnapPoint(newEnd, snapContext, currentZoom, store.snapThreshold);
          if (snapResult.snapLines.length > 0) {
            const snappedDuration = snapResult.time - st.startStart;
            if (snappedDuration >= effectiveMin &&
                !wouldCreateOverlap(st.fragmentId, st.startStart, snappedDuration, st.fragmentTrackId, store.fragments)) {
              newEnd = snapResult.time;
              newDuration = snappedDuration;
              store.setActiveSnapLines(snapResult.snapLines);
            } else {
              store.clearActiveSnapLines();
            }
          } else {
            store.clearActiveSnapLines();
          }
        }

        // Clamp end to next neighbor on same track
        if (wouldCreateOverlap(st.fragmentId, st.startStart, newDuration, st.fragmentTrackId, store.fragments)) {
          const rightNeighbor = store.fragments
            .filter(f => f.trackId === st.fragmentTrackId && f.id !== st.fragmentId && f.start >= st.startStart)
            .sort((a, b) => a.start - b.start)[0];
          if (rightNeighbor && newEnd > rightNeighbor.start) {
            newEnd = rightNeighbor.start;
            newDuration = newEnd - st.startStart;
          }
        }

        if (newDuration >= effectiveMin &&
            !wouldCreateOverlap(st.fragmentId, st.startStart, newDuration, st.fragmentTrackId, store.fragments)) {
          updateResizePreview({
            start: st.startStart,
            duration: newDuration,
            trimStart: fragment?.trimStart,
          });
        }
      } else if (st.isResizing === 'left') {
        const deltaTime = pixelToTime(deltaX, currentZoom);
        const hasSource = !!sourceAsset;
        // Right edge stays anchored: original end = st.startEnd

        if (hasSource) {
          // Source-aware left-edge resize:
          // deltaTime > 0 (drag right) → trimStart increases, duration decreases
          // deltaTime < 0 (drag left) → trimStart decreases, duration increases
          const sourceDuration = sourceAsset!.duration;
          let newTrimStart = st.startTrimStart + deltaTime;
          let newDuration = st.startDuration - deltaTime;
          let newStart = st.startStart + deltaTime;

          // Clamp trimStart >= 0
          if (newTrimStart < 0) {
            const trimDelta = -newTrimStart;
            newTrimStart = 0;
            newDuration += trimDelta;
            newStart -= trimDelta;
          }

          // Clamp trimStart + duration <= source duration
          if (sourceDuration && newTrimStart + newDuration > sourceDuration) {
            const overflow = newTrimStart + newDuration - sourceDuration;
            newDuration -= overflow;
          }

          // Clamp newStart >= 0 (push excess into trimStart)
          if (newStart < 0) {
            const startDelta = -newStart;
            newStart = 0;
            newTrimStart += startDelta;
            newDuration -= startDelta;
          }

          // Ensure minimum duration
          if (newDuration < effectiveMin) {
            newDuration = effectiveMin;
            newStart = st.startEnd - newDuration;
            newTrimStart = st.startTrimStart + (newStart - st.startStart);
          }

          // Apply snapping
          if (store.snapEnabled) {
            const snapResult = findSnapPoint(newStart, snapContext, currentZoom, store.snapThreshold);
            if (snapResult.snapLines.length > 0 && snapResult.time >= 0) {
              const snappedDelta = snapResult.time - st.startStart;
              const snappedTrimStart = st.startTrimStart + snappedDelta;
              const snappedDuration = st.startEnd - snapResult.time;
              if (snappedDuration >= effectiveMin &&
                  snappedTrimStart >= 0 &&
                  (!sourceDuration || snappedTrimStart + snappedDuration <= sourceDuration) &&
                  !wouldCreateOverlap(st.fragmentId, snapResult.time, snappedDuration, st.fragmentTrackId, store.fragments)) {
                newStart = snapResult.time;
                newDuration = snappedDuration;
                newTrimStart = snappedTrimStart;
                store.setActiveSnapLines(snapResult.snapLines);
              } else {
                store.clearActiveSnapLines();
              }
            } else {
              store.clearActiveSnapLines();
            }
          }

          // Clamp to previous neighbor on same track
          if (wouldCreateOverlap(st.fragmentId, newStart, newDuration, st.fragmentTrackId, store.fragments)) {
            const leftNeighbor = store.fragments
              .filter(f => f.trackId === st.fragmentTrackId && f.id !== st.fragmentId && (f.start + f.duration) <= st.startEnd)
              .sort((a, b) => (b.start + b.duration) - (a.start + a.duration))[0];
            if (leftNeighbor && newStart < leftNeighbor.start + leftNeighbor.duration) {
              newStart = leftNeighbor.start + leftNeighbor.duration;
              newDuration = st.startEnd - newStart;
              newTrimStart = st.startTrimStart + (newStart - st.startStart);
            }
          }

          if (newStart >= 0 && newDuration >= effectiveMin && newTrimStart >= 0 &&
              (!sourceDuration || newTrimStart + newDuration <= sourceDuration) &&
              !wouldCreateOverlap(st.fragmentId, newStart, newDuration, st.fragmentTrackId, store.fragments)) {
            updateResizePreview({
              start: newStart,
              duration: newDuration,
              trimStart: newTrimStart,
            });
          }
        } else {
          // No source: existing behavior
          let newDuration = Math.max(effectiveMin, Math.min(maxDuration, st.startDuration - deltaTime));
          let newStart = st.startEnd - newDuration;

          // Apply snapping
          if (store.snapEnabled) {
            const snapResult = findSnapPoint(newStart, snapContext, currentZoom, store.snapThreshold);
            if (snapResult.snapLines.length > 0) {
              const snappedDuration = st.startEnd - snapResult.time;
              if (snapResult.time >= 0 && snappedDuration >= effectiveMin &&
                  !wouldCreateOverlap(st.fragmentId, snapResult.time, snappedDuration, st.fragmentTrackId, store.fragments)) {
                newStart = snapResult.time;
                newDuration = snappedDuration;
                store.setActiveSnapLines(snapResult.snapLines);
              } else {
                store.clearActiveSnapLines();
              }
            } else {
              store.clearActiveSnapLines();
            }
          }

          // Clamp start to previous neighbor on same track
          if (wouldCreateOverlap(st.fragmentId, newStart, newDuration, st.fragmentTrackId, store.fragments)) {
            const leftNeighbor = store.fragments
              .filter(f => f.trackId === st.fragmentTrackId && f.id !== st.fragmentId && (f.start + f.duration) <= st.startEnd)
              .sort((a, b) => (b.start + b.duration) - (a.start + a.duration))[0];
            if (leftNeighbor && newStart < leftNeighbor.start + leftNeighbor.duration) {
              newStart = leftNeighbor.start + leftNeighbor.duration;
              newDuration = st.startEnd - newStart;
            }
          }

          if (newStart >= 0 && newDuration >= effectiveMin &&
              !wouldCreateOverlap(st.fragmentId, newStart, newDuration, st.fragmentTrackId, store.fragments)) {
            updateResizePreview({
              start: newStart,
              duration: newDuration,
              trimStart: fragment?.trimStart,
            });
          }
        }
      }
    };

    const handleMouseUp = () => {
      const currentPreview = resizePreviewRef.current;
      if (currentPreview && resizeStateRef.current.isResizing) {
        applyFragmentTiming(resizeStateRef.current.fragmentId, currentPreview);
      }
      useTimelineStore.getState().clearActiveSnapLines();
      resizeStateRef.current = {
        isResizing: null,
        pendingEdge: null,
        startX: 0,
        startDuration: 0,
        startStart: 0,
        startEnd: 0,
        fragmentId: '',
        fragmentTrackId: '',
        startTrimStart: 0,
        hasMoved: false,
      };
      updateResizePreview(null);
      setIsResizing(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [applyFragmentTiming, fragment.id, updateResizePreview]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only handle left click
    if (toolMode !== 'select') return;

    const rect = fragmentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const isNearLeftEdge = x < EDGE_THRESHOLD;
    const isNearRightEdge = x > rect.width - EDGE_THRESHOLD;

    // Stop propagation FIRST to prevent TimelineCanvas from handling this event
    e.stopPropagation();

    // Handle Ctrl/Cmd+click for multi-select
    if (e.ctrlKey || e.metaKey) {
      toggleFragment(fragment.id);
      return;
    }

    focusFragment(fragment.id);

    // Notify parent to start drag (only if not near edges)
    if (onDragStart && !isNearLeftEdge && !isNearRightEdge) {
      onDragStart(e, fragment);
    }
  }, [toolMode, fragment, focusFragment, onDragStart, toggleFragment]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (onClick) {
      onClick(e);
    }
  }, [onClick]);

  // Asset drop handlers
  const handleAssetDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);

  const handleAssetDragLeave = useCallback((e: React.DragEvent) => {
    // Only reset if leaving the fragment element itself
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  }, []);

  const handleAssetDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const dragData = parseAssetDragData(e.dataTransfer);
    if (!dragData) return;

    const existingAssetIds = fragment.references.map((r) => r.assetId);
    const newReferences = buildReferencesFromDragData(dragData, existingAssetIds);

    if (newReferences.length === 0) return;

    updateFragment(fragment.id, {
      references: [...fragment.references, ...newReferences],
    });
  }, [fragment.id, fragment.references, updateFragment]);

  const getCursorClass = () => {
    if (isResizing) return 'cursor-ew-resize';
    if (toolMode === 'razor') return 'cursor-razor';
    return 'cursor-grab';
  };

  // Thumbnail priority: sourceAsset > generatedUrl > thumbnailUrl > first image reference
  const sourceAsset = fragment.sourceAssetId ? getAssetById(fragment.sourceAssetId) : null;
  let thumbnailSrc = sourceAsset?.thumbnailUrl || fragment.generatedUrl || fragment.thumbnailUrl;

  if (!thumbnailSrc) {
    const firstImageRef = fragment.references.find(ref => ref.type === 'image');
    if (firstImageRef) {
      const refAsset = getAssetById(firstImageRef.assetId);
      thumbnailSrc = refAsset?.thumbnailUrl;
    }
  }

  return (
    <div
      ref={fragmentRef}
      className={twMerge(
        clsx(
          'absolute top-1 bottom-1 rounded',
          'select-none',
          isResizing ? 'hover:brightness-110' : 'hover:brightness-110 transition-all',
          !isGenerating && 'border',
          !isGenerating && theme.statusColors[fragment.status],
          isGenerating && theme.generatingClass,
          isSelected && !isGenerating && theme.selectedRing,
          isDragOver && theme.dragOverRing,
          getCursorClass()
        )
      )}
      style={{
        left,
        width: Math.max(width, 20),
      }}
      data-testid={`fragment-${fragment.id}`}
      data-fragment-id={fragment.id}
      data-track-type={currentTrackType}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onDragOver={handleAssetDragOver}
      onDragLeave={handleAssetDragLeave}
      onDrop={handleAssetDrop}
    >
      {/* Left resize handle */}
      <div
        className={clsx('absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/10 fragment-resize-handle', isGenerating && 'z-10')}
        onMouseDown={(e) => handleResizeStart(e, 'left')}
      />

      {/* Right resize handle */}
      <div
        className={clsx('absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/10 fragment-resize-handle', isGenerating && 'z-10')}
        onMouseDown={(e) => handleResizeStart(e, 'right')}
      />

      {/* Thumbnail placeholder */}
      {thumbnailSrc && (
        <img
          src={thumbnailSrc}
          alt=""
          className="absolute inset-0 w-full h-full object-cover rounded opacity-50 fragment-thumbnail"
        />
      )}

      {/* Prompt preview */}
      <div className="absolute inset-x-0 top-0 p-1 overflow-hidden pointer-events-none fragment-prompt">
        <p className="text-xs text-white truncate">
          {fragment.prompt || 'Empty fragment'}
        </p>
      </div>

      {/* Duration */}
      <div className="absolute inset-x-0 bottom-0 p-1 pointer-events-none fragment-duration">
        <p className="text-xs text-zinc-400">
          {(displayedDuration / 1000).toFixed(1)}s
        </p>
      </div>
    </div>
  );
}
