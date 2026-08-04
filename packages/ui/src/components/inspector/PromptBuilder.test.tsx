import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Asset, Reference } from '@opendirector/core/types/asset';
import type { InputRequirements } from '@opendirector/core/types/provider-system';

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

/** SeedAudio-style input requirements — `@音频N` citation (no brackets).
 *  Uses a literal template (test stays self-contained) and omits typeNames so
 *  type names localize from common.* — mirroring the real SeedAudio declaration. */
const SEEDAUDIO_REQ: InputRequirements = {
  promptRequired: true,
  references: {
    image: { required: false, min: 0, max: 1 },
    video: { required: false, min: 0, max: 0 },
    audio: { required: false, min: 0, max: 3 },
    maxTotal: 3,
  },
  referenceMarker: {
    template: '@{{type}}{{index}}',
  },
};

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

  it('inserts the SeedAudio @音频N marker (not the bracketed form) when the model declares it', () => {
    const onPromptChange = vi.fn();

    act(() => {
      root.render(
        <PromptBuilder
          prompt="abcd"
          onPromptChange={onPromptChange}
          references={[createReference('ref-1', 'asset-1', 'audio')]}
          assets={[createAsset('asset-1', 'audio', '音色A')]}
          inputRequirements={SEEDAUDIO_REQ}
          showWebSearch={false}
        />,
      );
    });

    // The quick-insert chip must show the declared `@音频1`, not the hardcoded `[音频1]`.
    const insertButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('@音频1'),
    ) as HTMLButtonElement | undefined;
    expect(insertButton).toBeDefined();
    expect(insertButton?.textContent).toContain('@音频1');
    expect(insertButton?.textContent).not.toContain('[音频1]');

    const textarea = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(2, 2);
      textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    act(() => {
      insertButton?.click();
    });

    expect(onPromptChange).toHaveBeenCalledWith('ab@音频1cd');
  });

  it('renumbers @音频N labels when SeedAudio references change', () => {
    const onPromptChange = vi.fn();
    const first = createReference('ref-1', 'asset-1', 'audio');
    const second = createReference('ref-2', 'asset-2', 'audio');
    const assets = [
      createAsset('asset-1', 'audio', '音1'),
      createAsset('asset-2', 'audio', '音2'),
    ];

    act(() => {
      root.render(
        <PromptBuilder
          prompt="使用@音频2作为参考"
          onPromptChange={onPromptChange}
          references={[first, second]}
          assets={assets}
          inputRequirements={SEEDAUDIO_REQ}
          showWebSearch={false}
        />,
      );
    });

    expect(onPromptChange).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <PromptBuilder
          prompt="使用@音频2作为参考"
          onPromptChange={onPromptChange}
          references={[second]}
          assets={assets}
          inputRequirements={SEEDAUDIO_REQ}
          showWebSearch={false}
        />,
      );
    });

    expect(onPromptChange).toHaveBeenCalledWith('使用@音频1作为参考');
  });

  it('renumbers correctly when two same-type refs swap indices (no clobbering)', () => {
    const onPromptChange = vi.fn();
    const a = createReference('ref-1', 'asset-1', 'image');
    const b = createReference('ref-2', 'asset-2', 'image');
    const assets = [createAsset('asset-1', 'image', '图1'), createAsset('asset-2', 'image', '图2')];

    act(() => {
      root.render(
        <PromptBuilder
          prompt="[图片1] [图片2]"
          onPromptChange={onPromptChange}
          references={[a, b]}
          assets={assets}
          showWebSearch={false}
        />,
      );
    });

    // Reorder references to [b, a] → b becomes [图片1], a becomes [图片2].
    act(() => {
      root.render(
        <PromptBuilder
          prompt="[图片1] [图片2]"
          onPromptChange={onPromptChange}
          references={[b, a]}
          assets={assets}
          showWebSearch={false}
        />,
      );
    });

    // a's token [图片1]→[图片2], b's token [图片2]→[图片1] → no clobbering.
    expect(onPromptChange).toHaveBeenCalledWith('[图片2] [图片1]');
  });

  it('does not corrupt a longer-index token when deleting a prefix marker (D1 boundary)', () => {
    const onPromptChange = vi.fn();
    const a = createReference('ref-1', 'asset-1', 'audio');
    const assets = [createAsset('asset-1', 'audio', '音1')];

    // SeedAudio marker (@音频N, delimiter-less). Prompt has "@音频10" (text the
    // user typed — not a real ref). Ref a's label is @音频1.
    act(() => {
      root.render(
        <PromptBuilder
          prompt="@音频10"
          onPromptChange={onPromptChange}
          references={[a]}
          assets={assets}
          inputRequirements={SEEDAUDIO_REQ}
          showWebSearch={false}
        />,
      );
    });

    // Remove ref a → its label @音频1 must NOT match inside @音频10.
    act(() => {
      root.render(
        <PromptBuilder
          prompt="@音频10"
          onPromptChange={onPromptChange}
          references={[]}
          assets={assets}
          inputRequirements={SEEDAUDIO_REQ}
          showWebSearch={false}
        />,
      );
    });

    expect(onPromptChange).not.toHaveBeenCalled();
  });

  it('migrates stale markers on remount via the lifted labelStateRef (cand9)', () => {
    const onPromptChange = vi.fn();
    // Simulate state persisted from a prior mount under a different marker:
    // ref 'ref-1' was labeled '@音频1' (SeedAudio). Remount under the default
    // (bracketed) marker, which labels audio ref 'ref-1' as [音频1].
    const sharedRef = { current: new Map<string, string>([['ref-1', '@音频1']]) };
    const a = createReference('ref-1', 'asset-1', 'audio');

    act(() => {
      root.render(
        <PromptBuilder
          prompt="@音频1"
          onPromptChange={onPromptChange}
          references={[a]}
          assets={[createAsset('asset-1', 'audio', '音1')]}
          labelStateRef={sharedRef}
          showWebSearch={false}
        />,
      );
    });

    expect(onPromptChange).toHaveBeenCalledWith('[音频1]');
  });
});
