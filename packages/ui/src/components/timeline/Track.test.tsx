import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track } from './Track';

const timelineState = vi.hoisted(() => ({
  current: {
    toolMode: 'select' as 'select' | 'razor',
    splitFragment: vi.fn(),
    addFragment: vi.fn(),
    snapEnabled: false,
    snapThreshold: 25,
    tracks: [
      {
        id: 'track-1',
        type: 'video' as const,
        name: 'Video 1',
        muted: false,
        locked: false,
        order: 0,
      },
    ],
    fragments: [],
    scenes: [],
    setActiveSnapLines: vi.fn(),
    clearActiveSnapLines: vi.fn(),
    getPlayheadRef: vi.fn(() => 0),
  },
}));

const selectionState = vi.hoisted(() => ({
  current: {
    primaryType: 'fragment' as const,
    primaryIds: [],
  },
}));

const assetState = vi.hoisted(() => ({
  current: {
    getAssetById: vi.fn(() => null),
    updateAsset: vi.fn(),
  },
}));

const projectState = vi.hoisted(() => ({
  current: {
    currentProject: { folderPath: '/tmp/project' },
  },
}));

const mockHelpers = vi.hoisted(() => {
  const createMockStoreHook = <T extends object>(stateRef: { current: T }) =>
    Object.assign((selector: (state: T) => unknown) => selector(stateRef.current), {
      getState: () => stateRef.current,
      setState: (updates: Partial<T>) => {
        Object.assign(stateRef.current, updates);
      },
    });

  return { createMockStoreHook };
});

vi.mock('@opendirector/core/stores/timelineStore', () => ({
  useTimelineStore: mockHelpers.createMockStoreHook(timelineState),
}));

vi.mock('@opendirector/core/stores/selectionStore', () => ({
  useSelectionStore: mockHelpers.createMockStoreHook(selectionState),
}));

vi.mock('@opendirector/core/stores/assetStore', () => ({
  useAssetStore: mockHelpers.createMockStoreHook(assetState),
}));

vi.mock('@opendirector/core/stores/projectStore', () => ({
  useProjectStore: mockHelpers.createMockStoreHook(projectState),
}));

vi.mock('@opendirector/core/adapters', () => ({
  getPlatformAdapter: vi.fn(),
}));

vi.mock('@opendirector/core/services/asset-import', () => ({
  refreshImportedAssetMetadata: vi.fn(),
}));

vi.mock('@opendirector/core/utils/snap', () => ({
  findSnapPoint: vi.fn((time: number) => ({ time, snapLines: [] })),
}));

describe('Track', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    timelineState.current.toolMode = 'select';
    timelineState.current.splitFragment.mockReset();
    timelineState.current.addFragment.mockReset();
    timelineState.current.setActiveSnapLines.mockReset();
    timelineState.current.clearActiveSnapLines.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders an empty-source fragment and can switch to razor mode without throwing', async () => {
    const track = {
      id: 'track-1',
      type: 'video' as const,
      name: 'Video 1',
      muted: false,
      locked: false,
      order: 0,
    };
    const fragment = {
      id: 'fragment-empty',
      trackId: 'track-1',
      start: 0,
      duration: 2_000,
      prompt: '',
      references: [],
      status: 'draft' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await act(async () => {
      root.render(
        <Track
          track={track}
          fragments={[fragment]}
          zoom={100}
          width={2000}
          scrollX={0}
          viewportWidth={800}
        />,
      );
      await Promise.resolve();
    });

    timelineState.current.toolMode = 'razor';

    await act(async () => {
      root.render(
        <Track
          track={track}
          fragments={[fragment]}
          zoom={100}
          width={2000}
          scrollX={0}
          viewportWidth={800}
        />,
      );
      await Promise.resolve();
    });

    const trackContent = container.querySelector('[data-track-id="track-1"] > div:last-child') as HTMLDivElement | null;
    expect(trackContent).not.toBeNull();
    expect(trackContent?.style.cursor).toBe('crosshair');
    expect(container.querySelector('[data-testid="fragment-fragment-empty"]')).not.toBeNull();
  });
});
