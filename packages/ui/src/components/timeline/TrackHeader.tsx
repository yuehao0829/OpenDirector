import { Video, Music } from 'lucide-react';
import { TRACK_HEADER_WIDTH, TRACK_HEIGHT } from './constants';

interface TrackHeaderProps {
  track: {
    id: string;
    type: 'video' | 'audio';
    order: number;
  };
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function TrackHeader({ track, onContextMenu }: TrackHeaderProps) {
  const renderTrackIcon = () => {
    switch (track.type) {
      case 'audio':
        return <Music size={14} className="text-green-400" />;
      case 'video':
      default:
        return <Video size={14} className="text-zinc-400" />;
    }
  };

  return (
    <div
      className="bg-zinc-900 border-b border-r border-zinc-800 flex items-center justify-center"
      style={{ width: TRACK_HEADER_WIDTH, height: TRACK_HEIGHT }}
      data-track-id={track.id}
      data-testid={`track-header-${track.type}-${track.order}`}
      onContextMenu={onContextMenu ? (e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      } : undefined}
    >
      {renderTrackIcon()}
    </div>
  );
}
