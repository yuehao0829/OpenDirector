import { describe, expect, it, vi } from 'vitest';
import type { ImportedTimelineProjectData } from './media-exchange-project';
import {
  buildImportedProjectFromTimelineData,
  hydrateImportedProjectAssetMetadata,
} from './media-exchange-project';

function makeImportedTimelineData(): ImportedTimelineProjectData {
  return {
    projectName: 'Imported Timeline',
    fps: 24,
    width: 1920,
    height: 1080,
    assets: [
      {
        id: 'asset-video',
        name: 'plate.mp4',
        localPath: 'C:/media/plate.mp4',
        type: 'video',
        duration: 8000,
        width: 1920,
        height: 1080,
      },
      {
        id: 'asset-audio',
        name: 'voice.wav',
        localPath: 'C:/media/voice.wav',
        type: 'audio',
        duration: 4000,
      },
    ],
    tracks: [
      {
        id: 'video-track-top',
        type: 'video',
        name: 'Video Top',
        muted: false,
        order: 3,
        fragments: [
          {
            id: 'video-fragment-1',
            name: 'Opening',
            start: 1000,
            duration: 3000,
            trimStart: 250,
            sourceAssetId: 'asset-video',
            crop: { x: 10, y: 20, width: 640, height: 360 },
          },
        ],
      },
      {
        id: 'audio-track-main',
        type: 'audio',
        name: 'Audio Main',
        muted: true,
        order: 0,
        fragments: [
          {
            id: 'audio-fragment-1',
            name: 'VO',
            start: 0,
            duration: 2500,
            trimStart: 125,
            sourceAssetId: 'asset-audio',
          },
        ],
      },
    ],
  };
}

describe('buildImportedProjectFromTimelineData', () => {
  it('keeps imported track metadata and projects clip crop into references', () => {
    const project = buildImportedProjectFromTimelineData(
      makeImportedTimelineData(),
      'Imported XGES Project',
    );

    expect(project.name).toBe('Imported Timeline');
    expect(project.tracks.map((track) => ({
      id: track.id,
      type: track.type,
      muted: track.muted,
      order: track.order,
      locked: track.locked,
    }))).toEqual([
      {
        id: 'video-track-top',
        type: 'video',
        muted: false,
        order: 3,
        locked: false,
      },
      {
        id: 'audio-track-main',
        type: 'audio',
        muted: true,
        order: 0,
        locked: false,
      },
    ]);

    const videoFragment = project.fragments.find((fragment) => fragment.id === 'video-fragment-1');
    const audioFragment = project.fragments.find((fragment) => fragment.id === 'audio-fragment-1');

    expect(videoFragment).toEqual(expect.objectContaining({
      trackId: 'video-track-top',
      prompt: 'Opening',
      start: 1000,
      duration: 3000,
      trimStart: 250,
      sourceAssetId: 'asset-video',
      status: 'completed',
    }));
    expect(videoFragment?.references).toHaveLength(1);
    expect(videoFragment?.references[0]).toEqual(expect.objectContaining({
      assetId: 'asset-video',
      type: 'video',
      cropRect: { x: 10, y: 20, width: 640, height: 360 },
    }));

    expect(audioFragment).toEqual(expect.objectContaining({
      trackId: 'audio-track-main',
      prompt: 'VO',
      trimStart: 125,
      sourceAssetId: 'asset-audio',
      status: 'completed',
      references: [],
    }));

    expect(project.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        type: 'video',
        url: 'C:/media/plate.mp4',
        sourcePath: 'C:/media/plate.mp4',
        width: 1920,
        height: 1080,
      }),
      expect.objectContaining({
        id: 'asset-audio',
        type: 'audio',
        url: 'C:/media/voice.wav',
        sourcePath: 'C:/media/voice.wav',
        duration: 4000,
      }),
    ]));

    expect(project.settings).toEqual(expect.objectContaining({
      fps: 24,
      resolution: { width: 1920, height: 1080 },
      defaultAspectRatio: '1920:1080',
    }));
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(project.updatedAt).toBeInstanceOf(Date);
  });

  it('uses the provided fallback project name when import data has no project name', () => {
    const data = makeImportedTimelineData();
    data.projectName = '';

    const project = buildImportedProjectFromTimelineData(data, 'Imported OTIO Project');

    expect(project.name).toBe('Imported OTIO Project');
  });

  it('keeps imported asset metadata retryable when probing fails', async () => {
    const fs = {
      getMediaMetadata: vi.fn().mockRejectedValue(new Error('probe failed')),
    };
    const project = buildImportedProjectFromTimelineData(
      makeImportedTimelineData(),
      'Imported XGES Project',
    );

    const hydrated = await hydrateImportedProjectAssetMetadata(project, fs);

    expect(fs.getMediaMetadata).toHaveBeenCalledTimes(2);
    expect(hydrated).toBe(project);
    expect(hydrated.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        mediaMetadataHydrated: undefined,
      }),
      expect.objectContaining({
        id: 'asset-audio',
        mediaMetadataHydrated: undefined,
      }),
    ]));
  });

  it('hydrates imported asset metadata before the project is opened', async () => {
    const fs = {
      getMediaMetadata: vi.fn()
        .mockResolvedValueOnce({
          duration: 8000,
          width: 1920,
          height: 1080,
          audioChannels: 2,
          sampleRate: 48000,
        })
        .mockResolvedValueOnce({
          duration: 4000,
          audioChannels: 1,
          sampleRate: 44100,
        }),
    };

    const hydrated = await hydrateImportedProjectAssetMetadata(
      buildImportedProjectFromTimelineData(makeImportedTimelineData(), 'Imported XGES Project'),
      fs,
    );

    expect(fs.getMediaMetadata).toHaveBeenCalledTimes(2);
    expect(hydrated.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        audioChannels: 2,
        sampleRate: 48000,
        mediaMetadataHydrated: true,
      }),
      expect.objectContaining({
        id: 'asset-audio',
        audioChannels: 1,
        sampleRate: 44100,
        mediaMetadataHydrated: true,
      }),
    ]));
  });
});
