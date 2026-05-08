import { usePreviewStore } from '@opendirector/core/stores/previewStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  MousePointer2,
  Scissors,
  Play,
  Square,
  ZoomIn,
  ZoomOut,
  Magnet,
} from 'lucide-react';
import type { ToolMode } from '@opendirector/core/types/timeline';

export function Toolbar() {
  const { t } = useTranslation();
  const toolMode = useTimelineStore((s) => s.toolMode);
  const setToolMode = useTimelineStore((s) => s.setToolMode);
  const snapEnabled = useTimelineStore((s) => s.snapEnabled);
  const toggleSnap = useTimelineStore((s) => s.toggleSnap);
  const toggleTimelinePlayback = useTimelineStore((s) => s.togglePlayback);
  const timelineIsPlaying = useTimelineStore((s) => s.isPlaying);
  const zoomIn = useTimelineStore((s) => s.zoomIn);
  const zoomOut = useTimelineStore((s) => s.zoomOut);
  const setZoomFromSlider = useTimelineStore((s) => s.setZoomFromSlider);
  const getZoomSliderValue = useTimelineStore((s) => s.getZoomSliderValue);

  const previewMode = usePreviewStore((s) => s.mode);
  const previewIsPlaying = usePreviewStore((s) => s.isPlaying);
  const togglePreviewPlayback = usePreviewStore((s) => s.togglePlayback);
  const assetType = usePreviewStore((s) => s.assetType);

  const isIndependentPlayback = previewMode === 'asset' || previewMode === 'reference';
  const isPlaying = isIndependentPlayback ? previewIsPlaying : timelineIsPlaying;
  const isImageMode = isIndependentPlayback && assetType === 'image';

  const handlePlayPause = () => {
    if (isImageMode) return;
    if (isIndependentPlayback) {
      togglePreviewPlayback();
    } else {
      toggleTimelinePlayback();
    }
  };

  const sliderValue = getZoomSliderValue();

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setZoomFromSlider(Number(e.target.value));
  };

  const tools: { mode: ToolMode; icon: React.ReactNode; label: string; shortcut: string }[] = [
    {
      mode: 'select',
      icon: <MousePointer2 size={16} />,
      label: t('timeline.toolbar.select'),
      shortcut: 'A',
    },
    {
      mode: 'razor',
      icon: <Scissors size={16} />,
      label: t('timeline.toolbar.razor'),
      shortcut: 'B',
    },
  ];

  return (
    <div className="flex items-center justify-between px-2 py-1 bg-zinc-900 border-b border-zinc-800" data-testid="timeline-toolbar">
      {/* Left side: Tool buttons */}
      <div className="flex items-center gap-0.5 mr-2">
        {tools.map((tool) => (
          <button
            key={tool.mode}
            onClick={() => setToolMode(tool.mode)}
            className={clsx(
              'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
              toolMode === tool.mode
                ? 'bg-blue-600 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
            )}
            title={`${tool.label} (${tool.shortcut})`}
          >
            {tool.icon}
            <span className="hidden sm:inline">{tool.label}</span>
          </button>
        ))}

        {/* Separator */}
        <div className="w-px h-5 bg-zinc-700 mx-1" />

        {/* Play/Pause Button */}
        <button
          onClick={handlePlayPause}
          className={clsx(
            'flex items-center justify-center w-7 h-7 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors',
            isImageMode && 'opacity-50 cursor-not-allowed pointer-events-none'
          )}
          title={`${t('timeline.toolbar.playPause')} (Space)`}
        >
          {isPlaying ? <Square size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
      </div>

      {/* Right side: Snap + Zoom controls */}
      <div className="flex items-center gap-2">
        {/* Snap toggle button */}
        <button
          onClick={toggleSnap}
          className={clsx(
            'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
            snapEnabled
              ? 'bg-blue-600 text-white'
              : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
          )}
          title={`${t('timeline.toolbar.snap')} (N)`}
        >
          <Magnet size={16} />
          <span className="hidden sm:inline">{t('timeline.toolbar.snap')}</span>
        </button>

        <div className="w-px h-5 bg-zinc-700 ml-2 mr-0" />

        {/* Zoom Out Button */}
        <button
          onClick={zoomOut}
          className="flex items-center justify-center w-7 h-7 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          title={`${t('timeline.toolbar.zoomOut')} (Zoom Out)`}
        >
          <ZoomOut size={16} />
        </button>

        {/* Zoom Slider */}
        <div className="flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="100"
            value={sliderValue}
            onChange={handleSliderChange}
            className="w-24 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            title={t('timeline.toolbar.zoomLevel')}
          />
        </div>

        {/* Zoom In Button */}
        <button
          onClick={zoomIn}
          className="flex items-center justify-center w-7 h-7 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          title={`${t('timeline.toolbar.zoomIn')} (Zoom In)`}
        >
          <ZoomIn size={16} />
        </button>
      </div>
    </div>
  );
}
