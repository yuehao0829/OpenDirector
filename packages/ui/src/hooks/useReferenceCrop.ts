import { useState, useEffect, useCallback, useRef } from 'react';
import type { CropRect, Reference } from '@opendirector/core/types/asset';
import { computeInitialCropRect } from '../utils/crop';

interface UseReferenceCropOptions {
  reference: Reference;
  imageInfo: { naturalWidth: number; naturalHeight: number };
  targetAspectRatio: number | null;
  onCropChange: (rect: CropRect) => void;
  /** When false, the hook returns null and does not call onCropChange. */
  enabled?: boolean;
}

interface UseReferenceCropResult {
  cropRect: CropRect | null;
  defaultCropRect: CropRect | null;
  /** Whether cropRect matches the initial default (user hasn't changed it). */
  isDefaultCrop: boolean;
  resetCrop: () => void;
}

export function useReferenceCrop({
  reference,
  imageInfo,
  targetAspectRatio,
  onCropChange,
  enabled = true,
}: UseReferenceCropOptions): UseReferenceCropResult {
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [defaultCropRect, setDefaultCropRect] = useState<CropRect | null>(null);
  const prevEnabledRef = useRef(enabled);
  const prevRefIdRef = useRef<string | null>(null);
  const syncedFromStoreRef = useRef(false);
  const justEnabledRef = useRef(false);

  // When enabled transitions from false→true, or reference.id changes, compute fresh defaults
  useEffect(() => {
    if (!enabled) {
      setCropRect(null);
      setDefaultCropRect(null);
      prevEnabledRef.current = false;
      justEnabledRef.current = false;
      return;
    }

    if (imageInfo.naturalWidth === 0 || imageInfo.naturalHeight === 0) return;

    const defaultCr = computeInitialCropRect(
      imageInfo.naturalWidth,
      imageInfo.naturalHeight,
      targetAspectRatio,
    );

    const enabledJustTurnedOn = !prevEnabledRef.current;
    const refIdChanged = prevRefIdRef.current !== reference.id;

    if (enabledJustTurnedOn || refIdChanged) {
      setDefaultCropRect(defaultCr);
      setCropRect(defaultCr);
      justEnabledRef.current = enabledJustTurnedOn;
    }

    prevEnabledRef.current = true;
    prevRefIdRef.current = reference.id;
  }, [enabled, imageInfo.naturalWidth, imageInfo.naturalHeight, targetAspectRatio, reference.id]);

  // Sync internal cropRect when external reference.cropRect changes
  // (e.g. from CropOverlay pan/zoom writing to the store),
  // but not on the same commit as an enable transition (to avoid overriding the fresh default)
  useEffect(() => {
    if (!enabled) return;
    if (justEnabledRef.current) {
      justEnabledRef.current = false;
      return;
    }
    if (reference.cropRect) {
      syncedFromStoreRef.current = true;
      setCropRect(reference.cropRect);
    }
  }, [enabled, reference.cropRect]);

  const resetCrop = useCallback(() => {
    if (imageInfo.naturalWidth === 0 || imageInfo.naturalHeight === 0) return;

    const defaultCr = computeInitialCropRect(
      imageInfo.naturalWidth,
      imageInfo.naturalHeight,
      targetAspectRatio,
    );
    setDefaultCropRect(defaultCr);
    setCropRect(defaultCr);
  }, [imageInfo.naturalWidth, imageInfo.naturalHeight, targetAspectRatio]);

  // Track whether the initial crop has been set (to skip onCropChange for the default value)
  const hasInitializedRef = useRef(false);

  // Expose cropRect externally via onCropChange when it changes (for CropOverlay pan/zoom)
  // but only after initialization, and not when the change came from a store sync
  useEffect(() => {
    if (!enabled || !cropRect) return;
    if (syncedFromStoreRef.current) {
      syncedFromStoreRef.current = false;
      return; // skip — this change originated from the store, don't write it back
    }
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      return; // skip first call (initial default)
    }
    onCropChange(cropRect);
  }, [cropRect, enabled]); // intentionally exclude onCropChange to avoid loops

  // Reset initialization flag when disabled
  useEffect(() => {
    if (!enabled) {
      hasInitializedRef.current = false;
    }
  }, [enabled]);

  const isDefaultCrop = !cropRect || !defaultCropRect || (
    Math.abs(cropRect.x - defaultCropRect.x) < 0.001 &&
    Math.abs(cropRect.y - defaultCropRect.y) < 0.001 &&
    Math.abs(cropRect.width - defaultCropRect.width) < 0.001 &&
    Math.abs(cropRect.height - defaultCropRect.height) < 0.001
  );

  return enabled
    ? { cropRect, defaultCropRect, isDefaultCrop, resetCrop }
    : { cropRect: null, defaultCropRect: null, isDefaultCrop: true, resetCrop: () => {} };
}
