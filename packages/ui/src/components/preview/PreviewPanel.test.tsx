import { act, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformAdapter } from '@opendirector/core/adapters';
import { applyReference } from '@opendirector/core/services/reference-processor';
import { storeEvents } from '@opendirector/core/stores/store-events';
import type { PreviewSessionState } from '@opendirector/core/types/media-preview';
import { PreviewPanel } from './PreviewPanel';

const timelineState = vi.hoisted(() => ({
  current: {
    playhead: 120,
    displayPlayhead: 120,
    isPlaying: false,
    tracks: [{ id: 'track-1', type: 'video', order: 1, muted: false }] as any[],
    fragments: [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [] as any[],
      },
    ] as any[],
    setPlayhead: vi.fn(),
    setDisplayPlayhead: vi.fn(),
    updateFragment: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    setPlayheadRefOnly: vi.fn(),
    setDisplayPlayheadRefOnly: vi.fn(),
    getPlayheadRef: vi.fn(() => 120),
    getDisplayPlayheadRef: vi.fn(() => 120),
  },
}));

const previewStoreState = vi.hoisted(() => ({
  current: {
    isPlaying: false,
    currentTime: 0,
    duration: 1_000,
    pause: vi.fn(),
    seek: vi.fn(),
    setTime: vi.fn(),
    setDuration: vi.fn(),
  },
}));

const assetStoreState = vi.hoisted(() => ({
  current: {
    assets: [] as any[],
    getAssetById: vi.fn(() => null),
    addAsset: vi.fn(),
  },
}));

const projectStoreState = vi.hoisted(() => ({
  current: {
    currentProject: null as { id: string; folderPath: string } | null,
  },
}));

const previewSourceState = vi.hoisted(() => ({
  current: null as any,
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

const nativePreviewState = vi.hoisted(() => ({
  current: 'idle' as PreviewSessionState,
}));

const nativePreviewErrorState = vi.hoisted(() => ({
  current: null as string | null,
}));

const tauriState = vi.hoisted(() => ({
  current: false,
}));

const referenceCropState = vi.hoisted(() => ({
  current: {
    cropRect: null as any,
    defaultCropRect: null as any,
    isDefaultCrop: true,
  },
}));

const imageCanvasState = vi.hoisted(() => ({
  current: {
    props: null as any,
    imageInfo: { naturalWidth: 1_000, naturalHeight: 500 },
    containerSize: { width: 800, height: 400 },
  },
}));

const playbackControlsState = vi.hoisted(() => ({
  current: {
    props: null as any,
  },
}));

vi.mock(
  '@opendirector/core/adapters',
  () => ({
    getPlatformAdapter: vi.fn(),
  }),
);

vi.mock(
  '@opendirector/core/services/reference-processor',
  () => ({
    applyReference: vi.fn(),
  }),
);

vi.mock(
  '@opendirector/core/stores/assetStore',
  () => ({
    useAssetStore: mockHelpers.createMockStoreHook(assetStoreState),
  }),
);

vi.mock(
  '@opendirector/core/stores/previewStore',
  () => ({
    usePreviewStore: mockHelpers.createMockStoreHook(previewStoreState),
  }),
);

vi.mock(
  '@opendirector/core/stores/projectStore',
  () => ({
    useProjectStore: mockHelpers.createMockStoreHook(projectStoreState),
  }),
);

vi.mock(
  '@opendirector/core/stores/timelineStore',
  () => ({
    useTimelineStore: mockHelpers.createMockStoreHook(timelineState),
  }),
);

vi.mock(
  '@opendirector/core/utils/platform',
  () => ({
    isTauri: vi.fn(() => tauriState.current),
  }),
);

vi.mock('../../hooks/usePreviewSource', () => ({
  usePreviewSource: vi.fn(() => previewSourceState.current),
}));

vi.mock('../../utils/crop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/crop')>();
  return {
    ...actual,
    computeCropFrameRect: vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 })),
    computeCropDrawParams: vi.fn(() => ({
      drawX: 0,
      drawY: 0,
      drawW: 100,
      drawH: 100,
      frame: { x: 0, y: 0, width: 100, height: 100 },
    })),
    computeContainLayout: vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 })),
    computeInitialCropRect: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })),
    parseAspectRatio: vi.fn(() => null),
  };
});

