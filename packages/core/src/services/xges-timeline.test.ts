import { describe, expect, it } from 'vitest';
import type { Project } from '../types/project';
import { buildXgesExportTimeline } from './xges-timeline';

function makeProject(): Project {
  const now = new Date('2026-04-24T00:00:00.000Z');

  return {
    id: 'project-1',
    name: 'XGES Export Test',
    folderPath: 'C:/Projects/XgesExportTest',
    tracks: [
      { id: 'video-bottom', type: 'video', name: 'Video Bottom', muted: false, locked: false, order: 0 },
      { id: 'audio-main', type: 'audio', name: 'Audio Main', muted: true, locked: false, order: 0 },
      { id: 'video-top', type: 'video', name: 'Video Top', muted: false, locked: false, order: 2 },
      { id: 'audio-ambience', type: 'audio', name: 'Audio Ambience', muted: false, locked: false, order: 1 },
    ],
    fragments: [
      {
        id: 'fragment-video',
        trackId: 'video-top',
        start: 1000,
        duration: 3000,
        prompt: 'Hero Shot',
        references: [
          {
            id: 'ref-1',
            assetId: 'asset-video',
            type: 'video',
            cropRect: { x: 0.1, y: 0.2, width: 0.7, height: 0.5 },
          },
        ],
        status: 'completed',
        sourceAssetId: 'asset-video',
        trimStart: 250,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'fragment-audio',
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

describe('buildXgesExportTimeline', () => {
  it('builds ordered tracks and clip payloads from the project model', () => {
    const project = makeProject();
    const timeline = buildXgesExportTimeline({
      project,
      assetPathResolver: (asset) => asset.relativePath
        ? `${project.folderPath}/${asset.relativePath}`
        : asset.sourcePath || asset.url,
    });

    expect(timeline.projectName).toBe('XGES Export Test');
    expect(timeline.width).toBe(1920);
    expect(timeline.height).toBe(1080);
    expect(timeline.fps).toBe(25);
    expect(timeline.tracks).toEqual([
      { id: 'video-top', type: 'video', muted: false, order: 2 },
      { id: 'video-bottom', type: 'video', muted: false, order: 0 },
      { id: 'audio-main', type: 'audio', muted: true, order: 0 },
      { id: 'audio-ambience', type: 'audio', muted: false, order: 1 },
    ]);
    expect(timeline.clips).toEqual([
      expect.objectContaining({
        id: 'fragment-video',
        trackId: 'video-top',
        inputPath: 'C:/Projects/XgesExportTest/Assets/hero.mp4',
        name: 'Hero Shot',
        startMs: 1000,
        durationMs: 3000,
        trimStartMs: 250,
        crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.5 },
      }),
      expect.objectContaining({
        id: 'fragment-audio',
        trackId: 'audio-main',
        inputPath: 'D:/Media/voice.wav',
        name: 'voice.wav',
        startMs: 0,
        durationMs: 2500,
      }),
    ]);
    expect(timeline.clips[1]?.trimStartMs).toBeUndefined();
    expect(timeline.clips[1]?.crop).toBeUndefined();
  });

  it('skips fragments without a resolvable media asset', () => {
    const project = makeProject();
    project.fragments.push({
      id: 'fragment-missing',
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
      id: 'fragment-empty',
      trackId: 'video-bottom',
      start: 6200,
      duration: 900,
      prompt: 'Empty',
      references: [],
      status: 'draft',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });

    const timeline = buildXgesExportTimeline({
      project,
      assetPathResolver: (asset) => asset.relativePath
        ? `${project.folderPath}/${asset.relativePath}`
        : asset.sourcePath || asset.url,
    });

    expect(timeline.clips).toHaveLength(2);
    expect(timeline.clips.map((clip) => clip.id)).toEqual([
      'fragment-video',
      'fragment-audio',
    ]);
  });

  it('throws when every fragment lacks a resolvable media asset', () => {
    const project = makeProject();
    project.fragments = [
      {
        id: 'fragment-missing',
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
        id: 'fragment-empty',
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

    expect(() => buildXgesExportTimeline({
      project,
      assetPathResolver: (asset) => asset.relativePath
        ? `${project.folderPath}/${asset.relativePath}`
        : asset.sourcePath || asset.url,
    })).toThrowError('XGES export requires media-backed fragments');
  });
});
