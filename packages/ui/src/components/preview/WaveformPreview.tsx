/**
 * WaveformPreview Component
 *
 * Audio visualization with waveform display:
 * - If waveformDataPath is provided (Tauri/desktop), load peak data and draw on canvas
 * - Otherwise, decode audio data using Web Audio API and draw on canvas
 * - Show playhead marker at current time (driven by rAF for smoothness)
 * - Click on waveform to seek
 */

import { useRef, useEffect, useCallback } from 'react';
import { toWebViewUrl } from '@opendirector/core/utils/platform';
import { useWaveformCanvas } from '../../hooks/useWaveformCanvas';

interface WaveformPreviewProps {
  src: string;
  currentTime: number;  // milliseconds
  duration: number;     // milliseconds
  isPlaying: boolean;
  onSeek: (time: number) => void;
  onTimeUpdate?: (time: number) => void;
  onEnded?: () => void;
  waveformDataPath?: string;
}

export function WaveformPreview({
  src,
  currentTime,
  duration,
  isPlaying,
  onSeek,
  onTimeUpdate,
  onEnded,
  waveformDataPath,
}: WaveformPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);

  // Use shared hook for peak data rendering (handles fetch, parse, ResizeObserver, DPR)
  const peakDataUrl = waveformDataPath ? toWebViewUrl(waveformDataPath) : undefined;
  useWaveformCanvas({
    dataPath: peakDataUrl,
    canvasRef,
    containerRef,
    options: { barWidth: 2, gap: 1, color: '#3b82f6', bgColor: 'transparent' },
  });

  // rAF loop: directly update playhead position + report time to parent
  useEffect(() => {
    if (!isPlaying) {
      // When paused, snap playhead to the latest currentTime from props
      const audio = audioRef.current;
      if (audio && playheadRef.current) {
        const dur = audio.duration || duration / 1000 || 1;
        playheadRef.current.style.left = `${(audio.currentTime / dur) * 100}%`;
      }
      return;
    }

    let animationId: number;
    let cancelled = false;

    const animate = () => {
      if (cancelled) return;

      const audio = audioRef.current;
      const playhead = playheadRef.current;
      if (audio && playhead) {
        const dur = audio.duration || duration / 1000 || 1;
        playhead.style.left = `${(audio.currentTime / dur) * 100}%`;
        onTimeUpdate?.(audio.currentTime * 1000);
      }

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => {
      cancelled = true;
      cancelAnimationFrame(animationId);
    };
  }, [isPlaying, duration, onTimeUpdate]);

  // Handle ended event
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      onEnded?.();
    };

    audio.addEventListener('ended', handleEnded);
    return () => {
      audio.removeEventListener('ended', handleEnded);
    };
  }, [onEnded]);

  // Handle click to seek
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !duration) return;

    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickTime = (x / rect.width) * duration;

    onSeek(Math.max(0, Math.min(clickTime, duration)));
  }, [duration, onSeek]);

  // Handle audio playback (play/pause/seek)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const audioTime = currentTime / 1000;
    if (Math.abs(audio.currentTime - audioTime) > 0.1) {
      audio.currentTime = audioTime;
    }

    if (isPlaying) {
      audio.play().catch(() => {
        // Auto-play may be blocked
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, currentTime]);

  // Snap playhead to currentTime on seek (non-playing state)
  useEffect(() => {
    if (isPlaying) return;
    const playhead = playheadRef.current;
    if (!playhead) return;
    const effectiveDuration = duration || 1;
    playhead.style.left = `${(currentTime / effectiveDuration) * 100}%`;
  }, [currentTime, duration, isPlaying]);

  return (
    <div className="w-full h-2/3 max-h-2/3 rounded overflow-hidden relative cursor-pointer"
         onClick={handleClick}
         data-testid="waveform-preview">
      <audio ref={audioRef} src={src} />
      <div ref={containerRef} className="w-full h-full">
        <canvas
          ref={canvasRef}
          className="block w-full h-full"
        />
      </div>
      {/* Playhead overlay */}
      <div
        ref={playheadRef}
        className="absolute inset-y-0 w-0.5 bg-white pointer-events-none"
        style={{ left: 0 }}
      />
    </div>
  );
}