vi.mock('../../hooks/useImageCanvas', () => ({
  useImageCanvas: vi.fn((props: any) => {
    imageCanvasState.current.props = props;
    return {
      canvasRef: { current: null },
      containerRef: { current: null },
      imageInfo: imageCanvasState.current.imageInfo,
      containerSize: imageCanvasState.current.containerSize,
    };
  }),
}));

vi.mock('../../hooks/useContainerSize', () => ({
  useContainerSize: vi.fn(() => ({
    containerRef: { current: null },
    containerSize: { width: 0, height: 0 },
  })),
}));

vi.mock('../../hooks/useReferenceCrop', () => ({
  useReferenceCrop: vi.fn(() => referenceCropState.current),
}));

vi.mock('./PlaybackControls', () => ({
  PlaybackControls: (props: any) => {
    playbackControlsState.current.props = props;
    return (
      <div data-testid="playback-controls">
        <button data-testid="playback-apply" onClick={props.onApply} disabled={props.applyDisabled}>
          apply
        </button>
        <button
          data-testid="playback-trim-change"
          onClick={() => props.onTrimChange?.({ startMs: 100, endMs: 700 })}
        >
          trim
        </button>
      </div>
    );
  },
}));

vi.mock('./WaveformPreview', () => ({
  WaveformPreview: () => <div data-testid="waveform-preview" />,
}));

vi.mock('./CropOverlay', () => ({
  CropOverlay: ({ onCropChange }: { onCropChange?: (rect: any) => void }) => (
    <div data-testid="crop-overlay">
      <button
        data-testid="crop-overlay-change"
        onClick={() => onCropChange?.({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 })}
      >
        crop
      </button>
    </div>
  ),
}));

vi.mock('./NativeTimelinePreviewHost', () => ({
  NativeTimelinePreviewHost: ({
    onErrorChange,
    onStateChange,
  }: {
    onErrorChange?: (error: string | null) => void;
    onStateChange?: (state: PreviewSessionState) => void;
  }) => {
    useEffect(() => {
      onErrorChange?.(nativePreviewErrorState.current);
      onStateChange?.(nativePreviewState.current);
    }, [onErrorChange, onStateChange]);

    return <div data-testid="native-timeline-preview-host" />;
  },
}));

vi.mock('./VideoPreview', () => ({
  VideoPreview: ({ dataTestId = 'video-preview', src }: { dataTestId?: string; src: string }) => (
    <div data-testid={dataTestId} data-src={src} />
  ),
}));

