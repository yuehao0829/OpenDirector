import { DEFAULT_FPS } from '../constants';

/**
 * Format milliseconds to compact duration string.
 * Sub-60s: "12.5s", 60s+: "2:30", undefined/0: "--"
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === 0) return '--';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Extract a comparable timestamp (ms) from a generation-like object.
 * Falls back to createdAt when completedAt is absent.
 */
export function getGenerationTimestamp(gen: { completedAt?: Date; createdAt?: Date }): number {
  return (gen.completedAt ?? gen.createdAt)?.getTime() ?? 0;
}

/**
 * Format milliseconds to time string (MM:SS.ms or HH:MM:SS.ms)
 */
export function formatTime(ms: number, showMs = true): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor((ms % 1000) / 10);

  if (hours > 0) {
    const msStr = showMs ? `.${milliseconds.toString().padStart(2, '0')}` : '';
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}${msStr}`;
  }

  const msStr = showMs ? `.${milliseconds.toString().padStart(2, '0')}` : '';
  return `${minutes}:${seconds.toString().padStart(2, '0')}${msStr}`;
}

/**
 * Format milliseconds to timecode (HH:MM:SS:FF - hours:minutes:seconds:frames)
 * @param ms - milliseconds
 * @param fps - frames per second (default: DEFAULT_FPS)
 */
export function formatTimecode(ms: number, fps = DEFAULT_FPS): string {
  const totalFrames = Math.round((ms / 1000) * fps);
  const hours = Math.floor(totalFrames / (fps * 3600));
  const minutes = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
  const seconds = Math.floor((totalFrames % (fps * 60)) / fps);
  const frames = totalFrames % fps;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

/**
 * Format milliseconds to timecode with centiseconds (HH:MM:SS:CC)
 * Used for audio assets where centisecond precision is more appropriate than frames.
 */
export function formatTimecodeCentiseconds(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((ms % 1000) / 10);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${centiseconds.toString().padStart(2, '0')}`;
}

/**
 * Format a Date to a filesystem-safe timestamp string.
 * Replaces colons and dots with hyphens for cross-platform path safety.
 */
export function formatFsTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Parse time string to milliseconds
 */
export function parseTime(str: string): number {
  const parts = str.split(':').map(Number);
  let ms = 0;

  if (parts.length === 3) {
    // HH:MM:SS
    ms = parts[0] * 3600000 + parts[1] * 60000 + parts[2] * 1000;
  } else if (parts.length === 2) {
    // MM:SS
    ms = parts[0] * 60000 + parts[1] * 1000;
  }

  // Handle milliseconds after decimal
  const decimalMatch = str.match(/\.(\d+)$/);
  if (decimalMatch) {
    ms += parseInt(decimalMatch[1].padEnd(3, '0').slice(0, 3), 10);
  }

  return ms;
}

/**
 * Convert frames to milliseconds
 */
export function framesToMs(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1000);
}

/**
 * Convert milliseconds to frames
 */
export function msToFrames(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

/**
 * Normalize fps value: ensure it's a positive finite number, falling back to DEFAULT_FPS.
 */
export function getEffectiveFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) return DEFAULT_FPS;
  return fps;
}

/**
 * Snap time to nearest frame
 */
export function snapToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps) * (1000 / fps);
}
