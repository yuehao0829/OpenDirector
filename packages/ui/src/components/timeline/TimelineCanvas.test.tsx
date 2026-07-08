import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineCanvas } from './TimelineCanvas';

const timelineState = vi.hoisted(() => ({
  current: {
    tracks: [{ id: 'track-1', type: 'video', order: 0, muted: false }],
    fragments: [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 2_000,
        prompt: 'Drag ghost',
        references: [],
      },
      {
        id: 'fragment-2',
        trackId: 'track-1',
        start: 2_500,
        duration: 1_500,
        prompt: 'Second fragment',
        references: [],
      },
    ],
    scenes: [],
    zoom: 100,
    scroll: { x: 0, y: 0 },
    playhead: 0,
    displayPlayhead: 0,
    duration: 2_000,
    isPlaying: false,
    nativePreviewTransportControlled: false,
    toolMode: 'select',
    selectionBox: null,
    draftFragment: null as null | {
      trackId: string;
      start: number;
      duration: number;
    },
    draftPrompt: '',
    clipboard: null,
    pasteIndicator: null,
    snapEnabled: false,
    snapThreshold: 25,
    activeSnapLines: [],
    setScroll: vi.fn(),
    setPlayhead: vi.fn(),
    setDisplayPlayhead: vi.fn(),
    startSelectionBox: vi.fn(),
    updateSelectionBox: vi.fn(),
    confirmSelectionBox: vi.fn(),
    cancelSelectionBox: vi.fn(),
    setDraftFragment: vi.fn(),
    confirmDraftFragment: vi.fn(),
    pause: vi.fn(),
    initializeDefaults: vi.fn(),
    setPasteIndicator: vi.fn(),
    moveFragments: vi.fn(),
    setActiveSnapLines: vi.fn(),
    clearActiveSnapLines: vi.fn(),
    togglePlayback: vi.fn(),
    getPlayheadRef: vi.fn(() => 0),
    getDisplayPlayheadRef: vi.fn(() => 0),
    setPlayheadRefOnly: vi.fn(),
    setDisplayPlayheadRefOnly: vi.fn(),
  },
}));

const selectionState = vi.hoisted(() => ({
  current: {
    primaryType: 'fragment',
    primaryIds: ['fragment-1'],
    primaryFocusId: 'fragment-1',
    clear: vi.fn(),
    selectFragment: vi.fn(),
    selectScene: vi.fn(),
    toggleFragment: vi.fn(),
  },
}));

const trackRenderState = vi.hoisted(() => ({
  count: 0,
}));

