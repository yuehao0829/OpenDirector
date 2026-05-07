import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FragmentContextMenu } from './FragmentContextMenu';

const selectionState = vi.hoisted(() => ({
  current: {
    primaryType: 'fragment' as const,
    primaryIds: ['fragment-1', 'fragment-2'],
  },
}));

const timelineState = vi.hoisted(() => ({
  current: {
    fragments: [
      { id: 'fragment-1', trackId: 'track-1', start: 0, duration: 1_000 },
      { id: 'fragment-2', trackId: 'track-1', start: 1_500, duration: 1_000 },
    ],
    mergeFragments: vi.fn(),
    cutSelection: vi.fn(),
    copySelection: vi.fn(),
    deleteFragment: vi.fn(),
    splitFragment: vi.fn(),
  },
}));

const mockHelpers = vi.hoisted(() => {
  const createMockStoreHook = <T extends object>(stateRef: { current: T }) =>
    Object.assign((selector: (state: T) => unknown) => selector(stateRef.current), {
      getState: () => stateRef.current,
    });

  return { createMockStoreHook };
});

vi.mock('@opendirector/core/stores/selectionStore', () => ({
  useSelectionStore: mockHelpers.createMockStoreHook(selectionState),
}));

vi.mock('@opendirector/core/stores/timelineStore', () => ({
  useTimelineStore: mockHelpers.createMockStoreHook(timelineState),
}));

vi.mock('../../hooks/useContextMenuClose', () => ({
  useContextMenuClose: vi.fn(),
}));

describe('FragmentContextMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    timelineState.current.splitFragment.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('splits the right-clicked fragment instead of the first selected fragment', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <FragmentContextMenu
          x={100}
          y={120}
          fragmentId="fragment-2"
          rightClickTime={2_250}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });

    const splitButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('分割'),
    );
    expect(splitButton).toBeDefined();

    await act(async () => {
      splitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(timelineState.current.splitFragment).toHaveBeenCalledWith('fragment-2', 2_250);
    expect(onClose).toHaveBeenCalled();
  });
});
