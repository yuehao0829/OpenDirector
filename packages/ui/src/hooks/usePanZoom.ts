import { useRef, useCallback, useEffect, useState } from 'react';
import type { CropRect } from '@opendirector/core/types/asset';
import { computeCropFrameRect, clampCropRect } from '../utils/crop';

interface UsePanZoomOptions {
  cropRect: CropRect;
  sourceWidth: number;
  sourceHeight: number;
  targetAspectRatio: number | null;
  onCropChange: (rect: CropRect) => void;
  containerWidth: number;
  containerHeight: number;
  /** When true, disable all pan/zoom interaction — input events become no-ops. */
  disabled?: boolean;
  /** The default crop rect (contain model) — used as the minimum zoom boundary. */
  defaultCropRect?: CropRect | null;
}

const MIN_CROP_DIM = 0.05;
const ZOOM_STEP = 0.03;

export function usePanZoom({
  cropRect,
  sourceWidth,
  sourceHeight,
  targetAspectRatio,
  onCropChange,
  containerWidth,
  containerHeight,
  disabled = false,
  defaultCropRect,
}: UsePanZoomOptions) {
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const cropRef = useRef(cropRect);
  const rafRef = useRef(0);
  const disabledRef = useRef(disabled);

  useEffect(() => {
    cropRef.current = cropRect;
  }, [cropRect]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  const flushUpdate = useCallback(() => {
    onCropChange(cropRef.current);
  }, [onCropChange]);

  const scheduleUpdate = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      flushUpdate();
    });
  }, [flushUpdate]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Default crop rect = maximum zoom-out boundary (contain model).
  // When the user zooms out, cropRect width/height cannot exceed this.
  const defaultCropRef = useRef(defaultCropRect);
  useEffect(() => { defaultCropRef.current = defaultCropRect; }, [defaultCropRect]);

  const applyPan = useCallback((dx: number, dy: number) => {
    if (disabledRef.current) return;
    const cr = cropRef.current;
    const defCr = defaultCropRef.current;
    // No panning at minimum zoom: the entire crop rect exactly matches the default bounds.
    if (defCr && cr.width === defCr.width && cr.height === defCr.height) return;

    const frame = computeCropFrameRect(containerWidth, containerHeight, targetAspectRatio);

    const dNormX = dx * cr.width / frame.width;
    const dNormY = dy * cr.height / frame.height;

    cropRef.current = clampCropRect({
      ...cr,
      x: cr.x - dNormX,
      y: cr.y - dNormY,
    });
    scheduleUpdate();
  }, [containerWidth, containerHeight, targetAspectRatio, scheduleUpdate]);

  const applyZoom = useCallback((delta: number, centerX: number, centerY: number) => {
    if (disabledRef.current) return;
    const cr = cropRef.current;
    const defCr = defaultCropRef.current;
    const frame = computeCropFrameRect(containerWidth, containerHeight, targetAspectRatio);

    const factor = delta > 0 ? (1 + ZOOM_STEP) : (1 - ZOOM_STEP);
    let newW = cr.width * factor;
    let newH = cr.height * factor;

    // Enforce minimum zoom: cropRect cannot exceed the default (contain) dimensions
    if (defCr) {
      newW = Math.min(newW, defCr.width);
      newH = Math.min(newH, defCr.height);
    }

    // Enforce maximum zoom: cropRect cannot shrink below minimum
    if (newW < MIN_CROP_DIM) newW = MIN_CROP_DIM;
    if (newH < MIN_CROP_DIM) newH = MIN_CROP_DIM;

    // Maintain aspect ratio lock (cropAr = targetAr / sourceAr)
    if (targetAspectRatio && sourceHeight > 0) {
      const sourceAr = sourceWidth / sourceHeight;
      const cropAr = targetAspectRatio / sourceAr;
      if (cropAr >= 1) {
        newH = newW / cropAr;
      } else {
        newW = newH * cropAr;
      }
      // Re-clamp after aspect ratio adjustment
      if (defCr) {
        newW = Math.min(newW, defCr.width);
        newH = Math.min(newH, defCr.height);
      }
    }

    if (Math.abs(newW - cr.width) < 0.0001 && Math.abs(newH - cr.height) < 0.0001) return;

    const mouseNormX = cr.x + (centerX - frame.x) / frame.width * cr.width;
    const mouseNormY = cr.y + (centerY - frame.y) / frame.height * cr.height;

    const newX = mouseNormX - (mouseNormX - cr.x) * (newW / cr.width);
    const newY = mouseNormY - (mouseNormY - cr.y) * (newH / cr.height);

    cropRef.current = clampCropRect({ x: newX, y: newY, width: newW, height: newH });
    scheduleUpdate();
  }, [containerWidth, containerHeight, targetAspectRatio, sourceWidth, sourceHeight, scheduleUpdate]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabledRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    setIsDragging(true);
    lastPosRef.current = { x: e.clientX, y: e.clientY };

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dx = ev.clientX - lastPosRef.current.x;
      const dy = ev.clientY - lastPosRef.current.y;
      lastPosRef.current = { x: ev.clientX, y: ev.clientY };
      applyPan(dx, dy);
    };

    const onUp = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [applyPan]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (disabledRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    applyZoom(e.deltaY, e.clientX - rect.left, e.clientY - rect.top);
  }, [applyZoom]);

  const lastTouchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabledRef.current) return;
    if (e.touches.length === 1) {
      isDraggingRef.current = true;
      setIsDragging(true);
      lastPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      isDraggingRef.current = false;
      setIsDragging(false);
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      lastTouchRef.current = {
        dist: Math.sqrt(dx * dx + dy * dy),
        cx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        cy: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (disabledRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.touches.length === 1 && isDraggingRef.current) {
      const dx = e.touches[0].clientX - lastPosRef.current.x;
      const dy = e.touches[0].clientY - lastPosRef.current.y;
      lastPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      applyPan(dx, dy);
    } else if (e.touches.length === 2 && lastTouchRef.current) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      const prevDist = lastTouchRef.current.dist;
      const pinchDelta = prevDist - dist;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      applyZoom(pinchDelta, cx - rect.left, cy - rect.top);

      const pdx = cx - lastTouchRef.current.cx;
      const pdy = cy - lastTouchRef.current.cy;
      if (Math.abs(pdx) > 0.5 || Math.abs(pdy) > 0.5) {
        applyPan(pdx, pdy);
      }

      lastTouchRef.current = { dist, cx, cy };
    }
  }, [applyPan, applyZoom]);

  const onTouchEnd = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
    lastTouchRef.current = null;
  }, []);

  return {
    onMouseDown,
    onWheel,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    cursor: isDragging ? 'grabbing' : 'grab',
  };
}
