import { useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CropRect, Reference } from '@opendirector/core/types/asset';
import { useReferenceCrop } from './useReferenceCrop';

interface HarnessState {
  cropRect: CropRect | null;
  defaultCropRect: CropRect | null;
  isDefaultCrop: boolean;
}

function HookHarness({
  reference,
  referenceIdentity,
  onStateChange,
}: {
  reference: Reference;
  referenceIdentity: string;
  onStateChange: (state: HarnessState) => void;
}) {
  const state = useReferenceCrop({
    reference,
    referenceIdentity,
    imageInfo: { naturalWidth: 1000, naturalHeight: 500 },
    targetAspectRatio: 1,
    onCropChange: vi.fn(),
    enabled: true,
  });

  useEffect(() => {
    onStateChange({
      cropRect: state.cropRect,
      defaultCropRect: state.defaultCropRect,
      isDefaultCrop: state.isDefaultCrop,
    });
  }, [state.cropRect, state.defaultCropRect, state.isDefaultCrop, onStateChange]);

  return null;
}

describe('useReferenceCrop', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestState: HarnessState | null;
  let handleStateChange: (state: HarnessState) => void;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
    handleStateChange = (state: HarnessState) => {
      latestState = state;
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('initializes from the stored crop rect when opening a crop session', async () => {
    const storedCropRect = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };

    await act(async () => {
      root.render(
        <HookHarness
          reference={{
            id: 'ref-1',
            assetId: 'asset-1',
            type: 'video',
            cropRect: storedCropRect,
          }}
          referenceIdentity="fragment-1:ref-1:asset-1"
          onStateChange={handleStateChange}
        />,
      );
    });

    expect(latestState?.defaultCropRect).not.toBeNull();
    expect(latestState?.cropRect).toEqual(storedCropRect);
    expect(latestState?.isDefaultCrop).toBe(false);
  });

  it('resets crop state when switching to another fragment with the same reference id', async () => {
    const storedCropRect = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };

    await act(async () => {
      root.render(
        <HookHarness
          reference={{
            id: 'ref-1',
            assetId: 'asset-1',
            type: 'video',
            cropRect: storedCropRect,
          }}
          referenceIdentity="fragment-1:ref-1:asset-1"
          onStateChange={handleStateChange}
        />,
      );
    });

    expect(latestState?.cropRect).toEqual(storedCropRect);

    await act(async () => {
      root.render(
        <HookHarness
          reference={{
            id: 'ref-1',
            assetId: 'asset-1',
            type: 'video',
          }}
          referenceIdentity="fragment-2:ref-1:asset-1"
          onStateChange={handleStateChange}
        />,
      );
    });

    expect(latestState?.defaultCropRect).not.toBeNull();
    expect(latestState?.cropRect).toEqual(latestState?.defaultCropRect ?? null);
    expect(latestState?.isDefaultCrop).toBe(true);
  });

  it('restores the default crop when the same reference clears cropRect externally', async () => {
    const storedCropRect = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };

    await act(async () => {
      root.render(
        <HookHarness
          reference={{
            id: 'ref-1',
            assetId: 'asset-1',
            type: 'video',
            cropRect: storedCropRect,
          }}
          referenceIdentity="fragment-1:ref-1:asset-1"
          onStateChange={handleStateChange}
        />,
      );
    });

    expect(latestState?.cropRect).toEqual(storedCropRect);

    await act(async () => {
      root.render(
        <HookHarness
          reference={{
            id: 'ref-1',
            assetId: 'asset-1',
            type: 'video',
          }}
          referenceIdentity="fragment-1:ref-1:asset-1"
          onStateChange={handleStateChange}
        />,
      );
    });

    expect(latestState?.defaultCropRect).not.toBeNull();
    expect(latestState?.cropRect).toEqual(latestState?.defaultCropRect ?? null);
    expect(latestState?.isDefaultCrop).toBe(true);
  });
});
