import { useState, useEffect, useCallback, useRef } from 'react';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { getTauriWindow } from '../utils/tauri-window';

export interface WindowCloseHandlerReturn {
  showCloseConfirm: boolean;
  handleSaveAndClose: () => Promise<void>;
  handleDiscardAndClose: () => Promise<void>;
  handleCloseCancel: () => void;
}

export function useWindowCloseHandler(): WindowCloseHandlerReturn {
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const closeProject = useProjectStore((s) => s.closeProject);
  const saveProject = useProjectStore((s) => s.saveProject);
  const cleanupTempFolder = useProjectStore((s) => s.cleanupTempFolder);
  const unlistenRef = useRef<(() => void) | null>(null);

  const destroyWindow = useCallback(async () => {
    const win = await getTauriWindow();
    await win.destroy();
  }, []);

  const handleSaveAndClose = useCallback(async () => {
    try {
      await saveProject();
    } catch (err) {
      console.error('Save failed:', err);
      // Stay open on save failure
      setShowCloseConfirm(false);
      return;
    }
    closeProject();
    await destroyWindow();
  }, [saveProject, closeProject, destroyWindow]);

  const handleDiscardAndClose = useCallback(async () => {
    await cleanupTempFolder();
    closeProject();
    await destroyWindow();
  }, [cleanupTempFolder, closeProject, destroyWindow]);

  const handleCloseCancel = useCallback(() => {
    setShowCloseConfirm(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const win = await getTauriWindow();
      if (cancelled) return;

      const unlisten = await win.onCloseRequested(async (event) => {
        const state = useProjectStore.getState();
        if (!state.isDirty) {
          return;
        }
        // Dirty → prevent and show modal
        event.preventDefault();
        setShowCloseConfirm(true);
      });

      if (cancelled) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
    })();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, []);

  return { showCloseConfirm, handleSaveAndClose, handleDiscardAndClose, handleCloseCancel };
}
