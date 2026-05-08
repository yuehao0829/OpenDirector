import { useRef, useCallback, useState, useEffect } from 'react';
import type { TrimRange } from '@opendirector/core/types/asset';
import { clamp } from '@opendirector/core/utils/common';
import { formatTimecode, formatTimecodeCentiseconds } from '@opendirector/core/utils/time';
import { Check, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const MIN_INTERVAL_MS = 2000;

interface PlaybackControlsProps {
  currentTime: number;  // milliseconds
  duration: number;     // milliseconds
  mode: 'asset' | 'timeline' | 'reference';
  previewType?: 'video' | 'audio' | 'image';
  onSeek?: (time: number) => void;
  trimRange?: TrimRange;
  onTrimChange?: (range: TrimRange) => void;
  applyButton?: boolean;
  onApply?: () => void;
  isApplying?: boolean;
  applyDisabled?: boolean;
}

export function PlaybackControls({
  currentTime,
  duration,
  mode,
  previewType,
  onSeek,
  trimRange,
  onTrimChange,
  applyButton,
  onApply,
  isApplying,
  applyDisabled,
}: PlaybackControlsProps) {
  const { t } = useTranslation();
  const progressRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const dragStartRef = useRef({ mouseX: 0, startMs: 0, endMs: 0 });

  const hasTrim = !!trimRange && !!onTrimChange;
  const trimStart = trimRange ? Math.max(0, trimRange.startMs) : 0;
  const trimEnd = trimRange ? Math.min(duration, trimRange.endMs) : duration;
  const trimStartPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const trimEndPct = duration > 0 ? (trimEnd / duration) * 100 : 100;

  const formatFn = previewType === 'audio' ? formatTimecodeCentiseconds : formatTimecode;

  const isRelativeTime = mode === 'reference' && hasTrim;
  const timeDisplay = isRelativeTime
    ? formatFn(Math.max(0, currentTime - trimStart))
    : formatFn(currentTime);
  const durationDisplay = isRelativeTime
    ? formatFn(trimEnd - trimStart)
    : formatFn(duration || 0);

  const showProgress = (mode === 'asset' && previewType === 'video')
    || (mode === 'reference' && (previewType === 'video' || previewType === 'audio'));
  const rawProgress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const progress = hasTrim
    ? Math.max(trimStartPct, Math.min(rawProgress, trimEndPct))
    : rawProgress;

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !progressRef.current || duration <= 0) return;

    const rect = progressRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickTime = (x / rect.width) * duration;
    const clampedTime = hasTrim
      ? clamp(clickTime, trimStart, trimEnd)
      : Math.max(0, Math.min(clickTime, duration));

    onSeek(clampedTime);
  }, [onSeek, duration, hasTrim, trimStart, trimEnd]);

  const handleProgressDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragging || e.buttons !== 1) return;
    handleProgressClick(e);
  }, [dragging, handleProgressClick]);

  // Trim handle drag
  const handleTrimMouseDown = useCallback((edge: 'start' | 'end') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(edge);
    dragStartRef.current = { mouseX: e.clientX, startMs: trimStart, endMs: trimEnd };
  }, [trimStart, trimEnd]);

  useEffect(() => {
    if (!dragging || !onTrimChange) return;

    const lastRoundedRef = { startMs: dragStartRef.current.startMs, endMs: dragStartRef.current.endMs };

    const handleMouseMove = (e: MouseEvent) => {
      const bar = progressRef.current;
      if (!bar || duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      const dx = e.clientX - dragStartRef.current.mouseX;
      const dMs = (dx / rect.width) * duration;

      if (dragging === 'start') {
        const newStart = Math.round(clamp(dragStartRef.current.startMs + dMs, 0, dragStartRef.current.endMs - MIN_INTERVAL_MS));
        if (newStart !== lastRoundedRef.startMs) {
          lastRoundedRef.startMs = newStart;
          onTrimChange({ startMs: newStart, endMs: dragStartRef.current.endMs });
        }
      } else {
        const newEnd = Math.round(clamp(dragStartRef.current.endMs + dMs, dragStartRef.current.startMs + MIN_INTERVAL_MS, duration));
        if (newEnd !== lastRoundedRef.endMs) {
          lastRoundedRef.endMs = newEnd;
          onTrimChange({ startMs: dragStartRef.current.startMs, endMs: newEnd });
        }
      }
    };

    const handleMouseUp = () => setDragging(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, duration, onTrimChange]);

  return (
    <div className="flex items-center px-4 py-2 bg-zinc-900 border-t border-zinc-800 shrink-0" data-testid="playback-controls">
      {/* Time Display - Left */}
      <div className="text-sm text-zinc-300 font-mono tracking-wider shrink-0 mr-3">
        {timeDisplay} / {durationDisplay}
      </div>

      {/* Progress Bar */}
      {showProgress ? (
        <div
          ref={progressRef}
          className="flex-1 h-5 flex items-center cursor-pointer relative"
          onClick={handleProgressClick}
          onMouseMove={handleProgressDrag}
        >
          {/* Track background */}
          <div className="w-full h-1.5 bg-zinc-700 rounded-full relative">
            {/* Trim mask: left side */}
            {hasTrim && (
              <div
                className="absolute inset-y-0 left-0 bg-zinc-900/70 rounded-l-full pointer-events-none"
                style={{ width: `${trimStartPct}%` }}
              />
            )}
            {/* Trim mask: right side */}
            {hasTrim && (
              <div
                className="absolute inset-y-0 right-0 bg-zinc-900/70 rounded-r-full pointer-events-none"
                style={{ width: `${100 - trimEndPct}%` }}
              />
            )}
            {/* Progress fill */}
            <div
              className="absolute inset-y-0 bg-red-500 rounded-full pointer-events-none"
              style={{
                left: hasTrim ? `${trimStartPct}%` : 0,
                width: hasTrim ? `${Math.max(0, progress - trimStartPct)}%` : `${progress}%`,
              }}
            />
          </div>
          {/* Trim handles */}
          {hasTrim && (['start', 'end'] as const).map((edge) => {
            const pct = edge === 'start' ? trimStartPct : trimEndPct;
            return (
              <div
                key={edge}
                className={`absolute w-3 h-full cursor-ew-resize z-20 ${dragging === edge ? 'z-30' : ''}`}
                style={{ left: `calc(${pct}% - 6px)` }}
                onMouseDown={handleTrimMouseDown(edge)}
              >
                <div className="w-1.5 h-4 bg-blue-500 hover:bg-blue-400 transition-colors rounded-sm absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
              </div>
            );
          })}
        </div>
      ) : (
        /* Spacer */
        <div className="flex-1" />
      )}

      {/* Apply button (reference mode) */}
      {applyButton && (
        <button
          className={`ml-3 text-xs px-2.5 py-1 rounded transition-colors shrink-0 flex items-center gap-1 ${
            applyDisabled || isApplying
              ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          }`}
          disabled={applyDisabled || isApplying}
          onClick={onApply}
          title={applyDisabled ? t('preview.applyHint') : ''}
        >
          {isApplying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {isApplying ? t('preview.applying') : t('common.apply')}
        </button>
      )}
    </div>
  );
}
