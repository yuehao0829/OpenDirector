import { describe, expect, it } from 'vitest';
import type { Project } from '../types/project';
import { buildProjectTimelineRenderRequest } from './timeline-render';

function makeProject(): Project {
  const now = new Date('2026-04-27T00:00:00.000Z');

  return {
    id: 'project-1',
    name: 'Timeline Render Test',
    folderPath: 'C:/Projects/TimelineRender',
    tracks: [
      { id: 'video-bottom', type: 'video', name: 'Video Bottom', muted: false, locked: false, order: 0 },
      { id: 'audio-main', type: 'audio', name: 'Audio Main', muted: true, locked: false, order: 0 },
      { id: 'video-top', type: 'video', name: 'Video Top', muted: false, locked: false, order: 2 },
    ],
    fragments: [
      {
        id: 'video-fragment',
        trackId: 'video-top',
        start: 1000,
        duration: 3000,
        prompt: 'Opening',
        references: [
          {
            id: 'ref-1',
            assetId: 'asset-video',
            type: 'video',
            cropRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
          },
        ],
        status: 'completed',
        sourceAssetId: 'asset-video',
        trimStart: 250,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'audio-fragment',
        trackId: 'audio-main',
        start: 0,
        duration: 2500,
        prompt: '',
        references: [],
        status: 'completed',
        resultAssetId: 'asset-audio',
        createdAt: now,
        updatedAt: now,
      },
    ],
    scenes: [],
    assets: [
      {
        id: 'asset-video',
        name: 'hero.mp4',
        type: 'video',
        source: 'original',
        url: 'asset://hero',
        relativePath: 'Assets/hero.mp4',
        fileSize: 100,
        mimeType: 'video/mp4',
        width: 1920,
        height: 1080,
        duration: 5000,
        audioChannels: 2,
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
        sourcePath: 'D:/Media/voice.wav',
        fileSize: 100,
        mimeType: 'audio/wav',
        duration: 2500,
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

describe('buildProjectTimelineRenderRequest', () => {
  it('maps the current project model into a render DTO', () => {
    const project = makeProject();
    const request = buildProjectTimelineRenderRequest({
      project,
      outputPath: 'C:/Exports/timeline.mp4',
      outputFormat: 'mp4',
      assetPathResolver: (asset) => asset.relativePath
        ? `${project.folderPath}/${asset.relativePath}`
        : asset.sourcePath || asset.url,
    });

    expect(request.outputPath).toBe('C:/Exports/timeline.mp4');
    expect(request.outputFormat).toBe('mp4');
    expect(request.width).toBe(1920);
    expect(request.height).toBe(1080);
    expect(request.fps).toBe(25);
    expect(request.tracks).toEqual([
      { id: 'video-top', type: 'video', muted: false, order: 2 },
      { id: 'video-bottom', type: 'video', muted: false, order: 0 },
      { id: 'audio-main', type: 'audio', muted: true, order: 0 },
      { id: '__linked_audio_track__video-top', type: 'audio', muted: false, order: 1 },
    ]);
    expect(request.clips).toEqual([
      expect.objectContaining({
        id: 'video-fragment',
        trackId: 'video-top',
        assetId: 'asset-video',
        inputPath: 'C:/Projects/TimelineRender/Assets/hero.mp4',
        startMs: 1000,
        durationMs: 3000,
        trimStartMs: 250,
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      }),
      expect.objectContaining({
        id: 'audio-fragment',
        trackId: 'audio-main',
        assetId: 'asset-audio',
        inputPath: 'D:/Media/voice.wav',
        startMs: 0,
        durationMs: 2500,
      }),
      expect.objectContaining({
        id: '__linked_audio_clip__video-fragment',
        trackId: '__linked_audio_track__video-top',
        assetId: 'asset-video',
        inputPath: 'C:/Projects/TimelineRender/Assets/hero.mp4',
        startMs: 1000,
        durationMs: 3000,
        trimStartMs: 250,
      }),
    ]);
    expect(request.clips[1]?.trimStartMs).toBeUndefined();
    expect(request.clips[1]?.crop).toBeUndefined();
    expect(request.clips[2]?.crop).toBeUndefined();
  });

  it('skips fragments without a resolvable media asset', () => {
    const project = makeProject();
    project.fragments.push({
      id: 'missing-fragment',
      trackId: 'video-bottom',
      start: 5000,
      duration: 1000,
      prompt: 'Missing',
      references: [],
      status: 'completed',
      sourceAssetId: 'asset-missing',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    project.fragments.push({
      id: 'empty-fragment',
      trackId: 'video-bottom',
      start: 6200,
      duration: 900,
      prompt: 'Empty',
      references: [],
      status: 'draft',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });

    const request = buildProjectTimelineRenderRequest({
      project,
      outputPath: 'C:/Exports/timeline.mp4',
      assetPathResolver: (asset) => asset.relativePath
        ? `${project.folderPath}/${asset.relativePath}`
        : asset.sourcePath || asset.url,
    });

    expect(request.clips).toHaveLength(3);
    expect(request.clips.map((clip) => clip.id)).toEqual([
      'video-fragment',
      'audio-fragment',
      '__linked_audio_clip__video-fragment',
    ]);
  });

  it('throws when every fragment lacks a resolvable media asset', () => {
    const project = makeProject();
    project.fragments = [
      {
        id: 'missing-fragment',
        trackId: 'video-bottom',
        start: 5000,
        duration: 1000,
        prompt: 'Missing',
        references: [],
        status: 'completed',
        sourceAssetId: 'asset-missing',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      {
        id: 'empty-fragment',
        trackId: 'video-bottom',
        start: 6200,
        duration: 900,
        prompt: 'Empty',
        references: [],
        status: 'draft',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ];

    expect(() => buildProjectTimelineRenderRequest({
      project,
      outputPath: 'C:/Exports/timeline.mp4',
      assetPathResolver: (asset) => asset.relativePath
        ? `${project.folderPath}/${asset.relativePath}`
        : asset.sourcePath || asset.url,
    })).toThrowError('Timeline render requires media-backed fragments');
  });
});
