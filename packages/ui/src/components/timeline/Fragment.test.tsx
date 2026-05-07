import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fragment as TimelineFragment } from '@opendirector/core/types/timeline';
import { Fragment } from './Fragment';

const selectionState = vi.hoisted(() => ({
  current: {
    primaryType: 'fragment',
    primaryIds: ['fragment-1', 'fragment-2'],
    primaryFocusId: 'fragment-1',
    focusFragment: vi.fn(),
    selectFragment: vi.fn(),
    toggleFragment: vi.fn(),
  },
}));

const timelineState = vi.hoisted(() => ({
  current: {
    updateFragment: vi.fn(),
    applyFragmentTiming: vi.fn(),
    toolMode: 'select',
    tracks: [{ id: 'track-1', type: 'video', order: 0 }],
    zoom: 100,
    playhead: 0,
    fragments: [] as TimelineFragment[],
    scenes: [],
    snapEnabled: false,
    snapThreshold: 25,
    clearActiveSnapLines: vi.fn(),
    setActiveSnapLines: vi.fn(),
    moveFragment: vi.fn(),
    resizeFragment: vi.fn(),
  },
}));

const assetStoreState = vi.hoisted(() => ({
  current: {
    getAssetById: vi.fn(() => null),
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

vi.mock('@opendirector/core/stores/assetStore', () => ({
  useAssetStore: mockHelpers.createMockStoreHook(assetStoreState),
}));

describe('Fragment', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    selectionState.current.selectFragment.mockReset();
    selectionState.current.focusFragment.mockReset();
    selectionState.current.toggleFragment.mockReset();
    timelineState.current.applyFragmentTiming.mockReset();
    timelineState.current.updateFragment.mockReset();
    timelineState.current.moveFragment.mockReset();
    timelineState.current.resizeFragment.mockReset();
    timelineState.current.clearActiveSnapLines.mockReset();
    timelineState.current.setActiveSnapLines.mockReset();
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        prompt: 'Current fragment',
        references: [],
        status: 'draft',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 120,
        width: 120,
        height: 40,
        toJSON() {
          return this;
        },
      } as DOMRect;
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it('focuses the clicked fragment when it is already part of a multi-selection', async () => {
    await act(async () => {
      root.render(
        <Fragment
          fragment={{
            id: 'fragment-2',
            trackId: 'track-1',
            start: 0,
            duration: 1_000,
            prompt: 'Current fragment',
            references: [],
            status: 'draft',
            createdAt: new Date(),
            updatedAt: new Date(),
          }}
          zoom={100}
          isSelected
        />,
      );
      await Promise.resolve();
    });

    const fragment = container.querySelector('[data-testid="fragment-fragment-2"]');
    expect(fragment).not.toBeNull();

    await act(async () => {
      fragment?.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: 40,
          clientY: 20,
        }),
      );
      await Promise.resolve();
    });

    expect(selectionState.current.focusFragment).toHaveBeenCalledWith('fragment-2');
    expect(selectionState.current.selectFragment).not.toHaveBeenCalled();
    expect(selectionState.current.toggleFragment).not.toHaveBeenCalled();
  });

  it('keeps resize changes local until mouseup, then commits once', async () => {
    await act(async () => {
      root.render(
        <Fragment
          fragment={timelineState.current.fragments[0]}
          zoom={100}
          isSelected
        />,
      );
      await Promise.resolve();
    });

    const fragment = container.querySelector('[data-testid="fragment-fragment-1"]') as HTMLDivElement | null;
    const handles = container.querySelectorAll('.fragment-resize-handle');
    const rightHandle = handles[1] as HTMLDivElement | undefined;
    expect(fragment).not.toBeNull();
    expect(rightHandle).toBeDefined();

    await act(async () => {
      rightHandle?.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: 120,
          clientY: 20,
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 220,
          clientY: 20,
        }),
      );
      await Promise.resolve();
    });

    expect(timelineState.current.applyFragmentTiming).not.toHaveBeenCalled();
    expect(timelineState.current.moveFragment).not.toHaveBeenCalled();
    expect(timelineState.current.resizeFragment).not.toHaveBeenCalled();
    expect(fragment?.style.width).toBe('200px');

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: 220,
          clientY: 20,
        }),
      );
      await Promise.resolve();
    });

    expect(timelineState.current.applyFragmentTiming).toHaveBeenCalledTimes(1);
    expect(timelineState.current.applyFragmentTiming).toHaveBeenCalledWith('fragment-1', {
      start: 0,
      duration: 2_000,
      trimStart: undefined,
    });
  });
});
