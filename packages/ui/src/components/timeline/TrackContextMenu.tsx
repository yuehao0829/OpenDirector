import { useRef } from 'react';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useContextMenuClose } from '../../hooks/useContextMenuClose';

interface TrackContextMenuProps {
  x: number;
  y: number;
  trackId: string;
  onClose: () => void;
}

export function TrackContextMenu({ x, y, trackId, onClose }: TrackContextMenuProps) {
  const { t } = useTranslation();
  const tracks = useTimelineStore((s) => s.tracks);
  const insertTrackAfter = useTimelineStore((s) => s.insertTrackAfter);
  const deleteTrackWithOrderReindex = useTimelineStore((s) => s.deleteTrackWithOrderReindex);
  const menuRef = useRef<HTMLDivElement>(null);

  const targetTrack = tracks.find((t) => t.id === trackId);
  const sameTypeCount = targetTrack ? tracks.filter((t) => t.type === targetTrack.type).length : 0;
  const canDelete = sameTypeCount > 1;

  useContextMenuClose(menuRef, onClose);

  const handleInsert = () => {
    insertTrackAfter(trackId);
    onClose();
  };

  const handleDelete = () => {
    deleteTrackWithOrderReindex(trackId);
    onClose();
  };

  // Adjust position to stay within viewport
  const menuWidth = 140;
  const menuHeight = canDelete ? 80 : 40;
  const adjustedX = Math.min(x, window.innerWidth - menuWidth);
  const adjustedY = Math.min(y, window.innerHeight - menuHeight);

  if (!targetTrack) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[120px] bg-zinc-800 border border-zinc-700 rounded-md shadow-lg py-1"
      data-testid="track-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <button
        onClick={handleInsert}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Plus size={14} />
        <span>{t('timeline.contextMenu.newTrack')}</span>
      </button>
      {canDelete && (
        <button
          onClick={handleDelete}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-zinc-700 transition-colors"
        >
          <Trash2 size={14} />
          <span>{t('timeline.contextMenu.deleteTrack')}</span>
        </button>
      )}
    </div>
  );
}
