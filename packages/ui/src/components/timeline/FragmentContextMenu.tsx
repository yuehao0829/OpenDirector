import { useRef, useCallback } from 'react';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { Combine, Scissors, Copy, Trash2, Split } from 'lucide-react';
import { useContextMenuClose } from '../../hooks/useContextMenuClose';

interface FragmentContextMenuProps {
  x: number;
  y: number;
  fragmentId: string;
  rightClickTime: number;
  onClose: () => void;
}

export function FragmentContextMenu({ x, y, fragmentId, rightClickTime, onClose }: FragmentContextMenuProps) {
  const selection = useSelectionStore((s) => s.primaryType === 'fragment' ? s.primaryIds : []);
  const fragments = useTimelineStore((s) => s.fragments);
  const mergeFragments = useTimelineStore((s) => s.mergeFragments);
  const cutSelection = useTimelineStore((s) => s.cutSelection);
  const copySelection = useTimelineStore((s) => s.copySelection);
  const deleteFragment = useTimelineStore((s) => s.deleteFragment);
  const splitFragment = useTimelineStore((s) => s.splitFragment);
  const menuRef = useRef<HTMLDivElement>(null);

  useContextMenuClose(menuRef, onClose);

  // Check if selected fragments can be merged (adjacent or overlapping on same track)
  const canMerge = useCallback(() => {
    if (selection.length < 2) return false;

    const selectedFragments = fragments
      .filter((f) => selection.includes(f.id))
      .sort((a, b) => a.start - b.start);

    if (selectedFragments.length !== selection.length) return false;

    // All fragments must be on the same track
    const trackId = selectedFragments[0].trackId;
    if (!selectedFragments.every((f) => f.trackId === trackId)) return false;

    // Check if fragments are adjacent or overlapping
    for (let i = 1; i < selectedFragments.length; i++) {
      const prevEnd = selectedFragments[i - 1].start + selectedFragments[i - 1].duration;
      const currStart = selectedFragments[i].start;
      if (prevEnd < currStart) return false;
    }

    return true;
  }, [selection, fragments]);

  const handleMerge = () => {
    mergeFragments(selection);
    onClose();
  };

  const handleCut = () => {
    cutSelection();
    onClose();
  };

  const handleCopy = () => {
    copySelection();
    onClose();
  };

  const handleDelete = () => {
    for (const id of selection) {
      deleteFragment(id);
    }
    onClose();
  };

  const handleSplit = () => {
    splitFragment(fragmentId, rightClickTime);
    onClose();
  };

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 180);
  const adjustedY = Math.min(y, window.innerHeight - 200);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] bg-zinc-800 border border-zinc-700 rounded-md shadow-lg py-1"
      data-testid="fragment-context-menu"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {canMerge() && (
        <button
          onClick={handleMerge}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          <Combine size={14} />
          <span>合并</span>
        </button>
      )}
      {canMerge() && <div className="border-t border-zinc-700 my-1" />}
      <button
        onClick={handleCut}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Scissors size={14} />
        <span className="flex-1 text-left">剪切</span>
        <span className="text-zinc-500 text-xs">Ctrl+X</span>
      </button>
      <button
        onClick={handleCopy}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Copy size={14} />
        <span className="flex-1 text-left">复制</span>
        <span className="text-zinc-500 text-xs">Ctrl+C</span>
      </button>
      <div className="border-t border-zinc-700 my-1" />
      <button
        onClick={handleDelete}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700 transition-colors"
      >
        <Trash2 size={14} />
        <span className="flex-1 text-left">删除</span>
        <span className="text-zinc-500 text-xs">Delete</span>
      </button>
      <button
        onClick={handleSplit}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Split size={14} />
        <span className="flex-1 text-left">分割</span>
        <span className="text-zinc-500 text-xs">按右键位置</span>
      </button>
    </div>
  );
}
