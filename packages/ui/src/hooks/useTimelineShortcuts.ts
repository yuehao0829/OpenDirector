import { useEffect, useCallback, useRef } from 'react';
import { usePreviewStore } from '@opendirector/core/stores/previewStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { requestNativePreviewStepFrame, useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { redo, undo } from '@opendirector/core/stores/undoManager';
import { isAnyModalOpen } from '../components/common/modal-state';
import { getEffectiveFps, snapToFrame } from '@opendirector/core/utils/time';
import { msToFrames, framesToMs } from '@opendirector/core/utils/time';

function handleInOutShortcut(point: 'in' | 'out', altKey: boolean) {
  const state = useTimelineStore.getState();
  if (altKey) {
    if (point === 'in') state.clearInPoint();
    else state.clearOutPoint();
  } else {
    const fps = getEffectiveFps(useProjectStore.getState().currentProject?.settings.fps);
    const playheadTime = state.playhead;
    const snapped = snapToFrame(playheadTime, fps);
    if (point === 'in') state.setInPoint(snapped);
    else state.setOutPoint(snapped);
  }
}

export function useTimelineShortcuts() {
  const setToolMode = useTimelineStore((s) => s.setToolMode);
  const toggleTimelinePlayback = useTimelineStore((s) => s.togglePlayback);
  const cancelSelectionBox = useTimelineStore((s) => s.cancelSelectionBox);
  const setDraftFragment = useTimelineStore((s) => s.setDraftFragment);
  const selectionBox = useTimelineStore((s) => s.selectionBox);
  const draftFragment = useTimelineStore((s) => s.draftFragment);
  const zoomIn = useTimelineStore((s) => s.zoomIn);
  const zoomOut = useTimelineStore((s) => s.zoomOut);
  const copySelection = useTimelineStore((s) => s.copySelection);
  const cutSelection = useTimelineStore((s) => s.cutSelection);
  const pasteFromClipboard = useTimelineStore((s) => s.pasteFromClipboard);
  const pasteIndicator = useTimelineStore((s) => s.pasteIndicator);
  const toggleSnap = useTimelineStore((s) => s.toggleSnap);

  const primaryTypeRef = useRef(useSelectionStore.getState().primaryType);
  const primaryIdsRef = useRef<string[]>(useSelectionStore.getState().primaryIds);
  primaryTypeRef.current = useSelectionStore((s) => s.primaryType);
  primaryIdsRef.current = useSelectionStore((s) => s.primaryIds);

  const previewMode = usePreviewStore((s) => s.mode);
  const assetType = usePreviewStore((s) => s.assetType);
  const togglePreviewPlayback = usePreviewStore((s) => s.togglePlayback);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (isAnyModalOpen()) {
        return;
      }

      const isModKey = e.ctrlKey || e.metaKey;

      switch (e.key.toLowerCase()) {
        case 'z':
          if (isModKey) {
            e.preventDefault();
            if (e.shiftKey) {
              const result = redo();
              if (result.changed) {
                useProjectStore.getState().afterUndoRedo(result.currentSnapshot);
              }
            } else {
              const result = undo();
              if (result.changed) {
                useProjectStore.getState().afterUndoRedo(result.currentSnapshot);
              }
            }
          }
          break;

        case 'y':
          if (isModKey) {
            e.preventDefault();
            const result = redo();
            if (result.changed) {
              useProjectStore.getState().afterUndoRedo(result.currentSnapshot);
            }
          }
          break;

        case 'a':
          if (isModKey) {
            e.preventDefault();
            const state = useTimelineStore.getState();
            const allFragmentIds = state.fragments.map(f => f.id);
            const allSceneIds = state.scenes.map(s => s.id);
            if (allFragmentIds.length > 0) {
              useSelectionStore.getState().selectFragments(allFragmentIds);
            } else if (allSceneIds.length > 0) {
              useSelectionStore.getState().selectScenes(allSceneIds);
            }
          } else {
            setToolMode('select');
          }
          break;

        case 'b':
          setToolMode('razor');
          break;

        case 'i':
          if (isModKey) break;
          e.preventDefault();
          handleInOutShortcut('in', e.altKey);
          break;

        case 'o':
          if (isModKey) break;
          e.preventDefault();
          handleInOutShortcut('out', e.altKey);
          break;

        case 'n':
          e.preventDefault();
          toggleSnap();
          break;

        case 'g':
          setToolMode('select');
          break;

        case 'c':
          if (isModKey) {
            e.preventDefault();
            copySelection();
          }
          break;

        case 'v':
          if (isModKey) {
            e.preventDefault();
            pasteFromClipboard();
          }
          break;

        case 'x':
          if (isModKey) {
            e.preventDefault();
            cutSelection();
          }
          break;

        case ' ':
          e.preventDefault();
          if (previewMode === 'asset' || previewMode === 'reference') {
            if (assetType !== 'image') {
              togglePreviewPlayback();
            }
          } else {
            toggleTimelinePlayback();
          }
          break;

        case 'arrowleft':
        case 'arrowright': {
          if (previewMode !== 'timeline' || isModKey) {
            break;
          }

          const timelineState = useTimelineStore.getState();
          if (timelineState.isPlaying) {
            break;
          }

          e.preventDefault();
          const direction = e.key.toLowerCase() === 'arrowright' ? 1 : -1;
          const handledByNativePreview = requestNativePreviewStepFrame(direction);
          if (!handledByNativePreview) {
            const fps = getEffectiveFps(useProjectStore.getState().currentProject?.settings.fps);
            const currentFrame = msToFrames(timelineState.getPlayheadRef(), fps);
            const targetFrame = Math.max(0, currentFrame + direction);
            timelineState.setPlayhead(framesToMs(targetFrame, fps));
          }
          break;
        }

        case 'escape':
          if (selectionBox) {
            cancelSelectionBox();
          } else if (draftFragment) {
            setDraftFragment(null);
          } else if (pasteIndicator) {
            useTimelineStore.getState().clearPasteIndicator();
          } else if (primaryIdsRef.current.length > 0) {
            useSelectionStore.getState().clear();
          } else {
            const { inPoint, outPoint } = useTimelineStore.getState();
            if (inPoint !== null || outPoint !== null) {
              useTimelineStore.getState().clearRange();
            }
          }
          break;

        case '+':
        case '=':
          e.preventDefault();
          zoomIn();
          break;

        case '-':
        case '_':
          e.preventDefault();
          zoomOut();
          break;

        case 'delete':
        case 'backspace':
          e.preventDefault();
          if (primaryTypeRef.current === 'fragment' && primaryIdsRef.current.length > 0) {
            useTimelineStore.getState().deleteFragments(primaryIdsRef.current);
            useSelectionStore.getState().clear();
          }
          if (primaryTypeRef.current === 'scene' && primaryIdsRef.current.length > 0) {
            useTimelineStore.getState().deleteScenes(primaryIdsRef.current);
            useSelectionStore.getState().clear();
          }
          break;
      }
    },
    [
      setToolMode,
      toggleTimelinePlayback,
      cancelSelectionBox,
      setDraftFragment,
      selectionBox,
      draftFragment,
      zoomIn,
      zoomOut,
      copySelection,
      cutSelection,
      pasteFromClipboard,
      pasteIndicator,
      previewMode,
      assetType,
      togglePreviewPlayback,
      toggleSnap,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
