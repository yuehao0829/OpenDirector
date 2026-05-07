import { useState, useEffect, useCallback, useRef } from 'react';
import type { CropRect, Reference } from '@opendirector/core/types/asset';
import { computeInitialCropRect, isSameCropRect } from '../utils/crop';

interface UseReferenceCropOptions {
  reference: Reference;
  referenceIdentity?: string;
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
  referenceIdentity,
  imageInfo,
  targetAspectRatio,
  onCropChange,
  enabled = true,
}: UseReferenceCropOptions): UseReferenceCropResult {
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [defaultCropRect, setDefaultCropRect] = useState<CropRect | null>(null);
  const syncedFromStoreRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const cropRectRef = useRef<CropRect | null>(null);
  cropRectRef.current = cropRect;
  const identity = referenceIdentity ?? `${reference.id}:${reference.assetId}`;

  // When a crop session opens or its identity changes, rebuild the session from the
  // latest external state. This keeps saved cropRect visible when reopening the overlay
  // and prevents crop state from leaking across different references that reuse the
  // same reference.id / assetId pair.
  useEffect(() => {
    if (!enabled) {
      setCropRect(null);
      setDefaultCropRect(null);
      syncedFromStoreRef.current = false;
      hasInitializedRef.current = false;
      return;
    }

    if (imageInfo.naturalWidth === 0 || imageInfo.naturalHeight === 0) return;

    const defaultCr = computeInitialCropRect(
      imageInfo.naturalWidth,
      imageInfo.naturalHeight,
      targetAspectRatio,
    );
    const nextCropRect = reference.cropRect ?? defaultCr;

    setDefaultCropRect((prev) => (isSameCropRect(prev, defaultCr) ? prev : defaultCr));
    setCropRect((prev) => (isSameCropRect(prev, nextCropRect) ? prev : nextCropRect));
    syncedFromStoreRef.current = false;
    hasInitializedRef.current = false;
  }, [
    enabled,
    imageInfo.naturalWidth,
    imageInfo.naturalHeight,
    targetAspectRatio,
    identity,
  ]);

  // Keep the local crop session in sync with external reference.cropRect changes on the same
  // reference, including undo/redo paths that clear cropRect back to the default.
  useEffect(() => {
    if (!enabled || !defaultCropRect) return;

    const nextCropRect = reference.cropRect ?? defaultCropRect;
    if (isSameCropRect(cropRectRef.current, nextCropRect)) {
      return;
    }

    syncedFromStoreRef.current = true;
    setCropRect(nextCropRect);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cropRect is compared via ref to avoid reacting to own state changes
  }, [enabled, reference.cropRect, defaultCropRect]);

  const resetCrop = useCallback(() => {
    if (imageInfo.naturalWidth === 0 || imageInfo.naturalHeight === 0) return;

    const defaultCr = computeInitialCropRect(
      imageInfo.naturalWidth,
      imageInfo.naturalHeight,
      targetAspectRatio,
    );
    hasInitializedRef.current = true;
    setDefaultCropRect(defaultCr);
    setCropRect(defaultCr);
  }, [imageInfo.naturalWidth, imageInfo.naturalHeight, targetAspectRatio]);

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

  const isDefaultCrop = !cropRect || !defaultCropRect || isSameCropRect(cropRect, defaultCropRect);

  return enabled
    ? { cropRect, defaultCropRect, isDefaultCrop, resetCrop }
    : { cropRect: null, defaultCropRect: null, isDefaultCrop: true, resetCrop: () => {} };
}
