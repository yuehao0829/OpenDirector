import { useRef, useCallback } from 'react';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { areFragmentsContiguous } from '@opendirector/core/utils/timeline';
import { Combine, Scissors, Copy, Trash2, Split, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useContextMenuClose } from '../../hooks/useContextMenuClose';

interface FragmentContextMenuProps {
  x: number;
  y: number;
  fragmentId: string;
  rightClickTime: number;
  onClose: () => void;
}

export function FragmentContextMenu({ x, y, fragmentId, rightClickTime, onClose }: FragmentContextMenuProps) {
  const { t } = useTranslation();
  const selection = useSelectionStore((s) => s.primaryType === 'fragment' ? s.primaryIds : []);
  const fragments = useTimelineStore((s) => s.fragments);
  const tracks = useTimelineStore((s) => s.tracks);
  const getAssetById = useAssetStore((s) => s.getAssetById);
  const mergeFragments = useTimelineStore((s) => s.mergeFragments);
  const cutSelection = useTimelineStore((s) => s.cutSelection);
  const copySelection = useTimelineStore((s) => s.copySelection);
  const deleteFragments = useTimelineStore((s) => s.deleteFragments);
  const splitFragment = useTimelineStore((s) => s.splitFragment);
  const separateAudio = useTimelineStore((s) => s.separateAudio);
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

    return areFragmentsContiguous(selectedFragments);
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
    deleteFragments(selection);
    onClose();
  };

  const handleSplit = () => {
    splitFragment(fragmentId, rightClickTime);
    onClose();
  };

  const canSeparateAudio = (() => {
    if (selection.length !== 1) return false;
    const fragment = fragments.find((f) => f.id === fragmentId);
    if (!fragment) return false;
    const track = tracks.find((t) => t.id === fragment.trackId);
    if (!track || track.type !== 'video') return false;
    if (!fragment.sourceAssetId || fragment.muted) return false;
    const asset = getAssetById(fragment.sourceAssetId);
    if (!asset || !asset.audioChannels || asset.audioChannels <= 0) return false;
    return true;
  })();

  const handleSeparateAudio = () => {
    separateAudio(fragmentId);
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
          <span>{t('timeline.contextMenu.merge')}</span>
        </button>
      )}
      {canMerge() && <div className="border-t border-zinc-700 my-1" />}
      <button
        onClick={handleCut}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Scissors size={14} />
        <span className="flex-1 text-left">{t('timeline.contextMenu.cut')}</span>
        <span className="text-zinc-500 text-xs">Ctrl+X</span>
      </button>
      <button
        onClick={handleCopy}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Copy size={14} />
        <span className="flex-1 text-left">{t('timeline.contextMenu.copy')}</span>
        <span className="text-zinc-500 text-xs">Ctrl+C</span>
      </button>
      {canSeparateAudio && (
        <button
          onClick={handleSeparateAudio}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          <VolumeX size={14} />
          <span>{t('timeline.contextMenu.separateAudio')}</span>
        </button>
      )}
      <div className="border-t border-zinc-700 my-1" />
      <button
        onClick={handleDelete}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700 transition-colors"
      >
        <Trash2 size={14} />
        <span className="flex-1 text-left">{t('common.delete')}</span>
        <span className="text-zinc-500 text-xs">Delete</span>
      </button>
      <button
        onClick={handleSplit}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        <Split size={14} />
        <span className="flex-1 text-left">{t('timeline.contextMenu.split')}</span>
        <span className="text-zinc-500 text-xs">
          {t('timeline.contextMenu.splitAtClickPosition')}
        </span>
      </button>
    </div>
  );
}
