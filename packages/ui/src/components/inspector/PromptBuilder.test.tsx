import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Asset, Reference } from '@opendirector/core/types/asset';

import { PromptBuilder } from './PromptBuilder';

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

describe('PromptBuilder', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('uses a plain textarea instead of a mirrored transparent overlay', () => {
    act(() => {
      root.render(
        <PromptBuilder
          prompt="已有提示词"
          onPromptChange={() => {}}
          references={[createReference('ref-1', 'asset-1', 'image')]}
          assets={[createAsset('asset-1', 'image', '参考图')]}
          showWebSearch={false}
        />,
      );
    });

    const textarea = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.className).not.toContain('text-transparent');
    expect(textarea?.className).toContain('min-h-36');
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('grows with content while keeping the default minimum height', () => {
    const onPromptChange = vi.fn();

    act(() => {
      root.render(
        <PromptBuilder
          prompt="短提示词"
          onPromptChange={onPromptChange}
          showWebSearch={false}
        />,
      );
    });

    const textarea = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
    let mockScrollHeight = 220;

    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => mockScrollHeight,
    });

    act(() => {
      root.render(
        <PromptBuilder
          prompt={'第一行\n第二行\n第三行\n第四行'}
          onPromptChange={onPromptChange}
          showWebSearch={false}
        />,
      );
    });

    expect(textarea.style.height).toBe('220px');

    mockScrollHeight = 60;

    act(() => {
      root.render(
        <PromptBuilder
          prompt=""
          onPromptChange={onPromptChange}
          showWebSearch={false}
        />,
      );
    });

    expect(textarea.style.height).toBe('144px');
  });

  it('inserts a reference label at the current caret position from quick insert buttons', () => {
    const onPromptChange = vi.fn();

    act(() => {
      root.render(
        <PromptBuilder
          prompt="abcd"
          onPromptChange={onPromptChange}
          references={[createReference('ref-1', 'asset-1', 'image')]}
          assets={[createAsset('asset-1', 'image', '参考图')]}
          showWebSearch={false}
        />,
      );
    });

    const textarea = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
    const insertButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('[图片1]'),
    ) as HTMLButtonElement | undefined;

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(2, 2);
      textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      insertButton?.click();
    });

    expect(onPromptChange).toHaveBeenCalledWith('ab[图片1]cd');
  });

  it('uses the live textarea selection after an external prompt rewrite', () => {
    const onPromptChange = vi.fn();

    act(() => {
      root.render(
        <PromptBuilder
          prompt="abcd"
          onPromptChange={onPromptChange}
          references={[createReference('ref-1', 'asset-1', 'image')]}
          assets={[createAsset('asset-1', 'image', '参考图')]}
          showWebSearch={false}
        />,
      );
    });

    const textarea = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
    const insertButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('[图片1]'),
    ) as HTMLButtonElement | undefined;

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(2, 2);
      textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      root.render(
        <PromptBuilder
          prompt="abXcd"
          onPromptChange={onPromptChange}
          references={[createReference('ref-1', 'asset-1', 'image')]}
          assets={[createAsset('asset-1', 'image', '参考图')]}
          showWebSearch={false}
        />,
      );
    });

    act(() => {
      textarea.setSelectionRange(3, 3);
    });

    act(() => {
      insertButton?.click();
    });

    expect(onPromptChange).toHaveBeenLastCalledWith('abX[图片1]cd');
  });

  it('renumbers prompt labels when references change', () => {
    const onPromptChange = vi.fn();
    const first = createReference('ref-1', 'asset-1', 'image');
    const second = createReference('ref-2', 'asset-2', 'image');
    const assets = [
      createAsset('asset-1', 'image', '图1'),
      createAsset('asset-2', 'image', '图2'),
    ];

    act(() => {
      root.render(
        <PromptBuilder
          prompt="使用[图片2]作为参考"
          onPromptChange={onPromptChange}
          references={[first, second]}
          assets={assets}
          showWebSearch={false}
        />,
      );
    });

    expect(onPromptChange).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <PromptBuilder
          prompt="使用[图片2]作为参考"
          onPromptChange={onPromptChange}
          references={[second]}
          assets={assets}
          showWebSearch={false}
        />,
      );
    });

    expect(onPromptChange).toHaveBeenCalledWith('使用[图片1]作为参考');
  });
});
