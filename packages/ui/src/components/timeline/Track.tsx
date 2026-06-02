import { useState } from 'react';
import { getPlatformAdapter } from '@opendirector/core/adapters';
import { refreshImportedAssetMetadata } from '@opendirector/core/services/asset-import';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import {
  useSelectionStore,
} from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Fragment as FragmentType, Track as TrackType } from '@opendirector/core/types/timeline';
import { findFragmentAt, getAvailableDuration, pixelToTime, timeToPixel } from '@opendirector/core/utils/timeline';
import { findSnapPoint } from '@opendirector/core/utils/snap';
import { Fragment as FragmentComponent } from './Fragment';
import { clsx } from 'clsx';
import { TRACK_HEIGHT } from './constants';
import { parseAssetDragData, isDragCompatibleWithTrack, resolveDroppedFragmentDuration, resolveDropSource } from './drag-types';

interface TrackProps {
  track: TrackType;
  fragments: FragmentType[];
  zoom: number;
  width: number;
  scrollX: number;
  viewportWidth?: number;
  onFragmentDragStart?: (e: React.MouseEvent, fragment: FragmentType) => void;
}

export function Track({ track, fragments, zoom, width, scrollX, viewportWidth, onFragmentDragStart }: TrackProps) {
  const toolMode = useTimelineStore((s) => s.toolMode);
  const splitFragment = useTimelineStore((s) => s.splitFragment);
  const addFragment = useTimelineStore((s) => s.addFragment);
  const selectionIds = useSelectionStore((s) => s.primaryType === 'fragment' ? s.primaryIds : []);
  const getAssetById = useAssetStore((s) => s.getAssetById);
  const updateAsset = useAssetStore((s) => s.updateAsset);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const snapThreshold = useTimelineStore((s) => s.snapThreshold);
  const allFragments = useTimelineStore((s) => s.fragments);
  const allScenes = useTimelineStore((s) => s.scenes);
  const setActiveSnapLines = useTimelineStore((s) => s.setActiveSnapLines);
  const clearActiveSnapLines = useTimelineStore((s) => s.clearActiveSnapLines);
  const currentProjectPath = useProjectStore((s) => s.currentProject?.folderPath);

  const [isDragOver, setIsDragOver] = useState(false);
  const [dropPosition, setDropPosition] = useState<number | null>(null);

  // Handle razor click on fragment
  const handleRazorClick = (e: React.MouseEvent) => {
    if (toolMode !== 'razor') return;

    const rect = e.currentTarget.getBoundingClientRect();
    // Track content uses transform to sync with scroll, so click position is already "visible position"
    // No need to add scrollX - the fragments are already positioned correctly via transform
    const x = e.clientX - rect.left;
    let clickTime = pixelToTime(x, zoom);

    // Apply snapping if enabled
    if (snapEnabled) {
      const snapContext = {
        playhead: useTimelineStore.getState().getPlayheadRef(),
        fragments: allFragments,
        scenes: allScenes,
        excludeFragmentIds: [],
        trackId: track.id,
      };

      const snapResult = findSnapPoint(clickTime, snapContext, zoom, snapThreshold);
      if (snapResult.snapLines.length > 0) {
        clickTime = snapResult.time;
        // Briefly show snap line
        setActiveSnapLines(snapResult.snapLines);
        setTimeout(() => clearActiveSnapLines(), 200);
      }
    }

    const fragment = findFragmentAt(fragments, clickTime);
    if (fragment) {
      splitFragment(fragment.id, clickTime);
    }
  };

  // Handle drag over for drop
  // NOTE: dataTransfer.getData() is only readable in the drop event due to
  // browser security restrictions. In dragover, we only check that the MIME
  // type is present and always accept. Actual type validation happens in handleDrop.
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dropTime = pixelToTime(x, zoom);
    setDropPosition(dropTime);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
    setDropPosition(null);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setDropPosition(null);

    const dragData = parseAssetDragData(e.dataTransfer);
    if (!dragData || !isDragCompatibleWithTrack(dragData.type, track.type)) return;

    // Calculate drop position
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dropTime = pixelToTime(x, zoom);

    // Auto-shrink to fit available gap
    const availableDuration = getAvailableDuration(fragments, dropTime, track.id);

    if (availableDuration <= 0) {
      console.warn('Cannot place fragment here - no space available');
      return;
    }

    const currentAsset = dragData.additionalAssets?.length ? null : getAssetById(dragData.id);
    let currentAssetDuration = currentAsset?.duration;

    if (
      currentAsset
      && dragData.type !== 'image'
      && (currentAssetDuration ?? 0) <= 0
    ) {
      try {
        const adapter = await getPlatformAdapter();
        if (adapter.fs) {
          const refreshedFields = await refreshImportedAssetMetadata(
            currentAsset,
            adapter.fs,
            currentProjectPath,
          );
          if (Object.keys(refreshedFields).length > 0) {
            updateAsset(currentAsset.id, refreshedFields);
            currentAssetDuration = refreshedFields.duration ?? currentAssetDuration;
          }
        }
      } catch (error) {
        console.warn(`Failed to refresh dropped asset metadata ${currentAsset.id}:`, error);
      }
    }

    const duration = resolveDroppedFragmentDuration(
      dragData,
      availableDuration,
      currentAssetDuration,
    );

    if (duration === null) {
      console.warn('Cannot place fragment here - gap too small');
      return;
    }

    const { sourceAssetId, references } = resolveDropSource(dragData);

    addFragment({
      id: `fragment-${Date.now()}`,
      trackId: track.id,
      start: dropTime,
      duration,
      prompt: '',
      references,
      sourceAssetId,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  const cursorStyle = {
    select: 'default',
    razor: 'crosshair',
  } as const;

  // Outer width = timelineWidth + viewportWidth, ensures no truncation when scrolling to the end
  const outerWidth = width + (viewportWidth ?? 0);
  const contentWidth = Math.max(width, scrollX + (viewportWidth ?? 0) + 100);

  return (
    <div
      className="relative border-b border-zinc-800 overflow-hidden"
      style={{ height: TRACK_HEIGHT, width: outerWidth }}
      data-testid={`track-${track.type}-${track.order}`}
      data-track-id={track.id}
      data-track-type={track.type}
    >
      {/* Track Content */}
      <div
        className={clsx(
          'absolute top-0 bottom-0 overflow-hidden',
          toolMode === 'razor' && 'cursor-razor',
          isDragOver && 'bg-blue-500/10'
        )}
        style={{
          width: contentWidth,
          cursor: cursorStyle[toolMode],
        }}
        onClick={toolMode === 'razor' ? handleRazorClick : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {fragments.map((fragment) => (
          <FragmentComponent
            key={fragment.id}
            fragment={fragment}
            zoom={zoom}
            isSelected={selectionIds.includes(fragment.id)}
            onDragStart={onFragmentDragStart}
          />
        ))}

        {/* Drop indicator */}
        {isDragOver && dropPosition !== null && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-blue-500 z-20 pointer-events-none"
            style={{ left: timeToPixel(dropPosition, zoom) }}
          >
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-blue-500 rounded-full" />
          </div>
        )}
      </div>
    </div>
  );
}
