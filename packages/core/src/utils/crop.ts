import { clamp } from './common';
import type { CropRect } from '../types';

/**
 * The crop frame is centered, matches the target aspect ratio, and fills the container maximally.
 */
export function computeCropFrameRect(
  containerW: number,
  containerH: number,
  targetAr: number | null,
): { x: number; y: number; width: number; height: number } {
  if (!targetAr || containerW === 0 || containerH === 0) {
    return { x: 0, y: 0, width: containerW, height: containerH };
  }

  const containerAr = containerW / containerH;

  if (containerAr > targetAr) {
    const height = containerH;
    const width = height * targetAr;
    const x = (containerW - width) / 2;
    return { x, y: 0, width, height };
  } else {
    const width = containerW;
    const height = width / targetAr;
    const y = (containerH - height) / 2;
    return { x: 0, y, width, height };
  }
}

/**
 * Compute the visible portion of a crop rect, clamping to the [0,1] source bounds.
 */
export function computeVisibleCropSize(cr: { x: number; y: number; width: number; height: number }): {
  visibleW: number;
  visibleH: number;
} {
  return {
    visibleW: Math.min(cr.width, 1 - Math.max(0, cr.x)),
    visibleH: Math.min(cr.height, 1 - Math.max(0, cr.y)),
  };
}

/**
 * Clamp CropRect so the image doesn't slide completely out of the crop frame.
 * Allows width/height > 1 (fit-to-frame state where image is smaller than frame),
 * and < 1 (zoomed-in state). The constraint is that some part of the image
 * must be visible: the image rect [x, x+width] must overlap [0, 1].
 */
export function clampCropRect(
  cr: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const xMin = cr.width >= 1 ? 1 - cr.width : 0;
  const xMax = cr.width >= 1 ? 0 : 1 - cr.width;
  const yMin = cr.height >= 1 ? 1 - cr.height : 0;
  const yMax = cr.height >= 1 ? 0 : 1 - cr.height;
  const x = clamp(cr.x, xMin, xMax);
  const y = clamp(cr.y, yMin, yMax);
  return { x, y, width: cr.width, height: cr.height };
}

/**
 * Compute contain-layout: position and size of an image contain-fitted within a container.
 */
export function computeContainLayout(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(containerW / imgW, containerH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return {
    x: (containerW - width) / 2,
    y: (containerH - height) / 2,
    width,
    height,
  };
}

/**
 * Compute the initial crop rect for a source image and target aspect ratio.
 * Container-independent: the crop rect is purely a function of source dimensions
 * and target aspect ratio. This makes the crop rect stable across window resizes
 * and consistent with backend crop output.
 *
 * The crop rect represents the largest centered rectangle of the source image
 * that matches the target aspect ratio. If no target aspect ratio is specified,
 * the entire source is used.
 */
export function computeInitialCropRect(
  sourceW: number,
  sourceH: number,
  targetAr: number | null,
): CropRect {
  if (!targetAr || sourceW === 0 || sourceH === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  const sourceAr = sourceW / sourceH;

  if (sourceAr > targetAr) {
    const w = targetAr / sourceAr;
    return { x: (1 - w) / 2, y: 0, width: w, height: 1 };
  } else {
    const h = sourceAr / targetAr;
    return { x: 0, y: (1 - h) / 2, width: 1, height: h };
  }
}

/**
 * Compute draw parameters for WYSIWYG crop rendering.
 * The cropRect area of the source image is mapped directly to fill the crop frame.
 * This produces output visually identical to the backend crop result.
 */
export function computeCropDrawParams(
  cropRect: CropRect,
  sourceW: number,
  sourceH: number,
  containerW: number,
  containerH: number,
  targetAr: number | null,
): { drawX: number; drawY: number; drawW: number; drawH: number; frame: { x: number; y: number; width: number; height: number } } {
  const frame = computeCropFrameRect(containerW, containerH, targetAr);

  const scaleX = frame.width / (cropRect.width * sourceW);
  const scaleY = frame.height / (cropRect.height * sourceH);
  const scale = Math.min(scaleX, scaleY);

  const drawW = sourceW * scale;
  const drawH = sourceH * scale;
  const drawX = frame.x - cropRect.x * sourceW * scale;
  const drawY = frame.y - cropRect.y * sourceH * scale;

  return { drawX, drawY, drawW, drawH, frame };
}

export function isSameCropRect(left?: CropRect | null, right?: CropRect | null): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    Math.abs(left.x - right.x) < 0.001 &&
    Math.abs(left.y - right.y) < 0.001 &&
    Math.abs(left.width - right.width) < 0.001 &&
    Math.abs(left.height - right.height) < 0.001
  );
}

