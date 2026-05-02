import { useState, useCallback, useEffect, useRef } from 'react';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Scene } from '@opendirector/core/types/timeline';
import { findSnapPoint } from '@opendirector/core/utils/snap';
import { pixelToTime } from '@opendirector/core/utils/timeline';
import { clsx } from 'clsx';
import { Image, Plus, Layers } from 'lucide-react';
import { TRACK_HEADER_WIDTH, SCENE_TRACK_HEIGHT } from './constants';

interface SceneTrackProps {
  width: number;
  zoom: number;
  scrollX: number;
  viewportWidth?: number;
}

const EDGE_THRESHOLD = 6; // pixels from edge to trigger resize
const MIN_SCENE_DURATION = 1000; // 1 second minimum
const DRAG_THRESHOLD = 3; // Minimum pixels to move before considering it a drag

export function SceneTrack({ width, zoom, scrollX, viewportWidth }: SceneTrackProps) {
  const scenes = useTimelineStore((s) => s.scenes);
  const toolMode = useTimelineStore((s) => s.toolMode);
  const splitScene = useTimelineStore((s) => s.splitScene);
  const updateScene = useTimelineStore((s) => s.updateScene);
  const selectScene = useSelectionStore((s) => s.selectScene);
  const toggleScene = useSelectionStore((s) => s.toggleScene);
  const sceneSelectionIds = useSelectionStore((s) => s.primaryType === 'scene' ? s.primaryIds : []);
  const clipboard = useTimelineStore((s) => s.clipboard);
  const setPasteIndicator = useTimelineStore((s) => s.setPasteIndicator);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const snapThreshold = useTimelineStore((s) => s.snapThreshold);
  const setActiveSnapLines = useTimelineStore((s) => s.setActiveSnapLines);
  const clearActiveSnapLines = useTimelineStore((s) => s.clearActiveSnapLines);
  const allFragments = useTimelineStore((s) => s.fragments);

  const [isDragOver, setIsDragOver] = useState(false);
  const [dragOverSceneId, setDragOverSceneId] = useState<string | null>(null);

  // Scene edge resize state - use "pending" state to distinguish click from drag
  const [resizingScene, setResizingScene] = useState<string | null>(null);
  const [resizeStartX, setResizeStartX] = useState(0);
  const [resizeStartDuration, setResizeStartDuration] = useState(0);
  const [resizeEdge, setResizeEdge] = useState<'left' | 'right' | null>(null);
  // Pending state (before we've moved enough to confirm resize intent)
  const [pendingResize, setPendingResize] = useState<{ sceneId: string; edge: 'left' | 'right' } | null>(null);
  // Track if we've moved enough to consider this a resize operation
  const hasMovedRef = useRef(false);

  // Handle scene edge resize - start pending state
  const handleSceneMouseDown = useCallback((e: React.MouseEvent, scene: Scene) => {
    if (e.button !== 0) return; // Only handle left click
    if (toolMode !== 'select') return;
    e.stopPropagation();

    // Use currentTarget to get the scene container, not the handle element
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const isNearLeftEdge = x < EDGE_THRESHOLD;
    const isNearRightEdge = x > rect.width - EDGE_THRESHOLD;

    // Handle Ctrl/Cmd+click for multi-select
    if ((e.ctrlKey || e.metaKey) && !isNearLeftEdge && !isNearRightEdge) {
      toggleScene(scene.id);
      return;
    }

    if (isNearLeftEdge || isNearRightEdge) {
      // Don't set resizing state yet - wait for movement
      const edge = isNearLeftEdge ? 'left' : 'right';
      setPendingResize({ sceneId: scene.id, edge });
      hasMovedRef.current = false;
      setResizeStartX(e.clientX);
      setResizeStartDuration(scene.duration);
      e.preventDefault();
    }

    // Always select the scene on click
    selectScene(scene.id);
  }, [toolMode, selectScene, toggleScene]);

  const handleSceneMouseMove = useCallback((e: MouseEvent) => {
    // Check if we've moved enough to consider this a resize
    if (pendingResize && !hasMovedRef.current) {
      const deltaX = e.clientX - resizeStartX;
      if (Math.abs(deltaX) >= DRAG_THRESHOLD) {
        hasMovedRef.current = true;
        setResizingScene(pendingResize.sceneId);
        setResizeEdge(pendingResize.edge);
        setPendingResize(null); // Clear pending once we start resizing
      }
    }

    if (!resizingScene || !resizeEdge) return;

    const deltaX = e.clientX - resizeStartX;
    const deltaTime = pixelToTime(deltaX, zoom);

    const sceneIndex = scenes.findIndex((s) => s.id === resizingScene);
    if (sceneIndex === -1) return;

    const scene = scenes[sceneIndex];
    const prevScene = scenes[sceneIndex - 1];
    const nextScene = scenes[sceneIndex + 1];

    if (resizeEdge === 'right') {
      // Resize right edge - affects next scene
      let newDuration = Math.max(MIN_SCENE_DURATION, resizeStartDuration + deltaTime);
      let newEnd = scene.start + newDuration;

      // Apply snapping if enabled
      if (snapEnabled) {
        const snapContext = {
          playhead: useTimelineStore.getState().getPlayheadRef(),
          fragments: allFragments,
          scenes,
          excludeFragmentIds: [],
        };

        const snapResult = findSnapPoint(newEnd, snapContext, zoom, snapThreshold);
        if (snapResult.snapLines.length > 0) {
        newEnd = snapResult.time;
        newDuration = newEnd - scene.start;
        setActiveSnapLines(snapResult.snapLines);
      } else {
        clearActiveSnapLines();
      }
      }

      const durationDelta = newDuration - scene.duration;

      if (nextScene) {
        // Adjust next scene's start and duration
        const newNextStart = nextScene.start + durationDelta;
        const newNextDuration = nextScene.duration - durationDelta;
        if (newNextDuration >= MIN_SCENE_DURATION) {
          updateScene(scene.id, { duration: newDuration });
          updateScene(nextScene.id, { start: newNextStart, duration: newNextDuration });
        }
      } else {
        // Last scene, just resize
        updateScene(scene.id, { duration: newDuration });
      }
    } else if (resizeEdge === 'left') {
      // Resize left edge - affects previous scene
      let newStart = scene.start + deltaTime;
      let newDuration = Math.max(MIN_SCENE_DURATION, resizeStartDuration - deltaTime);

      // Apply snapping if enabled
      if (snapEnabled) {
        const snapContext = {
          playhead: useTimelineStore.getState().getPlayheadRef(),
          fragments: allFragments,
          scenes,
          excludeFragmentIds: [],
        };

        const snapResult = findSnapPoint(newStart, snapContext, zoom, snapThreshold);
        if (snapResult.snapLines.length > 0) {
        newStart = snapResult.time;
        newDuration = (scene.start + scene.duration) - newStart;
        setActiveSnapLines(snapResult.snapLines);
      } else {
        clearActiveSnapLines();
      }
      }

      const durationDelta = scene.duration - newDuration;

      if (prevScene) {
        // Adjust previous scene's duration
        const newPrevDuration = prevScene.duration + durationDelta;
        if (newPrevDuration >= MIN_SCENE_DURATION) {
          updateScene(scene.id, { start: newStart, duration: newDuration });
          updateScene(prevScene.id, { duration: newPrevDuration });
        }
      }
    }
  }, [pendingResize, resizingScene, resizeEdge, resizeStartX, resizeStartDuration, zoom, scenes, updateScene, snapEnabled, snapThreshold, allFragments, setActiveSnapLines, clearActiveSnapLines]);

  const handleSceneMouseUp = useCallback(() => {
    // Clear snap lines
    clearActiveSnapLines();

    // Reset all resize state
    setResizingScene(null);
    setResizeEdge(null);
    setPendingResize(null);
    hasMovedRef.current = false;
  }, [clearActiveSnapLines]);

  // Add global mouse event listeners during scene resize
  useEffect(() => {
    // Add listeners when we have a pending resize or active resize
    if (pendingResize || resizingScene) {
      window.addEventListener('mousemove', handleSceneMouseMove);
      window.addEventListener('mouseup', handleSceneMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleSceneMouseMove);
        window.removeEventListener('mouseup', handleSceneMouseUp);
      };
    }
  }, [pendingResize, resizingScene, handleSceneMouseMove, handleSceneMouseUp]);

  // Handle razor click on scene
  const handleRazorClick = (e: React.MouseEvent, scene: Scene) => {
    if (toolMode !== 'razor') return;
    e.stopPropagation();

    // Calculate click position relative to scene content area
    const sceneContentRect = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!sceneContentRect) return;

    // The scene content div is positioned at `left: TRACK_HEADER_WIDTH - scrollX`
    // So the click X relative to the content div is already in content coordinates
    // (scene positions inside the content div are relative to its origin)
    const x = e.clientX - sceneContentRect.left;
    let clickTime = (x / zoom) * 1000;

    // Apply snapping if enabled
    if (snapEnabled) {
      const snapContext = {
        playhead: useTimelineStore.getState().getPlayheadRef(),
        fragments: allFragments,
        scenes,
        excludeFragmentIds: [],
      };

      const snapResult = findSnapPoint(clickTime, snapContext, zoom, snapThreshold);
      if (snapResult.snapLines.length > 0) {
        clickTime = snapResult.time;
        // Briefly show snap line
        setActiveSnapLines(snapResult.snapLines);
        setTimeout(() => clearActiveSnapLines(), 200);
      }
    }

    splitScene(scene.id, clickTime);
  };

  // Handle scene click for selection
  const handleSceneClick = (e: React.MouseEvent, scene: Scene) => {
    e.stopPropagation();

    if (toolMode === 'razor') {
      handleRazorClick(e, scene);
    }
    // Selection is handled in mousedown
  };

  // Handle scene element mouseup - stop propagation to prevent TimelineCanvas from clearing selection
  // But NOT when we're resizing (let window handler catch it)
  const handleSceneElementMouseUp = (e: React.MouseEvent) => {
    if (pendingResize || resizingScene) {
      return;
    }
    e.stopPropagation();
  };

  // Handle drag over for dropping references
  const handleDragOver = (e: React.DragEvent, sceneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
    setDragOverSceneId(sceneId);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
    setDragOverSceneId(null);
  };

  const handleDrop = (e: React.DragEvent, scene: Scene) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setDragOverSceneId(null);

    // Get drag data
    const jsonData = e.dataTransfer.getData('application/json');
    if (!jsonData) return;

    let dragData: { id: string };
    try {
      dragData = JSON.parse(jsonData);
    } catch {
      return; // Ignore malformed drag data
    }

    // Add reference to scene (max 2)
    const currentRefs = scene.referenceIds;
    if (currentRefs.length >= 2) {
      console.warn('Scene already has maximum references (2)');
      return;
    }

    updateScene(scene.id, {
      referenceIds: [...currentRefs, dragData.id],
    });
  };

  // Get cursor for scene based on position
  const getSceneCursor = (scene: Scene) => {
    if (toolMode === 'razor') return 'cursor-razor';
    if (resizingScene === scene.id) {
      return resizeEdge === 'left' || resizeEdge === 'right' ? 'cursor-ew-resize' : 'cursor-pointer';
    }
    return 'cursor-pointer';
  };

  // Handle click on empty area for paste indicator
  const handleContentClick = (e: React.MouseEvent) => {
    // Only handle if clicking on empty space (not on a scene)
    if ((e.target as HTMLElement).closest('[data-scene]')) return;

    // If clipboard has scenes, allow setting paste indicator
    if (clipboard && clipboard.scenes.length > 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const clickTime = (x / zoom) * 1000;
      setPasteIndicator({ time: clickTime }); // trackId undefined = scene track
    }
  };

  // Outer width = timelineWidth + viewportWidth, ensures no truncation when scrolling to the end
  const outerWidth = width + (viewportWidth ?? 0);
  const contentWidth = Math.max(width, scrollX + (viewportWidth ?? 0) + 100);

  return (
    <div
      className="relative border-b border-zinc-800 overflow-hidden"
      style={{ height: SCENE_TRACK_HEIGHT, width: outerWidth }}
      data-testid="scene-track"
    >
      {/* Track Header */}
      <div
        className="absolute left-0 top-0 bottom-0 bg-zinc-900 border-r border-zinc-800 z-10 flex items-center justify-center"
        style={{ width: TRACK_HEADER_WIDTH }}
      >
        <Layers size={14} className="text-cyan-400" />
      </div>

      {/* Scene Content Area - use left positioning to align with Track content */}
      <div
        className="absolute top-0 bottom-0"
        style={{
          width: contentWidth,
          left: TRACK_HEADER_WIDTH,
        }}
        onClick={handleContentClick}
      >
        {scenes.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-zinc-600">
            暂无场景
          </div>
        ) : (
          scenes.map((scene) => {
            const left = (scene.start / 1000) * zoom;
            const sceneWidth = (scene.duration / 1000) * zoom;
            const isSelected = sceneSelectionIds.includes(scene.id);

            return (
              <div
                key={scene.id}
                data-scene={scene.id}
                className={clsx(
                  'absolute top-0.5 bottom-0.5 rounded border transition-colors',
                  isSelected
                    ? 'border-cyan-400 bg-cyan-900/50'
                    : 'border-cyan-500/50 bg-cyan-900/30',
                  'hover:bg-cyan-900/50',
                  getSceneCursor(scene),
                  isDragOver && dragOverSceneId === scene.id && 'border-blue-500 bg-blue-900/30'
                )}
                style={{
                  left,
                  width: Math.max(sceneWidth, 20),
                }}
                onClick={(e) => handleSceneClick(e, scene)}
                onMouseDown={(e) => handleSceneMouseDown(e, scene)}
                onMouseUp={handleSceneElementMouseUp}
                onDragOver={(e) => handleDragOver(e, scene.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, scene)}
                title={`${scene.name} (${scene.referenceIds.length}/2 参考图)`}
              >
                {/* Left resize handle */}
                <div
                  className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-cyan-400/30"
                  style={{ marginLeft: '-1px' }}
                />

                {/* Right resize handle */}
                <div
                  className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-cyan-400/30"
                  style={{ marginRight: '-1px' }}
                />

                <div className="flex items-center h-full px-2 gap-1 overflow-hidden pointer-events-none">
                  <span className="text-xs text-cyan-300 truncate flex-1">
                    {scene.name}
                  </span>
                  <div className="flex items-center gap-0.5 text-cyan-400">
                    {scene.referenceIds.length > 0 ? (
                      <>
                        <Image size={10} />
                        <span className="text-xs">{scene.referenceIds.length}</span>
                      </>
                    ) : (
                      <Plus size={10} className="opacity-50" />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