describe('PreviewPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderPanel = () => {
    act(() => {
      root.render(<PreviewPanel />);
    });
  };

  const queryNativeHost = () =>
    container.querySelector('[data-testid="native-timeline-preview-host"]');
  const queryNativePreviewErrorOverlay = () =>
    container.querySelector('[data-testid="native-preview-error-overlay"]');
  const queryVideoPreview = () => container.querySelector('[data-testid="video-preview"]');
  const queryWaveformPreview = () => container.querySelector('[data-testid="waveform-preview"]');
  const queryPlaybackApply = () =>
    container.querySelector('[data-testid="playback-apply"]') as HTMLButtonElement | null;
  const queryPlaybackTrimChange = () =>
    container.querySelector('[data-testid="playback-trim-change"]') as HTMLButtonElement | null;
  const queryCropOverlayChange = () =>
    container.querySelector('[data-testid="crop-overlay-change"]') as HTMLButtonElement | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    timelineState.current.playhead = 120;
    timelineState.current.isPlaying = false;
    timelineState.current.tracks = [{ id: 'track-1', type: 'video', order: 1, muted: false }];
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [],
      },
    ];
    timelineState.current.setPlayhead.mockReset();
    timelineState.current.updateFragment.mockReset();
    timelineState.current.play.mockReset();
    timelineState.current.pause.mockReset();
    timelineState.current.setPlayheadRefOnly.mockReset();
    timelineState.current.getPlayheadRef.mockReturnValue(120);

    previewStoreState.current.isPlaying = false;
    previewStoreState.current.currentTime = 0;
    previewStoreState.current.duration = 1_000;
    previewStoreState.current.pause.mockReset();
    previewStoreState.current.seek.mockReset();
    previewStoreState.current.setTime.mockReset();
    previewStoreState.current.setDuration.mockReset();

    assetStoreState.current.assets = [];
    assetStoreState.current.getAssetById.mockReset();
    assetStoreState.current.getAssetById.mockReturnValue(null);
    assetStoreState.current.addAsset.mockReset();

    previewSourceState.current = {
      mode: 'timeline',
      asset: null,
      fragment: {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [],
      },
      reference: null,
      referenceFragmentId: null,
      targetAspectRatio: null,
      previewUrl: 'timeline-preview.mp4',
      previewType: 'video',
      duration: 1_000,
      waveformDataPath: undefined,
    };

    nativePreviewState.current = 'idle';
    nativePreviewErrorState.current = null;
    tauriState.current = false;
    referenceCropState.current = {
      cropRect: null,
      defaultCropRect: null,
      isDefaultCrop: true,
    };
    imageCanvasState.current.props = null;
    imageCanvasState.current.imageInfo = { naturalWidth: 1_000, naturalHeight: 500 };
    imageCanvasState.current.containerSize = { width: 800, height: 400 };
    playbackControlsState.current.props = null;
    vi.mocked(getPlatformAdapter).mockReset();
    vi.mocked(applyReference).mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not render native host or HTML preview components in timeline mode without the desktop shell', () => {
    renderPanel();

    expect(queryVideoPreview()).toBeNull();
    expect(queryWaveformPreview()).toBeNull();
    expect(queryNativeHost()).toBeNull();
  });

  it('mounts native host in desktop timeline mode before native playback starts', () => {
    tauriState.current = true;
    nativePreviewState.current = 'idle';

    renderPanel();

    expect(queryVideoPreview()).toBeNull();
    expect(queryWaveformPreview()).toBeNull();
    expect(queryNativeHost()).not.toBeNull();
  });

  it('keeps native host mounted while native playback is active', () => {
    tauriState.current = true;
    nativePreviewState.current = 'playing';

    renderPanel();

    expect(queryNativeHost()).not.toBeNull();
    expect(queryVideoPreview()).toBeNull();
    expect(queryWaveformPreview()).toBeNull();
    expect(container.textContent).not.toContain('No preview available');
  });

  it('does not render HTML preview components in timeline audio mode without the desktop shell', () => {
    previewSourceState.current = {
      mode: 'timeline',
      asset: null,
      fragment: null,
      reference: null,
      referenceFragmentId: null,
      targetAspectRatio: null,
      previewUrl: 'timeline-audio.wav',
      previewType: 'audio',
      duration: 1_000,
      waveformDataPath: undefined,
    };

    renderPanel();

    expect(queryVideoPreview()).toBeNull();
    expect(queryWaveformPreview()).toBeNull();
    expect(queryNativeHost()).toBeNull();
  });

  it('renders asset video preview normally', () => {
    previewSourceState.current = {
      mode: 'asset',
      asset: {
        id: 'asset-1',
        name: 'Asset 1',
        type: 'video',
        url: 'asset-preview.mp4',
      },
      fragment: null,
      reference: null,
      referenceFragmentId: null,
      targetAspectRatio: null,
      previewUrl: 'asset-preview.mp4',
      previewType: 'video',
      duration: 1_000,
      waveformDataPath: undefined,
    };

    renderPanel();

    const preview = queryVideoPreview();
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('data-src')).toBe('asset-preview.mp4');
  });

  it('shows a non-fatal timeline preview error overlay in desktop mode', () => {
    tauriState.current = true;
    nativePreviewState.current = 'error';
    nativePreviewErrorState.current =
      'Timeline preview requires media-backed fragments. Missing asset or path for 1 fragment(s): fragment-1';

    renderPanel();

    expect(container.textContent).toContain('该工程的时间线预览无法打开');
    expect(container.textContent).toContain('Missing asset or path for 1 fragment');
    expect(queryNativeHost()).not.toBeNull();
    expect(queryNativePreviewErrorOverlay()).not.toBeNull();
  });

  it('keeps apply disabled for an unchanged reference without trim overrides', () => {
    const currentReference = {
      id: 'ref-1',
      assetId: 'asset-1',
      type: 'video',
    };
    previewSourceState.current = {
      mode: 'reference',
      asset: {
        id: 'asset-1',
        name: 'Asset 1',
        type: 'video',
        url: 'asset-preview.mp4',
        width: 1920,
        height: 1080,
        duration: 1_000,
      },
      fragment: null,
      reference: currentReference,
      referenceFragmentId: 'fragment-1',
      targetAspectRatio: '16:9',
      previewUrl: 'asset-preview.mp4',
      previewType: 'video',
      duration: 1_000,
      waveformDataPath: undefined,
    };
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [currentReference],
      },
    ];

    renderPanel();

    expect(queryPlaybackApply()?.disabled).toBe(true);
  });

  it('syncs local crop and trim drafts when the same reference is restored', async () => {
    referenceCropState.current = {
      cropRect: { x: 0, y: 0, width: 1, height: 1 },
      defaultCropRect: { x: 0, y: 0, width: 1, height: 1 },
      isDefaultCrop: true,
    };

    const currentReference = {
      id: 'ref-1',
      assetId: 'asset-1',
      type: 'video',
    };
    previewSourceState.current = {
      mode: 'reference',
      asset: {
        id: 'asset-1',
        name: 'Asset 1',
        type: 'video',
        url: 'asset-preview.mp4',
        width: 1920,
        height: 1080,
        duration: 1_000,
      },
      fragment: null,
      reference: currentReference,
      referenceFragmentId: 'fragment-1',
      targetAspectRatio: '16:9',
      previewUrl: 'asset-preview.mp4',
      previewType: 'video',
      duration: 1_000,
      waveformDataPath: undefined,
    };
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [currentReference],
      },
    ];
    projectStoreState.current.currentProject = {
      id: 'project-1',
      folderPath: '/tmp/project',
    };

    vi.mocked(getPlatformAdapter).mockResolvedValue({
      fs: {},
      db: { saveAsset: vi.fn() },
    } as any);
    vi.mocked(applyReference).mockResolvedValue({
      newAsset: {
        id: 'asset-2',
        name: 'Asset 2',
        type: 'video',
        source: 'original',
        url: 'asset-2.mp4',
        relativePath: 'Assets/Video/asset-2.mp4',
        fileSize: 10,
        mimeType: 'video/mp4',
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: new Date('2026-05-02T00:00:00.000Z'),
        updatedAt: new Date('2026-05-02T00:00:00.000Z'),
      },
    });

    renderPanel();

    const cropToggle = container.querySelector('button[title="显示裁剪"]') as HTMLButtonElement | null;
    expect(cropToggle).not.toBeNull();

    await act(async () => {
      cropToggle?.click();
    });

    await act(async () => {
      queryCropOverlayChange()?.click();
      queryPlaybackTrimChange()?.click();
    });

    const restoredCropRect = { x: 0.25, y: 0.1, width: 0.5, height: 0.6 };
    const restoredTrimRange = { startMs: 50, endMs: 650 };
    previewSourceState.current = {
      ...previewSourceState.current,
      reference: {
        ...currentReference,
        cropRect: restoredCropRect,
        trimRange: restoredTrimRange,
      },
    };
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [
          {
            ...currentReference,
            cropRect: restoredCropRect,
            trimRange: restoredTrimRange,
          },
        ],
      },
    ];

    renderPanel();

    expect(playbackControlsState.current.props?.trimRange).toEqual(restoredTrimRange);

    await act(async () => {
      queryPlaybackApply()?.click();
    });

    const applyCall = vi.mocked(applyReference).mock.calls[0]?.[0];
    expect(applyCall?.reference.cropRect).toEqual(restoredCropRect);
    expect(applyCall?.reference.trimRange).toEqual(restoredTrimRange);
  });

  it('clears pending local crop and trim drafts when a snapshot is restored before flush', async () => {
    referenceCropState.current = {
      cropRect: { x: 0, y: 0, width: 1, height: 1 },
      defaultCropRect: { x: 0, y: 0, width: 1, height: 1 },
      isDefaultCrop: true,
    };

    const currentReference = {
      id: 'ref-1',
      assetId: 'asset-1',
      type: 'video',
    };
    previewSourceState.current = {
      mode: 'reference',
      asset: {
        id: 'asset-1',
        name: 'Asset 1',
        type: 'video',
        url: 'asset-preview.mp4',
        width: 1920,
        height: 1080,
        duration: 1_000,
      },
      fragment: null,
      reference: currentReference,
      referenceFragmentId: 'fragment-1',
      targetAspectRatio: '16:9',
      previewUrl: 'asset-preview.mp4',
      previewType: 'video',
      duration: 1_000,
      waveformDataPath: undefined,
    };
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [currentReference],
      },
    ];

    renderPanel();

    const cropToggle = container.querySelector('button[title="显示裁剪"]') as HTMLButtonElement | null;
    expect(cropToggle).not.toBeNull();

    await act(async () => {
      cropToggle?.click();
    });

    await act(async () => {
      queryCropOverlayChange()?.click();
      queryPlaybackTrimChange()?.click();
    });

    expect(queryPlaybackApply()?.disabled).toBe(false);
    expect(playbackControlsState.current.props?.trimRange).toEqual({ startMs: 100, endMs: 700 });

    await act(async () => {
      storeEvents.emit({
        type: 'SNAPSHOT_RESTORED',
        snapshot: {
          tracks: [],
          fragments: [],
          scenes: [],
          duration: 1_000,
          assets: [],
          pendingDeletions: [],
        },
      });
    });

    expect(queryPlaybackApply()?.disabled).toBe(true);
    expect(playbackControlsState.current.props?.trimRange).toEqual({ startMs: 0, endMs: 1_000 });
  });

  it('ignores stored crop when the crop overlay is hidden', async () => {
    const currentReference = {
      id: 'ref-1',
      assetId: 'asset-1',
      type: 'video',
      cropRect: { x: 0.2, y: 0.1, width: 0.6, height: 0.7 },
    };
    previewSourceState.current = {
      mode: 'reference',
      asset: {
        id: 'asset-1',
        name: 'Asset 1',
        type: 'video',
        url: 'asset-preview.mp4',
        width: 1920,
        height: 1080,
        duration: 1_000,
      },
      fragment: null,
      reference: currentReference,
      referenceFragmentId: 'fragment-1',
      targetAspectRatio: '16:9',
      previewUrl: 'asset-preview.mp4',
      previewType: 'video',
      duration: 1_000,
      waveformDataPath: undefined,
    };
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [currentReference],
      },
    ];
    projectStoreState.current.currentProject = {
      id: 'project-1',
      folderPath: '/tmp/project',
    };

    vi.mocked(getPlatformAdapter).mockResolvedValue({
      fs: {},
      db: { saveAsset: vi.fn() },
    } as any);
    vi.mocked(applyReference).mockResolvedValue({
      newAsset: {
        id: 'asset-2',
        name: 'Asset 2',
        type: 'video',
        source: 'original',
        url: 'asset-2.mp4',
        relativePath: 'Assets/Video/asset-2.mp4',
        fileSize: 10,
        mimeType: 'video/mp4',
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: new Date('2026-05-02T00:00:00.000Z'),
        updatedAt: new Date('2026-05-02T00:00:00.000Z'),
      },
    });

    renderPanel();

    expect(queryPlaybackApply()?.disabled).toBe(true);

    await act(async () => {
      queryPlaybackTrimChange()?.click();
    });

    expect(queryPlaybackApply()?.disabled).toBe(false);

    await act(async () => {
      queryPlaybackApply()?.click();
    });

    const applyCall = vi.mocked(applyReference).mock.calls[0]?.[0];
    expect(applyCall?.reference.cropRect).toBeUndefined();
    expect(applyCall?.reference.trimRange).toEqual({ startMs: 100, endMs: 700 });
  });

  it('syncs the image crop preview when cropRect changes while the overlay stays open', async () => {
    const defaultCropRect = { x: 0, y: 0, width: 1, height: 1 };
    const initialCropRect = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };
    const restoredCropRect = { x: 0.2, y: 0.1, width: 0.5, height: 0.7 };
    referenceCropState.current = {
      cropRect: initialCropRect,
      defaultCropRect,
      isDefaultCrop: false,
    };

    const currentReference = {
      id: 'ref-1',
      assetId: 'asset-1',
      type: 'image',
      cropRect: initialCropRect,
    };
    previewSourceState.current = {
      mode: 'reference',
      asset: {
        id: 'asset-1',
        name: 'Asset 1',
        type: 'image',
        url: 'asset-preview.png',
        width: 1_000,
        height: 500,
      },
      fragment: null,
      reference: currentReference,
      referenceFragmentId: 'fragment-1',
      targetAspectRatio: '1:1',
      previewUrl: 'asset-preview.png',
      previewType: 'image',
      duration: 0,
      waveformDataPath: undefined,
    };
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [currentReference],
      },
    ];

    renderPanel();

    const cropToggle = container.querySelector('button[title="显示裁剪"]') as HTMLButtonElement | null;
    expect(cropToggle).not.toBeNull();

    await act(async () => {
      cropToggle?.click();
    });

    expect(imageCanvasState.current.props?.cropRect).toEqual(initialCropRect);

    referenceCropState.current = {
      cropRect: restoredCropRect,
      defaultCropRect,
      isDefaultCrop: false,
    };

    renderPanel();

    expect(imageCanvasState.current.props?.cropRect).toEqual(restoredCropRect);
  });

  it('applies the latest local crop and trim draft before the throttled store sync flushes', async () => {
    referenceCropState.current = {
      cropRect: { x: 0, y: 0, width: 1, height: 1 },
      defaultCropRect: { x: 0, y: 0, width: 1, height: 1 },
      isDefaultCrop: true,
    };

    const currentReference = {
      id: 'ref-1',
      assetId: 'asset-1',
      type: 'video',
    };
    previewSourceState.current = {
      mode: 'reference',
      asset: {
        id: 'asset-1',
        name: 'Asset 1',
        type: 'video',
        url: 'asset-preview.mp4',
        width: 1920,
        height: 1080,
        duration: 1_000,
      },
      fragment: null,
      reference: currentReference,
      referenceFragmentId: 'fragment-1',
      targetAspectRatio: '16:9',
      previewUrl: 'asset-preview.mp4',
      previewType: 'video',
      duration: 1_000,
      waveformDataPath: undefined,
    };
    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        trimStart: 0,
        references: [currentReference],
      },
    ];
    projectStoreState.current.currentProject = {
      id: 'project-1',
      folderPath: '/tmp/project',
    };

    vi.mocked(getPlatformAdapter).mockResolvedValue({
      fs: {},
      db: { saveAsset: vi.fn() },
    } as any);
    vi.mocked(applyReference).mockResolvedValue({
      newAsset: {
        id: 'asset-2',
        name: 'Asset 2',
        type: 'video',
        source: 'original',
        url: 'asset-2.mp4',
        relativePath: 'Assets/Video/asset-2.mp4',
        fileSize: 10,
        mimeType: 'video/mp4',
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: new Date('2026-05-02T00:00:00.000Z'),
        updatedAt: new Date('2026-05-02T00:00:00.000Z'),
      },
    });

    renderPanel();

    const cropToggle = container.querySelector('button[title="显示裁剪"]') as HTMLButtonElement | null;
    expect(cropToggle).not.toBeNull();

    await act(async () => {
      cropToggle?.click();
    });

    expect(queryCropOverlayChange()).not.toBeNull();

    await act(async () => {
      queryCropOverlayChange()?.click();
      queryPlaybackTrimChange()?.click();
    });

    expect(queryPlaybackApply()?.disabled).toBe(false);

    await act(async () => {
      queryPlaybackApply()?.click();
    });

    expect(applyReference).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyReference).mock.calls[0]?.[0]).toMatchObject({
      reference: {
        cropRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
        trimRange: { startMs: 100, endMs: 700 },
      },
    });
  });
});
