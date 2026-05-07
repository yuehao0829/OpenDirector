import { act, useLayoutEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isNativePreviewOccluded } from '@opendirector/core/utils/native-preview-occlusion';

import { Modal } from './Modal';

function LayoutProbe({ onLayout }: { onLayout: (occluded: boolean) => void }) {
  useLayoutEffect(() => {
    onLayout(isNativePreviewOccluded());
  }, [onLayout]);

  return null;
}

function EscapeProbe({ token }: { token: number }) {
  useLayoutEffect(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }, [token]);

  return null;
}

describe('Modal', () => {
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

  it('publishes native preview occlusion before later layout effects in the same commit', () => {
    const onLayout = vi.fn();

    act(() => {
      root.render(
        <>
          <Modal isOpen onClose={() => {}} title="设置">
            <div>content</div>
          </Modal>
          <LayoutProbe onLayout={onLayout} />
        </>,
      );
    });

    expect(onLayout).toHaveBeenCalledWith(true);
    expect(isNativePreviewOccluded()).toBe(true);
  });

  it('releases native preview occlusion after the modal closes', () => {
    act(() => {
      root.render(
        <Modal isOpen onClose={() => {}} title="设置">
          <div>content</div>
        </Modal>,
      );
    });

    expect(isNativePreviewOccluded()).toBe(true);

    act(() => {
      root.render(
        <Modal isOpen={false} onClose={() => {}} title="设置">
          <div>content</div>
        </Modal>,
      );
    });

    expect(isNativePreviewOccluded()).toBe(false);
  });

  it('uses the latest onClose handler for Escape during the same layout commit', () => {
    const firstOnClose = vi.fn();
    const secondOnClose = vi.fn();

    act(() => {
      root.render(
        <>
          <Modal isOpen onClose={firstOnClose} title="设置">
            <div>content</div>
          </Modal>
          <EscapeProbe token={0} />
        </>,
      );
    });

    firstOnClose.mockClear();
    secondOnClose.mockClear();

    act(() => {
      root.render(
        <>
          <Modal isOpen onClose={secondOnClose} title="设置">
            <div>content</div>
          </Modal>
          <EscapeProbe token={1} />
        </>,
      );
    });

    expect(firstOnClose).not.toHaveBeenCalled();
    expect(secondOnClose).toHaveBeenCalledTimes(1);
  });
});
