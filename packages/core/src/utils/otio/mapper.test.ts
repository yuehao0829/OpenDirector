import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import type { OtioClip } from './types';
import { mapOtioTimelineToProjectData, mapProjectToOtioTimeline } from './mapper';
import { parseOtioTimeline } from './parser';
import { serializeOtioTimeline } from './serializer';

function makeProject(): Project {
  const now = new Date('2026-04-24T00:00:00.000Z');

  return {
    id: 'project-1',
    name: 'OTIO Export Test',
    folderPath: 'C:\\Projects\\OtioExportTest',
    tracks: [
      { id: 'video-top', type: 'video', name: 'Video Top', muted: false, locked: false, order: 1 },
      { id: 'audio-main', type: 'audio', name: 'Audio Main', muted: true, locked: false, order: 0 },
    ],
    fragments: [
      {
        id: 'fragment-1',
        trackId: 'video-top',
        start: 1000,
        duration: 2000,
        prompt: 'Opening shot',
        references: [],
        status: 'completed',
        sourceAssetId: 'asset-video',
        trimStart: 500,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'fragment-2',
        trackId: 'audio-main',
        start: 0,
        duration: 1500,
        prompt: 'VO',
        references: [],
        status: 'completed',
        resultAssetId: 'asset-audio',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'fragment-3',
        trackId: 'video-top',
        start: 4000,
        duration: 1000,
        prompt: 'Missing media',
        references: [],
        status: 'completed',
        sourceAssetId: 'asset-missing-path',
        createdAt: now,
        updatedAt: now,
      },
    ],
    scenes: [],
    assets: [
      {
        id: 'asset-video',
        name: 'shot-a.mp4',
        type: 'video',
        source: 'original',
        url: 'asset://shot-a',
        relativePath: 'Assets/Video/shot-a.mp4',
        fileSize: 100,
        mimeType: 'video/mp4',
        duration: 5000,
        width: 1920,
        height: 1080,
        fps: 25,
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
        source: 'generated',
        url: 'asset://voice',
        sourcePath: 'D:\\Media\\voice.wav',
        fileSize: 100,
        mimeType: 'audio/wav',
        duration: 1500,
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'asset-missing-path',
        name: 'missing.mov',
        type: 'video',
        source: 'original',
        url: 'asset://missing',
        fileSize: 100,
        mimeType: 'video/quicktime',
        duration: 1000,
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

describe('mapProjectToOtioTimeline', () => {
  it('exports clips, gaps, media references, and warnings', () => {
    const project = makeProject();
    const result = mapProjectToOtioTimeline({
      project,
      assetPathResolver: (asset) => {
        if (project.folderPath && asset.relativePath) {
          return `${project.folderPath}\\${asset.relativePath.replace(/\//g, '\\')}`;
        }
        return asset.sourcePath;
      },
    });

    expect(result.timeline.OTIO_SCHEMA).toBe('Timeline.1');
    expect(result.summary.clipCount).toBe(3);
    expect(result.summary.trackCount).toBe(2);

    const [videoTrack, audioTrack] = result.timeline.tracks.children;
    expect(videoTrack.kind).toBe('Video');
    expect(videoTrack.children[0]?.OTIO_SCHEMA).toBe('Gap.1');
    expect(videoTrack.children[1]?.OTIO_SCHEMA).toBe('Clip.1');

    const firstVideoClip = videoTrack.children[1];
    if (firstVideoClip?.OTIO_SCHEMA !== 'Clip.1') {
      throw new Error('expected clip');
    }
    const typedFirstVideoClip = firstVideoClip as OtioClip;

    expect(typedFirstVideoClip.media_reference?.target_url).toBe('file:///C:/Projects/OtioExportTest/Assets/Video/shot-a.mp4');
    expect(typedFirstVideoClip.source_range.start_time.value).toBe(12.5);
    expect(typedFirstVideoClip.source_range.duration.value).toBe(50);

    const firstAudioClip = audioTrack.children[0];
    if (firstAudioClip?.OTIO_SCHEMA !== 'Clip.1') {
      throw new Error('expected clip');
    }
    const typedFirstAudioClip = firstAudioClip as OtioClip;

    expect(typedFirstAudioClip.media_reference?.target_url).toBe('file:///D:/Media/voice.wav');
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'missing_asset_path' }),
    ]);
  });
});

describe('mapOtioTimelineToProjectData', () => {
  it('imports exported OTIO back into normalized track and asset data', () => {
    const project = makeProject();
    const exported = mapProjectToOtioTimeline({
      project,
      assetPathResolver: (asset) => {
        if (project.folderPath && asset.relativePath) {
          return `${project.folderPath}\\${asset.relativePath.replace(/\//g, '\\')}`;
        }
        return asset.sourcePath;
      },
    });

    const parsed = parseOtioTimeline(serializeOtioTimeline(exported.timeline));
    const imported = mapOtioTimelineToProjectData(parsed);

    expect(imported.projectName).toBe(project.name);
    expect(imported.fps).toBe(25);
    expect(imported.width).toBe(1920);
    expect(imported.height).toBe(1080);
    expect(imported.summary.trackCount).toBe(2);
    expect(imported.summary.clipCount).toBe(3);

    const videoTrack = imported.tracks.find((track) => track.type === 'video');
    const audioTrack = imported.tracks.find((track) => track.type === 'audio');

    expect(videoTrack?.order).toBe(0);
    expect(videoTrack?.muted).toBe(false);
    expect(videoTrack?.fragments.map((fragment) => fragment.start)).toEqual([1000, 4000]);
    expect(videoTrack?.fragments[0]?.trimStart).toBe(500);

    expect(audioTrack?.order).toBe(0);
    expect(audioTrack?.muted).toBe(true);
    expect(audioTrack?.fragments[0]?.sourceAssetId).toBe('asset-audio');

    expect(imported.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'asset-video',
          localPath: 'C:/Projects/OtioExportTest/Assets/Video/shot-a.mp4',
          type: 'video',
        }),
        expect.objectContaining({
          id: 'asset-audio',
          localPath: 'D:/Media/voice.wav',
          type: 'audio',
        }),
      ]),
    );
    expect(imported.warnings).toEqual([
      expect.objectContaining({ code: 'missing_media_reference' }),
    ]);
  });
});
