/**
 * Format milliseconds to a compact duration string.
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
 * @param fps - frames per second (default 30)
 */
export function formatTimecode(ms: number, fps = 30): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor((ms % 1000) / (1000 / fps));

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
 * Snap time to nearest frame
 */
export function snapToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps) * (1000 / fps);
}

/**
 * Get time ruler marks for a zoom level
 */
export function getTimeRulerMarks(
  startTime: number,
  endTime: number,
  pixelsPerMs: number
): { time: number; label: string; major: boolean }[] {
  const marks: { time: number; label: string; major: boolean }[] = [];

  // Determine interval based on zoom
  let interval: number;
  if (pixelsPerMs > 0.1) {
    interval = 1000; // 1 second
  } else if (pixelsPerMs > 0.02) {
    interval = 5000; // 5 seconds
  } else if (pixelsPerMs > 0.005) {
    interval = 10000; // 10 seconds
  } else {
    interval = 30000; // 30 seconds
  }

  const startMark = Math.floor(startTime / interval) * interval;

  for (let time = startMark; time <= endTime; time += interval) {
    if (time >= startTime) {
      marks.push({
        time,
        label: formatTime(time, false),
        major: time % (interval * 5) === 0,
      });
    }
  }

  return marks;
}
