import { useRef, useEffect, useState, useCallback } from 'react';
import type { CropRect } from '@opendirector/core/types/asset';
import { computeCropDrawParams, computeContainLayout, parseAspectRatio } from '../utils/crop';

interface UseImageCanvasOptions {
  src: string;
  cropRect?: CropRect;
  targetAspectRatio?: string | null;
}

interface ImageInfo {
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

interface UseImageCanvasResult {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  imageInfo: ImageInfo;
  containerSize: { width: number; height: number };
  isLoading: boolean;
}

export function useImageCanvas({ src, cropRect, targetAspectRatio }: UseImageCanvasOptions): UseImageCanvasResult {
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const containerRef = useRef<HTMLDivElement>(null!);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageInfo, setImageInfo] = useState<ImageInfo>({ width: 0, height: 0, naturalWidth: 0, naturalHeight: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [isLoading, setIsLoading] = useState(true);

  // Store targetAspectRatio in a ref so draw can access latest value
  // without being a dependency that triggers image re-load
  const targetArRef = useRef(targetAspectRatio);
  useEffect(() => {
    targetArRef.current = targetAspectRatio;
  }, [targetAspectRatio]);

  // Store cropRect in a ref so the resize observer callback
  // always uses the latest values without needing them as dependencies
  const cropRectRef = useRef(cropRect);
  useEffect(() => { cropRectRef.current = cropRect; }, [cropRect]);

  const draw = useCallback(() => {
    const cr = cropRectRef.current;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const img = imageRef.current;
    if (!canvas || !container || !img || !img.complete || img.naturalWidth === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const containerW = rect.width;
    const containerH = rect.height;

    // Only resize canvas when dimensions actually change (avoid clearing context unnecessarily)
    const needsResize = canvas.width !== containerW * dpr || canvas.height !== containerH * dpr;
    if (needsResize) {
      canvas.width = containerW * dpr;
      canvas.height = containerH * dpr;
      canvas.style.width = `${containerW}px`;
      canvas.style.height = `${containerH}px`;
      setContainerSize(prev =>
        (prev.width === containerW && prev.height === containerH) ? prev : { width: containerW, height: containerH }
      );
      setImageInfo(prev =>
        (prev.width === containerW && prev.height === containerH) ? prev : { ...prev, width: containerW, height: containerH }
      );
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, containerW, containerH);

    const targetAr = parseAspectRatio(targetArRef.current);

    if (cr) {
      // WYSIWYG crop: the cropRect area of the source image maps directly to the crop frame
      const { drawX, drawY, drawW, drawH, frame: cropFrame } = computeCropDrawParams(
        cr, img.naturalWidth, img.naturalHeight, containerW, containerH, targetAr,
      );

      // Draw image clipped to crop frame
      ctx.save();
      ctx.beginPath();
      ctx.rect(cropFrame.x, cropFrame.y, cropFrame.width, cropFrame.height);
      ctx.clip();
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      ctx.restore();

      // Dark mask outside crop frame
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      // Top
      ctx.fillRect(0, 0, containerW, cropFrame.y);
      // Bottom
      ctx.fillRect(0, cropFrame.y + cropFrame.height, containerW, containerH - cropFrame.y - cropFrame.height);
      // Left
      ctx.fillRect(0, cropFrame.y, cropFrame.x, cropFrame.height);
      // Right
      ctx.fillRect(cropFrame.x + cropFrame.width, cropFrame.y, containerW - cropFrame.x - cropFrame.width, cropFrame.height);
    } else {
      const { x, y, width, height } = computeContainLayout(containerW, containerH, img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, x, y, width, height);
    }

    ctx.restore();
  }, []);

  // Load the image (only depends on src)
  useEffect(() => {
    setIsLoading(true);
    const img = new Image();
    imageRef.current = img;

    img.onload = () => {
      setIsLoading(false);
      const rect = containerRef.current?.getBoundingClientRect();
      setImageInfo({
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      });
      draw();
    };

    img.onerror = () => {
      setIsLoading(false);
    };

    img.src = src;

    return () => {
      img.onload = null;
      img.onerror = null;
      img.src = '';
      imageRef.current = null;
    };
  }, [src, draw]);

  // Redraw when crop or targetAspectRatio changes
  useEffect(() => {
    draw();
  }, [cropRect, targetAspectRatio, draw]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      draw();
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [draw]);

  return {
    canvasRef,
    containerRef,
    imageInfo,
    containerSize,
    isLoading,
  };
}
