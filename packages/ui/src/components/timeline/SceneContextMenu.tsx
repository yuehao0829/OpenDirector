import { useRef, useCallback } from 'react';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { Combine, Split, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useContextMenuClose } from '../../hooks/useContextMenuClose';

interface SceneContextMenuProps {
  x: number;
  y: number;
  sceneId: string;
  rightClickTime: number;
  onClose: () => void;
}

export function SceneContextMenu({ x, y, sceneId, rightClickTime, onClose }: SceneContextMenuProps) {
  const { t } = useTranslation();
  const scenes = useTimelineStore((s) => s.scenes);
  const sceneSelection = useSelectionStore((s) => s.primaryType === 'scene' ? s.primaryIds : []);
  const splitScene = useTimelineStore((s) => s.splitScene);
  const deleteScene = useTimelineStore((s) => s.deleteScene);
  const mergeScenes = useTimelineStore((s) => s.mergeScenes);
  const menuRef = useRef<HTMLDivElement>(null);

  useContextMenuClose(menuRef, onClose);

  const canDelete = scenes.length > 1;

  // Check if selected scenes can be merged (adjacent, no gaps)
  const canMerge = useCallback(() => {
    if (sceneSelection.length < 2) return false;

    const selectedScenes = scenes
      .filter((s) => sceneSelection.includes(s.id))
      .sort((a, b) => a.start - b.start);

    if (selectedScenes.length !== sceneSelection.length) return false;

    // Check if scenes are adjacent (no gaps)
    for (let i = 1; i < selectedScenes.length; i++) {
      const prevEnd = selectedScenes[i - 1].start + selectedScenes[i - 1].duration;
      if (prevEnd < selectedScenes[i].start) return false;
    }

    return true;
  }, [sceneSelection, scenes]);

  const handleMerge = () => {
    mergeScenes(sceneSelection);
    onClose();
  };

  const handleSplit = () => {
    splitScene(sceneId, rightClickTime);
    onClose();
  };

  const handleDelete = () => {
    deleteScene(sceneId);
    onClose();
  };

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 150);
  const adjustedY = Math.min(y, window.innerHeight - 120);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[140px] bg-zinc-800 border border-zinc-700 rounded-md shadow-lg py-1"
      data-testid="scene-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {canMerge() && (
        <button
          onClick={handleMerge}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          <Combine size={14} />
          <span>{t('timeline.contextMenu.merge')}</span>
        </button>
      )}
      {canMerge() && <div className="border-t border-zinc-700 my-1" />}
      <button
        onClick={handleSplit}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Split size={14} />
        <span className="flex-1 text-left">{t('timeline.contextMenu.splitScene')}</span>
        <span className="text-zinc-500 text-xs">
          {t('timeline.contextMenu.splitAtClickPosition')}
        </span>
      </button>
      <button
        onClick={handleDelete}
        disabled={!canDelete}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Trash2 size={14} />
        <span className="flex-1 text-left">{t('timeline.contextMenu.deleteScene')}</span>
        <span className="text-zinc-500 text-xs">
          {canDelete ? '' : t('timeline.contextMenu.deleteSceneHint')}
        </span>
      </button>
    </div>
  );
}
