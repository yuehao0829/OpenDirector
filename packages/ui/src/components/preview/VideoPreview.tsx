import { useRef, useEffect, useCallback } from 'react';

interface VideoPreviewProps {
  src: string;
  isPlaying: boolean;
  currentTime: number;
  seekCount?: number;
  playbackRate?: number;
  dataTestId?: string;
  onLoadedMetadata?: () => void;
  onLoadedData?: () => void;
  onCanPlay?: () => void;
  onSeeked?: () => void;
  onTimeUpdate?: (time: number) => void;
  onDurationChange?: (duration: number) => void;
  onEnded?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  /** Optional CSS overrides for the video element (used by reference crop pan/zoom) */
  styleOverride?: React.CSSProperties;
}

export function VideoPreview({
  src,
  isPlaying,
  currentTime,
  seekCount = 0,
  playbackRate = 1,
  dataTestId = 'video-preview',
  onLoadedMetadata,
  onLoadedData,
  onCanPlay,
  onSeeked,
  onTimeUpdate,
  onDurationChange,
  onEnded,
  onPlay,
  onPause,
  styleOverride,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.play().catch(() => {
        onPause?.();
      });
    } else {
      video.pause();
    }
  }, [isPlaying, onPause]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (seekCount === 0 && isPlaying) {
      return;
    }

    const targetTime = currentTime / 1000;
    if (Math.abs(video.currentTime - targetTime) <= 0.05) {
      return;
    }

    video.currentTime = targetTime;
  }, [currentTime, isPlaying, seekCount]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    onTimeUpdate?.(video.currentTime * 1000);
  }, [onTimeUpdate]);

  const handleDurationChange = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    onDurationChange?.(video.duration * 1000);
  }, [onDurationChange]);

  const handleEnded = useCallback(() => {
    onEnded?.();
  }, [onEnded]);
  const handlePlay = useCallback(() => {
    onPlay?.();
  }, [onPlay]);
  const handlePause = useCallback(() => {
    onPause?.();
  }, [onPause]);

  return (
    <video
      ref={videoRef}
      src={src}
      className="max-w-full max-h-full object-contain rounded"
      style={styleOverride}
      playsInline
      preload="auto"
      data-testid={dataTestId}
      onLoadedMetadata={onLoadedMetadata}
      onLoadedData={onLoadedData}
      onCanPlay={onCanPlay}
      onSeeked={onSeeked}
      onTimeUpdate={handleTimeUpdate}
      onDurationChange={handleDurationChange}
      onEnded={handleEnded}
      onPlay={handlePlay}
      onPause={handlePause}
    />
  );
}
