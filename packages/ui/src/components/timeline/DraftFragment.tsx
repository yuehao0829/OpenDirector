import { useState } from 'react';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { DraftFragment as DraftFragmentType } from '@opendirector/core/types/timeline';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { TRACK_HEIGHT } from './constants';
import { parseAssetDragData, isDragCompatibleWithTrack, buildReferencesFromDragData } from './drag-types';

const DRAFT_THEME = {
  video: {
    border: 'border-amber-400 bg-amber-400/20',
    text: 'text-amber-400',
  },
  audio: {
    border: 'border-blue-400 bg-blue-400/20',
    text: 'text-blue-400',
  },
} as const;

interface DraftFragmentProps {
  draft: DraftFragmentType;
  zoom: number;
  scrollX: number;
  scrollY?: number;
  /** Visual Y position from TRACKS_AREA_OFFSET (calculated by TimelineCanvas) */
  visualY: number;
}

export function DraftFragment({ draft, zoom, scrollX, visualY }: DraftFragmentProps) {
  const { t } = useTranslation();
  const tracks = useTimelineStore((s) => s.tracks);
  const confirmDraftFragment = useTimelineStore((s) => s.confirmDraftFragment);

  const [isDragOver, setIsDragOver] = useState(false);

  const trackIndex = tracks.findIndex((t) => t.id === draft.trackId);
  if (trackIndex === -1) return null;

  // draft.start is time in ms, convert to pixel position (content coordinate)
  const left = (draft.start / 1000) * zoom;
  const width = (draft.duration / 1000) * zoom;
  const trackType = tracks[trackIndex].type;
  const draftLabel =
    trackType === 'video'
      ? t('timeline.draft.videoContainer')
      : t('timeline.draft.audioContainer');

  // Handle drag over for drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const dragData = parseAssetDragData(e.dataTransfer);
    if (!dragData || !isDragCompatibleWithTrack(dragData.type, trackType)) return;

    const references = buildReferencesFromDragData(dragData);
    confirmDraftFragment(dragData.name, references);
  };

  // Visual position formula (content coordinates, no header/offset):
  //   left = contentX
  //   top = visualY (calculated by parent based on grouped layout)
  return (
    <div
      className={clsx(
        'absolute rounded border-2 border-dashed z-15',
        isDragOver
          ? 'border-green-500 bg-green-500/20'
          : DRAFT_THEME[trackType].border
      )}
      style={{
        left,
        width: Math.max(width, 20),
        top: visualY + 1,
        height: TRACK_HEIGHT - 4,
      }}
      data-testid="draft-fragment"
      data-content-x={left}
      data-scroll-x={scrollX}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-center h-full">
        <span className={clsx('text-xs', isDragOver ? 'text-green-500' : DRAFT_THEME[trackType].text)}>
          {isDragOver ? t('timeline.draft.releaseToCreate') : draftLabel}
        </span>
      </div>
    </div>
  );
}
