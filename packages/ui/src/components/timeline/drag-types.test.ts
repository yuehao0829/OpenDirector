import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAGMENT_DURATION_MS,
  resolveDroppedFragmentDuration,
  type AssetDragData,
} from './drag-types';

function makeDragData(overrides: Partial<AssetDragData> = {}): AssetDragData {
  return {
    id: 'asset-1',
    type: 'video',
    source: 'original',
    name: 'clip.mp4',
    duration: 5000,
    ...overrides,
  };
}

describe('resolveDroppedFragmentDuration', () => {
  it('prefers the latest asset duration over stale drag payload duration', () => {
    expect(
      resolveDroppedFragmentDuration(
        makeDragData({ duration: undefined }),
        Infinity,
        2400,
      ),
    ).toBe(2400);
  });

  it('allows short source-backed clips to land at their real duration', () => {
    expect(
      resolveDroppedFragmentDuration(
        makeDragData({ duration: 320 }),
        Infinity,
      ),
    ).toBe(320);
  });

  it('rejects gaps that are smaller than the full short source duration', () => {
    expect(
      resolveDroppedFragmentDuration(
        makeDragData({ duration: 320 }),
        200,
      ),
    ).toBeNull();
  });

  it('keeps the default duration for image and multi-asset drops', () => {
    expect(
      resolveDroppedFragmentDuration(
        makeDragData({ type: 'image', duration: undefined }),
        Infinity,
      ),
    ).toBe(DEFAULT_FRAGMENT_DURATION_MS);

    expect(
      resolveDroppedFragmentDuration(
        makeDragData({
          additionalAssets: [{
            id: 'asset-2',
            type: 'image',
            source: 'original',
            name: 'ref.png',
          }],
        }),
        Infinity,
      ),
    ).toBe(DEFAULT_FRAGMENT_DURATION_MS);
  });
});
