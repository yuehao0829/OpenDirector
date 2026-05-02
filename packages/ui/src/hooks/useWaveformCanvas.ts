/**
 * useWaveformCanvas Hook
 *
 * Shared hook for loading peak data binary files and rendering waveform on canvas.
 * Supports DPR-aware rendering and ResizeObserver for automatic redraw.
 */

import { useEffect, useRef, useCallback } from 'react';

export interface WaveformData {
  peakCount: number;
  mins: Float32Array;
  maxs: Float32Array;
}

export interface WaveformCanvasOptions {
  barWidth?: number;
  gap?: number;
  color?: string;
  bgColor?: string;
  padding?: number;
}

export interface UseWaveformCanvasParams {
  dataPath: string | undefined;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  options?: WaveformCanvasOptions;
}

/**
 * Parse a binary peak data file into min/max arrays.
 * Format: [4 bytes peak_count u32 LE] [peak_count * 4 bytes mins f32 LE] [peak_count * 4 bytes maxs f32 LE]
 */
export async function parsePeakData(buffer: ArrayBuffer): Promise<WaveformData> {
  const view = new DataView(buffer);
  const peakCount = view.getUint32(0, true);
  const mins = new Float32Array(buffer, 4, peakCount);
  const maxs = new Float32Array(buffer, 4 + peakCount * 4, peakCount);
  return { peakCount, mins, maxs };
}

/**
 * Load and parse a peak data file from a file path (Tauri webview URL).
 */
export async function loadPeakData(dataPath: string): Promise<WaveformData> {
  const response = await fetch(dataPath);
  if (!response.ok) throw new Error(`Failed to fetch peak data: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return parsePeakData(buffer);
}

/**
 * Draw waveform on a canvas using min/max peak data.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: WaveformData,
  options: WaveformCanvasOptions = {}
) {
  const {
    barWidth = 2,
    gap = 1,
    color = '#3b82f6',
    bgColor = '#1e293b',
  } = options;

  const totalBarWidth = barWidth + gap;
  const barCount = Math.floor(width / totalBarWidth);

  // Clear
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  if (data.peakCount === 0 || barCount === 0) return;

  // Find global max for normalization
  let globalMax = 0;
  for (let i = 0; i < data.peakCount; i++) {
    const absMin = Math.abs(data.mins[i]);
    const absMax = Math.abs(data.maxs[i]);
    if (absMin > globalMax) globalMax = absMin;
    if (absMax > globalMax) globalMax = absMax;
  }
  if (globalMax === 0) return;

  const halfH = height / 2;
  const step = data.peakCount / barCount;

  ctx.fillStyle = color;

  for (let i = 0; i < barCount; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(Math.floor((i + 1) * step), data.peakCount);
    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      if (data.mins[j] < min) min = data.mins[j];
      if (data.maxs[j] > max) max = data.maxs[j];
    }

    const yMin = halfH - (max / globalMax) * halfH * 0.9;
    const yMax = halfH + (-min / globalMax) * halfH * 0.9;

    const x = i * totalBarWidth;
    ctx.fillRect(x, yMin, barWidth, yMax - yMin || 1);
  }
}

/**
 * Hook: load peak data file and draw waveform on canvas.
 * Handles DPR scaling and ResizeObserver.
 */
export function useWaveformCanvas({
  dataPath,
  canvasRef,
  containerRef,
  options,
}: UseWaveformCanvasParams) {
  const dataRef = useRef<WaveformData | null>(null);

  // Load peak data file
  useEffect(() => {
    if (!dataPath) {
      dataRef.current = null;
      return;
    }

    let cancelled = false;
    loadPeakData(dataPath)
      .then((data) => {
        if (!cancelled) {
          dataRef.current = data;
          // Trigger redraw after data loads
          requestRedraw();
        }
      })
      .catch((err) => {
        console.warn('[useWaveformCanvas] Failed to load peak data:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [dataPath]);

  const requestRedraw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    if (dataRef.current) {
      drawWaveform(ctx, rect.width, rect.height, dataRef.current, options);
    }
  }, [canvasRef, containerRef, options]);

  // ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      requestRedraw();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [containerRef, requestRedraw]);

  // Redraw when data changes
  useEffect(() => {
    requestRedraw();
  }, [dataPath, requestRedraw]);
}