const snapUtilsState = vi.hoisted(() => ({
  current: {
    findSnapPointsForDrag: vi.fn(
      (_startTime: number) =>
        ({
          time: 0,
          snapLines: [] as Array<{ time: number; type: string }>,
        }) as { time: number; snapLines: Array<{ time: number; type: string }> },
    ),
    findNearestValidGroupDelta: vi.fn((delta: number) => ({ delta, adjusted: false })),
    pixelDistanceToTime: vi.fn((pixels: number, zoom: number) => (pixels * 1000) / zoom),
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

vi.mock('@opendirector/core/utils/snap', () => ({
  findSnapPointsForDrag: (startTime: number) =>
    snapUtilsState.current.findSnapPointsForDrag(startTime),
  findNearestValidGroupDelta: (delta: number) =>
    snapUtilsState.current.findNearestValidGroupDelta(delta),
  pixelDistanceToTime: (pixels: number, zoom: number) =>
    snapUtilsState.current.pixelDistanceToTime(pixels, zoom),
}));

vi.mock('../../hooks/useTimelineShortcuts', () => ({
  useTimelineShortcuts: vi.fn(),
}));

vi.mock('./Toolbar', () => ({
  Toolbar: () => <div data-testid="timeline-toolbar" />,
}));

vi.mock('./Playhead', () => ({
  PlayheadHandle: () => <div data-testid="playhead-handle" />,
  PlayheadLine: () => <div data-testid="playhead-line" />,
}));

vi.mock('./TimeRuler', () => ({
  TimeRuler: ({
    onClick,
  }: {
    onClick?: (e: MouseEvent | unknown) => void;
  }) => (
    <div data-testid="time-ruler" onClick={onClick} />
  ),
}));

vi.mock('./SceneTrack', () => ({
  SceneTrack: () => <div data-testid="scene-track" />,
}));

vi.mock('./DraftFragment', () => ({
  DraftFragment: () => null,
}));

vi.mock('./PasteIndicator', () => ({
  PasteIndicator: () => null,
}));

vi.mock('./TrackDivider', () => ({
  TrackDivider: () => <div data-testid="track-divider" />,
}));

vi.mock('./FragmentContextMenu', () => ({
  FragmentContextMenu: ({ fragmentId }: { fragmentId: string }) => (
    <div data-testid="fragment-context-menu">{fragmentId}</div>
  ),
}));

vi.mock('./TrackContextMenu', () => ({
  TrackContextMenu: () => null,
}));

vi.mock('./SceneContextMenu', () => ({
  SceneContextMenu: () => null,
}));

vi.mock('./TrackAreaContextMenu', () => ({
  TrackAreaContextMenu: () => null,
}));

vi.mock('./SnapLine', () => ({
  SnapLines: () => null,
}));

vi.mock('./Track', () => ({
  Track: ({
    track,
    fragments,
    onFragmentDragStart,
  }: {
    track: { id: string };
    fragments: Array<{ id: string; prompt: string }>;
    onFragmentDragStart?: (e: unknown, fragment: { id: string; prompt: string }) => void;
  }) => {
    trackRenderState.count += 1;
    return (
      <div data-testid={`track-${track.id}`}>
        {fragments.map((fragment) => (
          <div
            key={fragment.id}
            data-testid={`fragment-${fragment.id}`}
            data-fragment-id={fragment.id}
            onMouseDown={(e) => {
              e.stopPropagation();
              onFragmentDragStart?.(e, fragment);
            }}
          >
            {fragment.id}
          </div>
        ))}
      </div>
    );
  },
}));

describe('TimelineCanvas', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalClientWidth: PropertyDescriptor | undefined;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let resizeObserverCallback: (() => void) | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    timelineState.current.initializeDefaults.mockReset();
    timelineState.current.moveFragments.mockReset();
    timelineState.current.setActiveSnapLines.mockReset();
    timelineState.current.clearActiveSnapLines.mockReset();
    timelineState.current.pause.mockReset();
    timelineState.current.setPlayhead.mockReset();
    timelineState.current.snapEnabled = false;
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 2_000,
        prompt: 'Drag ghost',
        references: [],
      },
      {
        id: 'fragment-2',
        trackId: 'track-1',
        start: 2_500,
        duration: 1_500,
        prompt: 'Second fragment',
        references: [],
      },
    ];
    timelineState.current.getPlayheadRef.mockReturnValue(0);
    selectionState.current.clear.mockReset();
    selectionState.current.selectFragment.mockReset();
    selectionState.current.selectScene.mockReset();
    selectionState.current.primaryType = 'fragment';
    selectionState.current.primaryIds = ['fragment-1'];
    selectionState.current.primaryFocusId = 'fragment-1';
    snapUtilsState.current.findSnapPointsForDrag.mockReset();
    snapUtilsState.current.findNearestValidGroupDelta.mockReset();
    snapUtilsState.current.findSnapPointsForDrag.mockImplementation(() => ({ time: 0, snapLines: [] }));
    snapUtilsState.current.findNearestValidGroupDelta.mockImplementation((delta: number) => ({ delta, adjusted: false }));
    trackRenderState.count = 0;

    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 800;
      },
    });

    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 600,
        right: 800,
        width: 800,
        height: 600,
        toJSON() {
          return this;
        },
      } as DOMRect;
    };

    resizeObserverCallback = null;
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        constructor(callback: () => void) {
          resizeObserverCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    } else {
      // @ts-expect-error restore descriptor absence
      delete HTMLElement.prototype.clientWidth;
    }
    vi.unstubAllGlobals();
  });

  it('does not rerender Track on mousemove while dragging ghosts', async () => {
    await act(async () => {
      root.render(<TimelineCanvas />);
      await Promise.resolve();
    });

    resizeObserverCallback?.();

    expect(trackRenderState.count).toBe(1);

    const fragment = container.querySelector('[data-testid="fragment-fragment-1"]') as HTMLDivElement;
    expect(fragment).not.toBeNull();

    await act(async () => {
      fragment.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          clientX: 80,
          clientY: 100,
          buttons: 1,
        }),
      );
      await Promise.resolve();
    });

    expect(trackRenderState.count).toBe(2);

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 140,
          clientY: 100,
          buttons: 1,
        }),
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 200,
          clientY: 100,
          buttons: 1,
        }),
      );
      await Promise.resolve();
    });

    expect(trackRenderState.count).toBe(2);
    expect(container.textContent).toContain('Drag ghost');
  });

  it('passes the right-clicked fragment id into the fragment context menu', async () => {
    selectionState.current.primaryIds = ['fragment-1', 'fragment-2'];

    await act(async () => {
      root.render(<TimelineCanvas />);
      await Promise.resolve();
    });

    const fragment = container.querySelector('[data-testid="fragment-fragment-2"]') as HTMLDivElement;
    expect(fragment).not.toBeNull();

    await act(async () => {
      fragment.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: 180,
          clientY: 100,
        }),
      );
      await Promise.resolve();
    });

    expect(selectionState.current.selectFragment).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="fragment-context-menu"]')?.textContent).toBe('fragment-2');
  });

  it('does not pause from the scroll container mousedown before handling a time ruler seek', async () => {
    timelineState.current.isPlaying = true;

    await act(async () => {
      root.render(<TimelineCanvas />);
      await Promise.resolve();
    });

    const timeRuler = container.querySelector('[data-testid="time-ruler"]') as HTMLDivElement;
    expect(timeRuler).not.toBeNull();

    await act(async () => {
      timeRuler.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          clientX: 300,
          clientY: 12,
          buttons: 1,
        }),
      );
      await Promise.resolve();
    });

    expect(timelineState.current.pause).not.toHaveBeenCalled();
    expect(timelineState.current.setPlayhead).not.toHaveBeenCalled();

    // handleRulerMouseUp is attached to window, so dispatch mouseup there
    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: 300,
          clientY: 12,
        }),
      );
      await Promise.resolve();
    });

    expect(timelineState.current.pause).toHaveBeenCalledTimes(1);
    expect(timelineState.current.setPlayhead).toHaveBeenCalledTimes(1);
  });

  it('still finalizes the draft fragment when time ruler mousedown bubbles through the canvas', async () => {
    timelineState.current.draftFragment = {
      trackId: 'track-1',
      start: 0,
      duration: 1_000,
    };
    timelineState.current.draftPrompt = 'Draft prompt';

    await act(async () => {
      root.render(<TimelineCanvas />);
      await Promise.resolve();
    });

    const timeRuler = container.querySelector('[data-testid="time-ruler"]') as HTMLDivElement;
    expect(timeRuler).not.toBeNull();

    await act(async () => {
      timeRuler.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          clientX: 300,
          clientY: 12,
          buttons: 1,
        }),
      );
      await Promise.resolve();
    });

    expect(timelineState.current.confirmDraftFragment).toHaveBeenCalledWith('Draft prompt');
    expect(timelineState.current.pause).not.toHaveBeenCalled();
    expect(timelineState.current.setPlayhead).not.toHaveBeenCalled();
  });

  it('prefers a valid group snap candidate over a closer invalid one', async () => {
    timelineState.current.snapEnabled = true;
    selectionState.current.primaryIds = ['fragment-1', 'fragment-2'];

    snapUtilsState.current.findSnapPointsForDrag.mockImplementation((startTime: number) => {
      if (startTime < 1_000) {
        return {
          time: 105,
          snapLines: [{ time: 105, type: 'fragment-edge' }],
        };
      }
      return {
        time: 2_620,
        snapLines: [{ time: 2_620, type: 'fragment-edge' }],
      };
    });
    snapUtilsState.current.findNearestValidGroupDelta.mockImplementation((delta: number) => {
      if (delta === 105) {
        return { delta: 130, adjusted: true };
      }
      return { delta, adjusted: false };
    });

    await act(async () => {
      root.render(<TimelineCanvas />);
      await Promise.resolve();
    });

    const fragment = container.querySelector('[data-testid="fragment-fragment-1"]') as HTMLDivElement;
    expect(fragment).not.toBeNull();

    await act(async () => {
      fragment.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          clientX: 80,
          clientY: 100,
          buttons: 1,
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 91,
          clientY: 100,
          buttons: 1,
        }),
      );
      await Promise.resolve();
    });

    expect(timelineState.current.setActiveSnapLines).toHaveBeenCalledWith([
      { time: 2_620, type: 'fragment-edge' },
    ]);

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: 91,
          clientY: 100,
          buttons: 0,
        }),
      );
      await Promise.resolve();
    });

    expect(timelineState.current.moveFragments).toHaveBeenCalledWith([
      { id: 'fragment-1', newStart: 120, newTrackId: 'track-1' },
      { id: 'fragment-2', newStart: 2_620, newTrackId: 'track-1' },
    ]);
  });
});
