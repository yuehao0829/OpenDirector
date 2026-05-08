import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from '../adapters/types';
import type { Project } from '../types/project';

const {
  saveFileMock,
  renderMock,
  getMediaMetadataMock,
  writeFileMock,
  getPlatformAdapterMock,
} = vi.hoisted(() => ({
  saveFileMock: vi.fn(),
  renderMock: vi.fn(),
  getMediaMetadataMock: vi.fn(),
  writeFileMock: vi.fn(),
  getPlatformAdapterMock: vi.fn(),
}));

vi.mock('../adapters', () => ({
  getPlatformAdapter: getPlatformAdapterMock,
}));

vi.mock('./tauri-bridge', () => ({
  tauriBridge: {
    mediaApi: {
      render: renderMock,
    },
  },
}));

import { exportTimelineRenderProject } from './project-service';
import { t } from '../i18n';
import { useAssetStore } from '../stores/assetStore';
import { useProjectStore } from '../stores/projectStore';
import { useTimelineStore } from '../stores/timelineStore';
import { clearHistory, flushSnapshot, pushBaseSnapshot, undo } from '../stores/undoManager';
import { ensureProjectVideoSourceAudioMetadata } from './project-service';

function makeProject(tracks: Project['tracks']): Project {
  const now = new Date('2026-04-27T00:00:00.000Z');

  return {
    id: 'project-1',
    name: 'Timeline Render Test',
    folderPath: 'C:/Projects/TimelineRender',
    fileName: 'Timeline Render Test.odp',
    tracks,
    fragments: [],
    scenes: [],
    assets: [],
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

function makePlatformAdapter(): PlatformAdapter {
  return {
    storage: {} as PlatformAdapter['storage'],
    db: {} as PlatformAdapter['db'],
    fs: {
      saveFile: saveFileMock,
      getMediaMetadata: getMediaMetadataMock,
      writeFile: writeFileMock,
    } as unknown as PlatformAdapter['fs'],
    platform: 'windows',
  };
}

describe('exportTimelineRenderProject', () => {
  beforeEach(() => {
    saveFileMock.mockReset();
    renderMock.mockReset();
    getMediaMetadataMock.mockReset();
    writeFileMock.mockReset();
    getPlatformAdapterMock.mockReset();
    clearHistory();
    getPlatformAdapterMock.mockResolvedValue(makePlatformAdapter());
    getMediaMetadataMock.mockResolvedValue({
      duration: 5000,
      width: 1920,
      height: 1080,
      audioChannels: undefined,
      sampleRate: undefined,
    });
    writeFileMock.mockResolvedValue(undefined);

    useProjectStore.setState({
      currentProject: null,
      isLoading: false,
      isDirty: false,
      lastSavedAt: null,
    });
    useTimelineStore.setState({
      tracks: [],
      fragments: [],
      scenes: [],
    });
    useAssetStore.setState({
      assets: [],
      pendingDeletions: [],
    });
  });

  it('builds a render request from the latest project snapshot and infers video output format', async () => {
    const project = makeProject([
      { id: 'video-bottom', type: 'video', name: 'Video Bottom', muted: false, locked: false, order: 0 },
      { id: 'audio-main', type: 'audio', name: 'Audio Main', muted: true, locked: false, order: 0 },
      { id: 'video-top', type: 'video', name: 'Video Top', muted: false, locked: false, order: 2 },
    ]);

    useProjectStore.setState({ currentProject: project });
    useTimelineStore.setState({
      tracks: project.tracks,
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
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
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
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      scenes: [],
    });
    useAssetStore.setState({
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
          tags: [],
          favorite: false,
          usageCount: 0,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
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
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      pendingDeletions: [],
    });

    saveFileMock.mockResolvedValue('C:/Exports/final-cut.mov');
    renderMock.mockImplementation(async () => {
      expect(useProjectStore.getState().isLoading).toBe(true);
      return {
        outputPath: 'C:/Exports/final-cut.mov',
        fileSize: 1024,
        backendUsed: 'gstreamerGes',
      };
    });

      await exportTimelineRenderProject();

      expect(saveFileMock).toHaveBeenCalledWith('Timeline Render Test.mp4', [
        { name: t('common.fileFilters.mp4Video'), extensions: ['mp4'] },
        { name: t('common.fileFilters.quickTimeMov'), extensions: ['mov'] },
        { name: t('common.fileFilters.wavAudio'), extensions: ['wav'] },
        { name: t('common.fileFilters.mp3Audio'), extensions: ['mp3'] },
      ]);
    expect(renderMock).toHaveBeenCalledWith({
      outputPath: 'C:/Exports/final-cut.mov',
      outputFormat: 'mov',
      width: 1920,
      height: 1080,
      fps: 25,
      tracks: [
        { id: 'video-top', type: 'video', muted: false, order: 2 },
        { id: 'video-bottom', type: 'video', muted: false, order: 0 },
        { id: 'audio-main', type: 'audio', muted: true, order: 0 },
      ],
      clips: [
        {
          id: 'video-fragment',
          trackId: 'video-top',
          assetId: 'asset-video',
          inputPath: 'C:/Projects/TimelineRender/Assets/hero.mp4',
          startMs: 1000,
          durationMs: 3000,
          trimStartMs: 250,
          crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
        },
        {
          id: 'audio-fragment',
          trackId: 'audio-main',
          assetId: 'asset-audio',
          inputPath: 'D:/Media/voice.wav',
          startMs: 0,
          durationMs: 2500,
        },
      ],
    });
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  it('uses an audio default filename and does not render when the dialog is cancelled', async () => {
    const project = makeProject([
      { id: 'audio-main', type: 'audio', name: 'Audio Main', muted: false, locked: false, order: 0 },
    ]);

    useProjectStore.setState({ currentProject: project });
    useTimelineStore.setState({
      tracks: project.tracks,
      fragments: [],
      scenes: [],
    });

    saveFileMock.mockResolvedValue(null);

      await exportTimelineRenderProject();

      expect(saveFileMock).toHaveBeenCalledWith('Timeline Render Test.wav', [
        { name: t('common.fileFilters.mp4Video'), extensions: ['mp4'] },
        { name: t('common.fileFilters.quickTimeMov'), extensions: ['mov'] },
        { name: t('common.fileFilters.wavAudio'), extensions: ['wav'] },
        { name: t('common.fileFilters.mp3Audio'), extensions: ['mp3'] },
      ]);
    expect(renderMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  it('infers mp3 output format for audio-only renders', async () => {
    const project = makeProject([
      { id: 'audio-main', type: 'audio', name: 'Audio Main', muted: false, locked: false, order: 0 },
    ]);

    useProjectStore.setState({ currentProject: project });
    useTimelineStore.setState({
      tracks: project.tracks,
      fragments: [
        {
          id: 'audio-fragment',
          trackId: 'audio-main',
          start: 0,
          duration: 1000,
          prompt: '',
          references: [],
          status: 'completed',
          sourceAssetId: 'asset-audio',
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      scenes: [],
    });
    useAssetStore.setState({
      assets: [
        {
          id: 'asset-audio',
          name: 'voice.wav',
          type: 'audio',
          source: 'original',
          url: 'asset://voice',
          sourcePath: 'D:/Media/voice.wav',
          fileSize: 100,
          mimeType: 'audio/wav',
          duration: 1000,
          tags: [],
          favorite: false,
          usageCount: 0,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      pendingDeletions: [],
    });

    saveFileMock.mockResolvedValue('C:/Exports/audio-mix.mp3');
    renderMock.mockResolvedValue({
      outputPath: 'C:/Exports/audio-mix.mp3',
      fileSize: 512,
      backendUsed: 'gstreamerGes',
    });

    await exportTimelineRenderProject();

    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      outputPath: 'C:/Exports/audio-mix.mp3',
      outputFormat: 'mp3',
    }));
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  it('resets loading state when render fails', async () => {
    const project = makeProject([
      { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
    ]);

    useProjectStore.setState({ currentProject: project });
    useTimelineStore.setState({
      tracks: project.tracks,
      fragments: [
        {
          id: 'video-fragment',
          trackId: 'video-main',
          start: 0,
          duration: 1000,
          prompt: '',
          references: [],
          status: 'completed',
          sourceAssetId: 'asset-video',
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      scenes: [],
    });
    useAssetStore.setState({
      assets: [
        {
          id: 'asset-video',
          name: 'hero.mp4',
          type: 'video',
          source: 'original',
          url: 'asset://hero',
          sourcePath: 'D:/Media/hero.mp4',
          fileSize: 100,
          mimeType: 'video/mp4',
          duration: 1000,
          tags: [],
          favorite: false,
          usageCount: 0,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      pendingDeletions: [],
    });

    saveFileMock.mockResolvedValue('C:/Exports/failure.mp4');
    renderMock.mockRejectedValue(new Error('render failed'));

    await expect(exportTimelineRenderProject()).rejects.toThrow('render failed');
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  it('hydrates referenced video source audio metadata before render when needed', async () => {
    const project = makeProject([
      { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
    ]);

    useProjectStore.setState({ currentProject: project });
    useTimelineStore.setState({
      tracks: project.tracks,
      fragments: [
        {
          id: 'video-fragment',
          trackId: 'video-main',
          start: 0,
          duration: 1000,
          prompt: '',
          references: [],
          status: 'completed',
          sourceAssetId: 'asset-video',
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      scenes: [],
    });
    useAssetStore.setState({
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
          duration: 1000,
          tags: [],
          favorite: false,
          usageCount: 0,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
      pendingDeletions: [],
    });

    saveFileMock.mockResolvedValue('C:/Exports/hydrated.mp4');
    getMediaMetadataMock.mockResolvedValueOnce({
      duration: 1000,
      width: 1920,
      height: 1080,
      audioChannels: 2,
      sampleRate: 48000,
    });
    renderMock.mockResolvedValue({
      outputPath: 'C:/Exports/hydrated.mp4',
      fileSize: 1024,
      backendUsed: 'gstreamerGes',
    });

    await exportTimelineRenderProject();

    expect(getMediaMetadataMock).toHaveBeenCalledWith('C:/Projects/TimelineRender/Assets/hero.mp4');
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({
      tracks: [
        { id: 'video-main', type: 'video', muted: false, order: 0 },
        { id: '__linked_audio_track__video-main', type: 'audio', muted: false, order: 0 },
      ],
      clips: [
        {
          id: 'video-fragment',
          trackId: 'video-main',
          assetId: 'asset-video',
          inputPath: 'C:/Projects/TimelineRender/Assets/hero.mp4',
          startMs: 0,
          durationMs: 1000,
          trimStartMs: undefined,
          crop: undefined,
          transform: undefined,
        },
        {
          id: '__linked_audio_clip__video-fragment',
          trackId: '__linked_audio_track__video-main',
          assetId: 'asset-video',
          inputPath: 'C:/Projects/TimelineRender/Assets/hero.mp4',
          startMs: 0,
          durationMs: 1000,
          trimStartMs: undefined,
          crop: undefined,
          transform: undefined,
        },
      ],
    }));
    expect(useAssetStore.getState().assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        audioChannels: 2,
        sampleRate: 48000,
        mediaMetadataHydrated: true,
      }),
    ]));
  });

  it('does not mark failed probes as hydrated and lets later calls retry', async () => {
    const project = makeProject([
      { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
    ]);
    const projectSnapshot: Project = {
      ...project,
      fragments: [
        {
          id: 'video-fragment',
          trackId: 'video-main',
          start: 0,
          duration: 1000,
          prompt: '',
          references: [],
          status: 'completed',
          sourceAssetId: 'asset-video',
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
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
          duration: 1000,
          tags: [],
          favorite: false,
          usageCount: 0,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
    };

    useTimelineStore.setState({
      tracks: projectSnapshot.tracks,
      fragments: projectSnapshot.fragments,
      scenes: projectSnapshot.scenes,
    });
    useAssetStore.setState({
      assets: projectSnapshot.assets,
      pendingDeletions: [],
    });
    useProjectStore.setState({ currentProject: projectSnapshot });

    getMediaMetadataMock.mockRejectedValueOnce(new Error('probe failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const hydratedProject = await ensureProjectVideoSourceAudioMetadata(projectSnapshot);
      const failedAsset = hydratedProject.assets.find((asset) => asset.id === 'asset-video');

      expect(getMediaMetadataMock).toHaveBeenCalledTimes(1);
      expect(writeFileMock).not.toHaveBeenCalled();
      expect(failedAsset?.audioChannels).toBeUndefined();
      expect(failedAsset?.sampleRate).toBeUndefined();
      expect(failedAsset?.mediaMetadataHydrated).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refreshes undo and saved snapshots after background hydration', async () => {
    const project = makeProject([
      { id: 'video-main', type: 'video', name: 'Video Main', muted: false, locked: false, order: 0 },
    ]);
    const projectSnapshot: Project = {
      ...project,
      fragments: [
        {
          id: 'video-fragment',
          trackId: 'video-main',
          start: 0,
          duration: 1000,
          prompt: '',
          references: [],
          status: 'completed',
          sourceAssetId: 'asset-video',
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
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
          duration: 1000,
          tags: [],
          favorite: false,
          usageCount: 0,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      ],
    };

    useTimelineStore.setState({
      tracks: projectSnapshot.tracks,
      fragments: projectSnapshot.fragments,
      scenes: projectSnapshot.scenes,
    });
    useAssetStore.setState({
      assets: projectSnapshot.assets,
      pendingDeletions: [],
    });
    useProjectStore.setState({
      currentProject: projectSnapshot,
      isDirty: false,
      lastSavedAt: project.createdAt,
    });
    pushBaseSnapshot();

    getMediaMetadataMock.mockResolvedValueOnce({
      duration: 1000,
      width: 1920,
      height: 1080,
      audioChannels: 2,
      sampleRate: 48000,
    });

    await ensureProjectVideoSourceAudioMetadata(projectSnapshot);

    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(useAssetStore.getState().assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        audioChannels: 2,
        sampleRate: 48000,
        mediaMetadataHydrated: true,
        favorite: false,
      }),
    ]));

    useAssetStore.getState().updateAsset('asset-video', { favorite: true });
    flushSnapshot();
    expect(useProjectStore.getState().isDirty).toBe(true);

    const { changed, currentSnapshot } = undo();
    useProjectStore.getState().afterUndoRedo(currentSnapshot);

    expect(changed).toBe(true);
    expect(useAssetStore.getState().assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'asset-video',
        audioChannels: 2,
        sampleRate: 48000,
        mediaMetadataHydrated: true,
        favorite: false,
      }),
    ]));
    expect(useProjectStore.getState().isDirty).toBe(false);
  });
});
