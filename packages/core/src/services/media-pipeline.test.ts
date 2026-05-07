import { describe, expect, it, vi } from 'vitest';
import type { Asset } from '../types/asset';
import type { FileSystemAdapter } from '../adapters/types';
import { runMediaPipeline } from './media-pipeline';
import { tauriBridge } from './tauri-bridge';

vi.mock('../utils/platform', () => ({
  toWebViewUrl: (path: string) => `webview://${path}`,
}));

vi.mock('./tauri-bridge', () => ({
  tauriBridge: {
    mediaApi: {
      process: vi.fn(),
    },
  },
}));

vi.mock('./asset-import', () => ({
  generateThumbnailForAsset: vi.fn().mockResolvedValue({
    thumbnailUrl: undefined,
    waveformDataPath: undefined,
  }),
}));

function makeSourceAsset(): Asset {
  return {
    id: 'source-asset',
    name: 'Source',
    type: 'video',
    source: 'original',
    url: 'file:///project/Assets/Video/source.mp4',
    relativePath: 'Assets/Video/source.mp4',
    fileSize: 100,
    mimeType: 'video/mp4',
    tags: [],
    favorite: false,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeFs(overrides: Partial<FileSystemAdapter> = {}): FileSystemAdapter {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    exists: vi.fn(),
    copyFile: vi.fn(),
    moveFile: vi.fn().mockResolvedValue(undefined),
    getFileSize: vi.fn().mockResolvedValue(1234),
    createDir: vi.fn(),
    removeDir: vi.fn(),
    listDir: vi.fn(),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    selectFile: vi.fn(),
    selectFolder: vi.fn(),
    saveFile: vi.fn(),
    createProjectFolder: vi.fn(),
    importAssetToProject: vi.fn(),
    generateThumbnail: vi.fn(),
    generateImageThumbnail: vi.fn(),
    generateAudioPeakData: vi.fn(),
    getMediaMetadata: vi.fn(),
    saveAutosaveSnapshot: vi.fn(),
    ...overrides,
  } as FileSystemAdapter;
}

describe('runMediaPipeline', () => {
  it('does not mark pipeline asset metadata as hydrated when probing fails', async () => {
    vi.mocked(tauriBridge.mediaApi.process).mockResolvedValueOnce({
      outputPath: 'C:/tmp/output.mp4',
      fileSize: 4321,
      backendUsed: 'gstreamerGes',
    });
    const fs = makeFs({
      getMediaMetadata: vi.fn().mockRejectedValue(new Error('probe failed')),
    });

    const result = await runMediaPipeline({
      inputPath: 'C:/input/source.mp4',
      outputDir: 'C:/tmp',
      processRequest: {},
      assetType: 'video',
      sourceAsset: makeSourceAsset(),
      nameSuffix: 'Cropped',
      projectPath: 'C:/project',
      fs,
    });

    expect(fs.getMediaMetadata).toHaveBeenCalledWith(
      expect.stringMatching(/C:\/project\/Assets\/Video\/.+\.mp4/),
    );
    expect(result.newAsset.mediaMetadataHydrated).toBe(false);
    expect(result.newAsset.audioChannels).toBeUndefined();
  });

  it('marks pipeline asset metadata as hydrated after a successful probe', async () => {
    vi.mocked(tauriBridge.mediaApi.process).mockResolvedValueOnce({
      outputPath: 'C:/tmp/output.mp4',
      fileSize: 4321,
      backendUsed: 'gstreamerGes',
    });
    const fs = makeFs({
      getMediaMetadata: vi.fn().mockResolvedValue({
        width: 1920,
        height: 1080,
        duration: 3000,
        frameRate: 24,
        audioChannels: 2,
        sampleRate: 48000,
      }),
    });

    const result = await runMediaPipeline({
      inputPath: 'C:/input/source.mp4',
      outputDir: 'C:/tmp',
      processRequest: {},
      assetType: 'video',
      sourceAsset: makeSourceAsset(),
      nameSuffix: 'Cropped',
      projectPath: 'C:/project',
      fs,
    });

    expect(result.newAsset).toEqual(expect.objectContaining({
      width: 1920,
      height: 1080,
      duration: 3000,
      fps: 24,
      audioChannels: 2,
      sampleRate: 48000,
      mediaMetadataHydrated: true,
    }));
  });
});
