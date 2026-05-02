import { useEffect, useCallback, useRef } from 'react';
import { usePreviewStore } from '@opendirector/core/stores/previewStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { requestNativePreviewStepFrame, useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { redo, undo } from '@opendirector/core/stores/undoManager';
import { isAnyModalOpen } from '../components/common/Modal';

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
  const clipboard = useTimelineStore((s) => s.clipboard);
  const pasteIndicator = useTimelineStore((s) => s.pasteIndicator);
  const toggleSnap = useTimelineStore((s) => s.toggleSnap);

  // Use refs for primary selection state to avoid unnecessary callback rebuilds
  const primaryTypeRef = useRef(useSelectionStore.getState().primaryType);
  const primaryIdsRef = useRef<string[]>(useSelectionStore.getState().primaryIds);
  primaryTypeRef.current = useSelectionStore((s) => s.primaryType);
  primaryIdsRef.current = useSelectionStore((s) => s.primaryIds);

  // Preview store for asset mode playback
  const previewMode = usePreviewStore((s) => s.mode);
  const assetType = usePreviewStore((s) => s.assetType);
  const togglePreviewPlayback = usePreviewStore((s) => s.togglePlayback);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore if typing in input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Ignore all shortcuts when any modal is open
      if (isAnyModalOpen()) {
        return;
      }

      const isModKey = e.ctrlKey || e.metaKey;

      switch (e.key.toLowerCase()) {
        case 'z':
          if (isModKey) {
            e.preventDefault();
            if (e.shiftKey) {
              // Ctrl/Cmd+Shift+Z: Redo
              const result = redo();
              if (result.changed) {
                useProjectStore.getState().afterUndoRedo(result.currentSnapshot);
              }
            } else {
              // Ctrl/Cmd+Z: Undo
              const result = undo();
              if (result.changed) {
                useProjectStore.getState().afterUndoRedo(result.currentSnapshot);
              }
            }
          }
          break;

        case 'y':
          if (isModKey) {
            // Ctrl/Cmd+Y: Redo
            e.preventDefault();
            const result = redo();
            if (result.changed) {
              useProjectStore.getState().afterUndoRedo(result.currentSnapshot);
            }
          }
          break;

        case 'a':
          if (isModKey) {
            // Ctrl/Cmd+A: Select all
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

        case 'n':
          // Toggle snap
          e.preventDefault();
          toggleSnap();
          break;

        case 'g':
          // TODO: Merge mode - for now just use select mode
          setToolMode('select');
          break;

        case 'c':
          if (isModKey) {
            // Ctrl/Cmd+C: Copy
            e.preventDefault();
            copySelection();
          }
          break;

        case 'v':
          if (isModKey) {
            // Ctrl/Cmd+V: Paste
            e.preventDefault();
            pasteFromClipboard();
          }
          break;

        case 'x':
          if (isModKey) {
            // Ctrl/Cmd+X: Cut
            e.preventDefault();
            cutSelection();
          }
          break;

        case ' ':
          e.preventDefault();
          // Route spacebar to appropriate playback based on preview mode
          if (previewMode === 'asset' || previewMode === 'reference') {
            // Block play/pause for image assets
            if (assetType !== 'image') {
              togglePreviewPlayback();
            }
          } else {
            toggleTimelinePlayback();
          }
          break;

        case 'arrowleft':
        case 'arrowright':
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
            const fps = Math.max(1, useProjectStore.getState().currentProject?.settings.fps ?? 30);
            const frameDurationMs = 1000 / fps;
            timelineState.setPlayhead(
              Math.max(0, timelineState.getPlayheadRef() + frameDurationMs * direction),
            );
          }
          break;

        case 'escape':
          // Cancel current operation
          if (selectionBox) {
            cancelSelectionBox();
          } else if (draftFragment) {
            setDraftFragment(null);
          } else if (pasteIndicator) {
            useTimelineStore.getState().clearPasteIndicator();
          } else if (primaryIdsRef.current.length > 0) {
            useSelectionStore.getState().clear();
          }
          break;

        case '+':
        case '=':
          // Zoom in with + or = key
          e.preventDefault();
          zoomIn();
          break;

        case '-':
        case '_':
          // Zoom out with - or _ key
          e.preventDefault();
          zoomOut();
          break;

        case 'delete':
        case 'backspace':
          // Delete selected items using batch delete
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
      clipboard,
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
