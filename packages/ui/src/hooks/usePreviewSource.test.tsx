import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { usePreviewStore } from '@opendirector/core/stores/previewStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Asset } from '@opendirector/core/types/asset';
import type { Fragment, Track } from '@opendirector/core/types/timeline';
import { usePreviewSource, type PreviewSource } from './usePreviewSource';

function HookHarness({
  onSourceChange,
}: {
  onSourceChange: (source: PreviewSource) => void;
}) {
  const source = usePreviewSource();

  useEffect(() => {
    onSourceChange(source);
  }, [onSourceChange, source]);

  return null;
}

function buildAsset(overrides: Partial<Asset> = {}): Asset {
  const now = new Date('2026-05-02T00:00:00.000Z');
  return {
    id: 'asset-1',
    name: 'asset-1',
    type: 'video',
    source: 'original',
    url: 'file:///asset-1.mp4',
    fileSize: 1,
    mimeType: 'video/mp4',
    duration: 1_000,
    tags: [],
    favorite: false,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    type: 'video',
    name: 'V1',
    muted: false,
    locked: false,
    order: 0,
    ...overrides,
  };
}

function buildFragment(overrides: Partial<Fragment> = {}): Fragment {
  const now = new Date('2026-05-02T00:00:00.000Z');
  return {
    id: 'fragment-1',
    trackId: 'track-1',
    start: 0,
    duration: 1_000,
    prompt: '',
    references: [],
    status: 'completed',
    sourceAssetId: 'asset-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('usePreviewSource', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestSource: PreviewSource | null;

  const resetStores = () => {
    useTimelineStore.getState().reset();
    useSelectionStore.getState().clear();
    useAssetStore.setState({
      assets: [],
      isLoading: false,
      searchQuery: '',
      source: 'original',
      fileCategory: 'all',
      showUploadedOnly: false,
      pendingDeletions: [],
    });
    usePreviewStore.setState({
      mode: 'timeline',
      assetId: null,
      assetType: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
    });
  };

  beforeEach(() => {
    resetStores();
    latestSource = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    resetStores();
  });

  it('pauses timeline playback when switching to asset preview and keeps it paused when switching back', async () => {
    const asset = buildAsset();
    const track = buildTrack();
    const fragment = buildFragment();

    useAssetStore.setState({ assets: [asset] });
    useTimelineStore.setState({
      tracks: [track],
      fragments: [fragment],
      scenes: [],
      playhead: 100,
      duration: 1_000,
      isPlaying: true,
    });

    await act(async () => {
      root.render(
        <HookHarness
          onSourceChange={(source) => {
            latestSource = source;
          }}
        />,
      );
    });

    expect(latestSource?.mode).toBe('timeline');
    expect(useTimelineStore.getState().isPlaying).toBe(true);

    await act(async () => {
      useSelectionStore.getState().selectAsset(asset.id);
    });

    expect(latestSource?.mode).toBe('asset');
    expect(usePreviewStore.getState().mode).toBe('asset');
    expect(useTimelineStore.getState().isPlaying).toBe(false);

    await act(async () => {
      usePreviewStore.getState().play();
    });
    expect(usePreviewStore.getState().isPlaying).toBe(true);

    await act(async () => {
      useSelectionStore.getState().clearSecondaryFocus();
    });

    expect(latestSource?.mode).toBe('timeline');
    expect(usePreviewStore.getState().mode).toBe('timeline');
    expect(usePreviewStore.getState().isPlaying).toBe(false);
    expect(useTimelineStore.getState().isPlaying).toBe(false);
  });

  it('pauses timeline playback when switching to reference preview', async () => {
    const asset = buildAsset();
    const track = buildTrack();
    const fragment = buildFragment({
      references: [
        {
          id: 'ref-1',
          assetId: asset.id,
          type: 'video',
        },
      ],
    });

    useAssetStore.setState({ assets: [asset] });
    useTimelineStore.setState({
      tracks: [track],
      fragments: [fragment],
      scenes: [],
      playhead: 100,
      duration: 1_000,
      isPlaying: true,
    });

    await act(async () => {
      root.render(
        <HookHarness
          onSourceChange={(source) => {
            latestSource = source;
          }}
        />,
      );
    });

    await act(async () => {
      useSelectionStore.getState().selectReference(fragment.id, 'ref-1');
    });

    expect(latestSource?.mode).toBe('reference');
    expect(usePreviewStore.getState().mode).toBe('reference');
    expect(useTimelineStore.getState().isPlaying).toBe(false);
  });

  it('does not reset reference playback when only trim end changes', async () => {
    const asset = buildAsset({ duration: 2_000 });
    const track = buildTrack();
    const fragment = buildFragment({
      references: [
        {
          id: 'ref-1',
          assetId: asset.id,
          type: 'video',
        },
      ],
    });

    useAssetStore.setState({ assets: [asset] });
    useTimelineStore.setState({
      tracks: [track],
      fragments: [fragment],
      scenes: [],
      playhead: 100,
      duration: 2_000,
      isPlaying: false,
    });

    await act(async () => {
      root.render(
        <HookHarness
          onSourceChange={(source) => {
            latestSource = source;
          }}
        />,
      );
    });

    await act(async () => {
      useSelectionStore.getState().selectReference(fragment.id, 'ref-1');
    });

    await act(async () => {
      usePreviewStore.getState().play();
      usePreviewStore.getState().seek(350);
    });

    expect(usePreviewStore.getState().mode).toBe('reference');
    expect(usePreviewStore.getState().isPlaying).toBe(true);
    expect(usePreviewStore.getState().currentTime).toBe(350);

    await act(async () => {
      useTimelineStore.setState({
        fragments: [
          buildFragment({
            references: [
              {
                id: 'ref-1',
                assetId: asset.id,
                type: 'video',
                trimRange: { startMs: 0, endMs: 700 },
              },
            ],
          }),
        ],
      });
    });

    expect(latestSource?.mode).toBe('reference');
    expect(latestSource?.duration).toBe(700);
    expect(usePreviewStore.getState().mode).toBe('reference');
    expect(usePreviewStore.getState().isPlaying).toBe(true);
    expect(usePreviewStore.getState().currentTime).toBe(350);
    expect(usePreviewStore.getState().duration).toBe(700);
  });

  it('stops playing video at the new trim end when the range shrinks past the current time', async () => {
    const asset = buildAsset({ duration: 2_000 });
    const track = buildTrack();
    const fragment = buildFragment({
      references: [
        {
          id: 'ref-1',
          assetId: asset.id,
          type: 'video',
        },
      ],
    });

    useAssetStore.setState({ assets: [asset] });
    useTimelineStore.setState({
      tracks: [track],
      fragments: [fragment],
      scenes: [],
      playhead: 100,
      duration: 2_000,
      isPlaying: false,
    });

    await act(async () => {
      root.render(
        <HookHarness
          onSourceChange={(source) => {
            latestSource = source;
          }}
        />,
      );
    });

    await act(async () => {
      useSelectionStore.getState().selectReference(fragment.id, 'ref-1');
    });

    await act(async () => {
      usePreviewStore.getState().play();
      usePreviewStore.getState().seek(650);
    });

    expect(usePreviewStore.getState().isPlaying).toBe(true);
    expect(usePreviewStore.getState().currentTime).toBe(650);

    await act(async () => {
      useTimelineStore.setState({
        fragments: [
          buildFragment({
            references: [
              {
                id: 'ref-1',
                assetId: asset.id,
                type: 'video',
                trimRange: { startMs: 0, endMs: 500 },
              },
            ],
          }),
        ],
      });
    });

    expect(latestSource?.mode).toBe('reference');
    expect(latestSource?.duration).toBe(500);
    expect(usePreviewStore.getState().mode).toBe('reference');
    expect(usePreviewStore.getState().isPlaying).toBe(false);
    expect(usePreviewStore.getState().currentTime).toBe(500);
    expect(usePreviewStore.getState().duration).toBe(500);
  });

  it('resets video reference playback when trim start changes during playback', async () => {
    const asset = buildAsset({ duration: 2_000 });
    const track = buildTrack();
    const fragment = buildFragment({
      references: [
        {
          id: 'ref-1',
          assetId: asset.id,
          type: 'video',
        },
      ],
    });

    useAssetStore.setState({ assets: [asset] });
    useTimelineStore.setState({
      tracks: [track],
      fragments: [fragment],
      scenes: [],
      playhead: 100,
      duration: 2_000,
      isPlaying: false,
    });

    await act(async () => {
      root.render(
        <HookHarness
          onSourceChange={(source) => {
            latestSource = source;
          }}
        />,
      );
    });

    await act(async () => {
      useSelectionStore.getState().selectReference(fragment.id, 'ref-1');
    });

    await act(async () => {
      usePreviewStore.getState().play();
      usePreviewStore.getState().seek(350);
    });

    expect(usePreviewStore.getState().isPlaying).toBe(true);
    expect(usePreviewStore.getState().currentTime).toBe(350);

    await act(async () => {
      useTimelineStore.setState({
        fragments: [
          buildFragment({
            references: [
              {
                id: 'ref-1',
                assetId: asset.id,
                type: 'video',
                trimRange: { startMs: 100, endMs: 700 },
              },
            ],
          }),
        ],
      });
    });

    expect(latestSource?.mode).toBe('reference');
    expect(latestSource?.duration).toBe(600);
    expect(usePreviewStore.getState().mode).toBe('reference');
    expect(usePreviewStore.getState().isPlaying).toBe(false);
    expect(usePreviewStore.getState().currentTime).toBe(0);
    expect(usePreviewStore.getState().duration).toBe(600);
  });

  it('resets reference playback when switching to another reference on the same asset', async () => {
    const asset = buildAsset({ duration: 2_000 });
    const track = buildTrack();
    const fragment = buildFragment({
      references: [
        {
          id: 'ref-1',
          assetId: asset.id,
          type: 'audio',
        },
        {
          id: 'ref-2',
          assetId: asset.id,
          type: 'audio',
          trimRange: { startMs: 100, endMs: 700 },
        },
      ],
    });

    useAssetStore.setState({ assets: [asset] });
    useTimelineStore.setState({
      tracks: [track],
      fragments: [fragment],
      scenes: [],
      playhead: 100,
      duration: 2_000,
      isPlaying: false,
    });

    await act(async () => {
      root.render(
        <HookHarness
          onSourceChange={(source) => {
            latestSource = source;
          }}
        />,
      );
    });

    await act(async () => {
      useSelectionStore.getState().selectReference(fragment.id, 'ref-1');
    });

    await act(async () => {
      usePreviewStore.getState().play();
      usePreviewStore.getState().seek(350);
    });

    expect(usePreviewStore.getState().isPlaying).toBe(true);
    expect(usePreviewStore.getState().currentTime).toBe(350);

    await act(async () => {
      useSelectionStore.getState().selectReference(fragment.id, 'ref-2');
    });

    expect(latestSource?.mode).toBe('reference');
    expect(latestSource?.reference?.id).toBe('ref-2');
    expect(latestSource?.duration).toBe(600);
    expect(usePreviewStore.getState().mode).toBe('reference');
    expect(usePreviewStore.getState().isPlaying).toBe(false);
    expect(usePreviewStore.getState().currentTime).toBe(0);
    expect(usePreviewStore.getState().duration).toBe(600);
  });

  it('resets reference playback when switching to the same reference id on another fragment', async () => {
    const asset = buildAsset({ duration: 2_000, type: 'audio', url: 'file:///asset-1.wav' });
    const track = buildTrack();
    const fragmentA = buildFragment({
      id: 'fragment-1',
      references: [
        {
          id: 'ref-1',
          assetId: asset.id,
          type: 'audio',
        },
      ],
    });
    const fragmentB = buildFragment({
      id: 'fragment-2',
      start: 1_000,
      references: [
        {
          id: 'ref-1',
          assetId: asset.id,
          type: 'audio',
        },
      ],
    });

    useAssetStore.setState({ assets: [asset] });
    useTimelineStore.setState({
      tracks: [track],
      fragments: [fragmentA, fragmentB],
      scenes: [],
      playhead: 100,
      duration: 2_000,
      isPlaying: false,
    });

    await act(async () => {
      root.render(
        <HookHarness
          onSourceChange={(source) => {
            latestSource = source;
          }}
        />,
      );
    });

    await act(async () => {
      useSelectionStore.getState().selectReference(fragmentA.id, 'ref-1');
    });

    await act(async () => {
      usePreviewStore.getState().play();
      usePreviewStore.getState().seek(350);
    });

    expect(usePreviewStore.getState().isPlaying).toBe(true);
    expect(usePreviewStore.getState().currentTime).toBe(350);

    await act(async () => {
      useSelectionStore.getState().selectReference(fragmentB.id, 'ref-1');
    });

    expect(latestSource?.mode).toBe('reference');
    expect(latestSource?.referenceFragmentId).toBe('fragment-2');
    expect(usePreviewStore.getState().mode).toBe('reference');
    expect(usePreviewStore.getState().isPlaying).toBe(false);
    expect(usePreviewStore.getState().currentTime).toBe(0);
    expect(usePreviewStore.getState().duration).toBe(2_000);
  });
});
