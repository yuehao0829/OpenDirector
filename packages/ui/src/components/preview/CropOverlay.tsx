import { useRef, useEffect } from 'react';
import { computeCropFrameRect } from '../../utils/crop';
import { usePanZoom } from '../../hooks/usePanZoom';
import type { CropRect } from '@opendirector/core/types/asset';

interface CropOverlayProps {
  containerWidth: number;
  containerHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  cropRect: CropRect;
  onCropChange: (rect: CropRect) => void;
  aspectRatio?: number | null;
  disabled?: boolean;
  /** The default crop rect (contain model) — used as the minimum zoom boundary. */
  defaultCropRect?: CropRect | null;
}

export function CropOverlay({
  containerWidth,
  containerHeight,
  sourceWidth,
  sourceHeight,
  cropRect,
  onCropChange,
  aspectRatio,
  disabled,
  defaultCropRect,
}: CropOverlayProps) {
  const frame = computeCropFrameRect(containerWidth, containerHeight, aspectRatio ?? null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const { onMouseDown, onWheel, onTouchStart, onTouchMove, onTouchEnd, cursor } = usePanZoom({
    cropRect,
    sourceWidth,
    sourceHeight,
    targetAspectRatio: aspectRatio ?? null,
    onCropChange,
    containerWidth,
    containerHeight,
    disabled,
    defaultCropRect,
  });

  // React's onWheel is passive in React 18, making preventDefault() a no-op.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el || disabled) return;
    el.addEventListener('wheel', onWheel as unknown as EventListener, { passive: false });
    return () => el.removeEventListener('wheel', onWheel as unknown as EventListener);
  }, [onWheel, disabled]);

  // Mask regions (4 rectangles around the crop frame)
  const topMask = { left: 0, top: 0, width: '100%', height: frame.y };
  const bottomMask = { left: 0, top: frame.y + frame.height, width: '100%', height: containerHeight - frame.y - frame.height };
  const leftMask = { left: 0, top: frame.y, width: frame.x, height: frame.height };
  const rightMask = { left: frame.x + frame.width, top: frame.y, width: containerWidth - frame.x - frame.width, height: frame.height };

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0"
      style={{ pointerEvents: disabled ? 'none' : 'auto', cursor: disabled ? 'default' : cursor }}
      onMouseDown={disabled ? undefined : onMouseDown}
      onTouchStart={disabled ? undefined : onTouchStart}
      onTouchMove={disabled ? undefined : onTouchMove}
      onTouchEnd={disabled ? undefined : onTouchEnd}
    >
      {/* Dark masks outside the crop frame */}
      <div className="absolute bg-black/50" style={topMask as React.CSSProperties} />
      <div className="absolute bg-black/50" style={bottomMask as React.CSSProperties} />
      <div className="absolute bg-black/50" style={leftMask as React.CSSProperties} />
      <div className="absolute bg-black/50" style={rightMask as React.CSSProperties} />

      {/* Crop frame border + drag area */}
      <div
        className="absolute border-2 border-blue-500"
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          cursor: disabled ? 'default' : cursor,
        }}
      />
    </div>
  );
}
