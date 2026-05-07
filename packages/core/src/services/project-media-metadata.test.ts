import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types/project';
import {
  hydrateProjectVideoSourceAudioMetadata,
  mergeProjectAssetMetadata,
  projectNeedsVideoSourceAudioMetadataHydration,
} from './project-media-metadata';

function makeProject(): Project {
  const now = new Date('2026-04-29T00:00:00.000Z');

  return {
    id: 'project-1',
    name: 'Metadata Hydration',
    folderPath: 'C:/Projects/MetadataHydration',
    fileName: 'MetadataHydration.odp',
    tracks: [
      { id: 'video-track', type: 'video', name: 'Video', muted: false, locked: false, order: 0 },
      { id: 'audio-track', type: 'audio', name: 'Audio', muted: false, locked: false, order: 0 },
    ],
    fragments: [
      {
        id: 'video-fragment',
        trackId: 'video-track',
        start: 0,
        duration: 3000,
        prompt: '',
        references: [],
        status: 'completed',
        sourceAssetId: 'asset-video-used',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'audio-fragment',
        trackId: 'audio-track',
        start: 0,
        duration: 3000,
        prompt: '',
        references: [],
        status: 'completed',
        sourceAssetId: 'asset-audio',
        createdAt: now,
        updatedAt: now,
      },
    ],
    scenes: [],
    assets: [
      {
        id: 'asset-video-used',
        name: 'used.mp4',
        type: 'video',
        source: 'original',
        url: 'asset://used',
        relativePath: 'Assets/Video/used.mp4',
        fileSize: 100,
        mimeType: 'video/mp4',
        duration: 5000,
        width: 1920,
        height: 1080,
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'asset-video-unused',
        name: 'unused.mp4',
        type: 'video',
        source: 'original',
        url: 'asset://unused',
        relativePath: 'Assets/Video/unused.mp4',
        fileSize: 100,
        mimeType: 'video/mp4',
        duration: 5000,
        width: 1920,
        height: 1080,
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'asset-audio',
        name: 'voice.wav',
        type: 'audio',
        source: 'original',
        url: 'asset://voice',
        sourcePath: 'D:/Media/voice.wav',
        fileSize: 100,
        mimeType: 'audio/wav',
        duration: 3000,
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    settings: {
      fps: 25,
      resolution: { width: 1920, height: 1080 },
      defaultProvider: 'test',
      defaultAspectRatio: '16:9',
      providerConfig: {},
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('project-media-metadata', () => {
  it('hydrates only timeline-referenced videos with missing embedded audio metadata', async () => {
    const project = makeProject();
    const fs = {
      getMediaMetadata: vi.fn().mockResolvedValue({
        duration: 5000,
        width: 1920,
        height: 1080,
        audioChannels: 2,
        sampleRate: 48000,
      }),
    };

    expect(projectNeedsVideoSourceAudioMetadataHydration(project)).toBe(true);

    const hydratedProject = await hydrateProjectVideoSourceAudioMetadata(project, fs);

    expect(fs.getMediaMetadata).toHaveBeenCalledTimes(1);
    expect(fs.getMediaMetadata).toHaveBeenCalledWith(
      'C:/Projects/MetadataHydration/Assets/Video/used.mp4',
    );
    const usedVideo = hydratedProject.assets.find((asset) => asset.id === 'asset-video-used');
    const unusedVideo = hydratedProject.assets.find((asset) => asset.id === 'asset-video-unused');
    const audioAsset = hydratedProject.assets.find((asset) => asset.id === 'asset-audio');

    expect(usedVideo).toEqual(expect.objectContaining({
      audioChannels: 2,
      sampleRate: 48000,
      mediaMetadataHydrated: true,
    }));
    expect(unusedVideo?.audioChannels).toBeUndefined();
    expect(unusedVideo?.mediaMetadataHydrated).toBeUndefined();
    expect(audioAsset?.audioChannels).toBeUndefined();
    expect(audioAsset?.mediaMetadataHydrated).toBeUndefined();
    expect(projectNeedsVideoSourceAudioMetadataHydration(hydratedProject)).toBe(false);
  });

  it('marks silent timeline videos as hydrated so later calls skip re-probing', async () => {
    const project = makeProject();
    const fs = {
      getMediaMetadata: vi.fn().mockResolvedValue({
        duration: 5000,
        width: 1920,
        height: 1080,
        audioChannels: undefined,
        sampleRate: undefined,
      }),
    };

    const hydratedProject = await hydrateProjectVideoSourceAudioMetadata(project, fs);
    const mergedAssets = mergeProjectAssetMetadata(project.assets, hydratedProject.assets);
    const mergedProject = { ...project, assets: mergedAssets };

    expect(fs.getMediaMetadata).toHaveBeenCalledTimes(1);
    expect(mergedProject.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video-used',
        audioChannels: undefined,
        sampleRate: undefined,
        mediaMetadataHydrated: true,
      }),
    ]));
    expect(projectNeedsVideoSourceAudioMetadataHydration(mergedProject)).toBe(false);
  });

  it('keeps failed probes retryable instead of persisting hydrated state', async () => {
    const project = makeProject();
    const fs = {
      getMediaMetadata: vi.fn().mockRejectedValue(new Error('probe failed')),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const hydratedProject = await hydrateProjectVideoSourceAudioMetadata(project, fs);
      const failedAsset = hydratedProject.assets.find((asset) => asset.id === 'asset-video-used');

      expect(fs.getMediaMetadata).toHaveBeenCalledTimes(1);
      expect(hydratedProject).toBe(project);
      expect(failedAsset?.audioChannels).toBeUndefined();
      expect(failedAsset?.sampleRate).toBeUndefined();
      expect(failedAsset?.mediaMetadataHydrated).toBeUndefined();
      expect(projectNeedsVideoSourceAudioMetadataHydration(hydratedProject)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
