import { useRef } from 'react';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { ClipboardPaste, Plus } from 'lucide-react';
import { useContextMenuClose } from '../../hooks/useContextMenuClose';

interface TrackAreaContextMenuProps {
  x: number;
  y: number;
  trackId: string;
  rightClickTime: number;
  onClose: () => void;
}

export function TrackAreaContextMenu({ x, y, trackId, rightClickTime, onClose }: TrackAreaContextMenuProps) {
  const clipboard = useTimelineStore((s) => s.clipboard);
  const setPasteIndicator = useTimelineStore((s) => s.setPasteIndicator);
  const pasteFromClipboard = useTimelineStore((s) => s.pasteFromClipboard);
  const createFragment = useTimelineStore((s) => s.createFragment);
  const menuRef = useRef<HTMLDivElement>(null);

  useContextMenuClose(menuRef, onClose);

  const hasClipboard = !!(clipboard && (clipboard.fragments.length > 0 || clipboard.scenes.length > 0));

  const handlePaste = () => {
    setPasteIndicator({ time: rightClickTime, trackId });
    pasteFromClipboard();
    onClose();
  };

  const handleCreate = () => {
    createFragment(trackId, rightClickTime);
    onClose();
  };

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 150);
  const adjustedY = Math.min(y, window.innerHeight - 80);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[140px] bg-zinc-800 border border-zinc-700 rounded-md shadow-lg py-1"
      data-testid="track-area-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <button
        onClick={handlePaste}
        disabled={!hasClipboard}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ClipboardPaste size={14} />
        <span>粘贴</span>
      </button>
      <div className="border-t border-zinc-700 my-1" />
      <button
        onClick={handleCreate}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Plus size={14} />
        <span>新建 Fragment</span>
      </button>
    </div>
  );
}
