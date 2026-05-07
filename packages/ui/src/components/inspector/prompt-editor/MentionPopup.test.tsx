import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Asset, Reference } from '@opendirector/core/types/asset';

import { MentionPopup, type MentionItem } from './MentionPopup';

function createAsset(id: string, type: Asset['type'], name = id): Asset {
  const mimeType = type === 'image' ? 'image/png' : type === 'video' ? 'video/mp4' : 'audio/mpeg';
  const now = new Date('2026-01-01T00:00:00.000Z');

  return {
    id,
    name,
    type,
    source: 'original',
    url: `file://${id}`,
    fileSize: 1024,
    mimeType,
    tags: [],
    favorite: false,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function createReference(id: string, assetId: string, type: Reference['type']): Reference {
  return {
    id,
    assetId,
    type,
  };
}

describe('MentionPopup', () => {
  let container: HTMLDivElement;
  let root: Root;
  let anchor: HTMLTextAreaElement;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let resizeCallback: (() => void) | null;
  let bottom = 100;
  const right = 320;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    anchor = document.createElement('textarea');
    document.body.appendChild(anchor);
    anchor.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom,
        right,
        width: 240,
        height: bottom,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    resizeCallback = null;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }

      observe() {}

      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    anchor.remove();
    container.remove();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
  });

  it('repositions itself when the anchor height changes', () => {
    const item: MentionItem = {
      reference: createReference('ref-1', 'asset-1', 'image'),
      asset: createAsset('asset-1', 'image', '参考图'),
      label: '[图片1]',
    };

    act(() => {
      root.render(
        <MentionPopup
          anchorRef={{ current: anchor }}
          items={[item]}
          filter=""
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });

    const popupButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('参考图'),
    ) as HTMLButtonElement | undefined;
    const popup = popupButton?.parentElement as HTMLDivElement | null;

    expect(popup?.style.top).toBe('104px');

    bottom = 180;

    act(() => {
      resizeCallback?.();
    });

    expect(popup?.style.top).toBe('184px');
  });
});
