import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileSystemAdapter } from '../adapters';

const { toWebViewUrlMock } = vi.hoisted(() => ({
  toWebViewUrlMock: vi.fn((path: string) => `asset://${path.replace(/\\/g, '/')}`),
}));

vi.mock('../utils/platform', () => ({
  toWebViewUrl: toWebViewUrlMock,
}));

import {
  completeImportedAsset,
  deleteAssetFiles,
  generateThumbnailForAsset,
  importMultipleAssets,
  resolveImportedAssetAbsolutePath,
  resolveVideoThumbnailTimeSec,
  type ImportBatchOptions,
} from './asset-import';

describe('importMultipleAssets', () => {
  const fs = {
    copyFile: vi.fn(),
    getFileSize: vi.fn(),
    getMediaMetadata: vi.fn(),
    ensureDir: vi.fn(),
    generateThumbnail: vi.fn(),
    generateImageThumbnail: vi.fn(),
    generateAudioPeakData: vi.fn(),
  } as unknown as FileSystemAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('crypto', { randomUUID: vi.fn() });
    vi.mocked((globalThis.crypto as { randomUUID: () => string }).randomUUID).mockReset();
    vi.mocked((globalThis.crypto as { randomUUID: () => string }).randomUUID)
      .mockReturnValueOnce('asset-1')
      .mockReturnValueOnce('asset-2');

    vi.mocked(fs.copyFile).mockReset();
    vi.mocked(fs.getFileSize).mockReset();
    vi.mocked(fs.getMediaMetadata).mockReset();
    vi.mocked(fs.ensureDir).mockReset();
    vi.mocked(fs.generateThumbnail).mockReset();
    vi.mocked(fs.generateImageThumbnail).mockReset();
    vi.mocked(fs.generateAudioPeakData).mockReset();
    toWebViewUrlMock.mockClear();

    vi.mocked(fs.copyFile).mockResolvedValue(1024);
    vi.mocked(fs.getMediaMetadata).mockResolvedValue({
      width: 1920,
      height: 1080,
      duration: 3000,
    });
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
    vi.mocked(fs.generateThumbnail).mockResolvedValue('/project/Thumbnails/asset-1.jpg');
    vi.mocked(fs.generateAudioPeakData).mockResolvedValue('/project/Thumbnails/asset-2.peak');
  });

  it('calls onAssetImported for each successful import in order', async () => {
    const progressUpdates: Array<{ completed: number; current: string; status: string }> = [];
    const imported: string[] = [];
    const options: ImportBatchOptions = {
      projectPath: '/project',
      copyToProject: true,
      onAssetImported: async (result) => {
        imported.push(result.asset.id);
        if (result.asset.id === 'asset-1') {
          const absolutePath = `/project/${result.asset.relativePath}`;
          await generateThumbnailForAsset(
            absolutePath,
            fs,
            result.asset.type,
            '/project',
            result.asset.id,
          );
        }
      },
    };

    const results = await importMultipleAssets(
      ['/imports/video.mp4', '/imports/audio.mp3'],
      fs,
      options,
      (progress) => {
        progressUpdates.push({
          completed: progress.completed,
          current: progress.current,
          status: progress.status,
        });
      },
    );

    expect(results).toHaveLength(2);
    expect(imported).toEqual(['asset-1', 'asset-2']);
    expect(fs.generateThumbnail).toHaveBeenCalledWith(
      '/project/Assets/Video/asset-1.mp4',
      '/project/Thumbnails/asset-1.jpg',
      0.1,
    );
    expect(progressUpdates).toEqual([
      { completed: 0, current: '/imports/video.mp4', status: 'importing' },
      { completed: 1, current: '/imports/audio.mp3', status: 'importing' },
      { completed: 2, current: '', status: 'completed' },
    ]);
  });

  it('keeps import results when onAssetImported fails', async () => {
    const options: ImportBatchOptions = {
      projectPath: '/project',
      copyToProject: true,
      onAssetImported: vi.fn(async (result) => {
        if (result.asset.id === 'asset-1') {
          throw new Error('thumbnail failed');
        }
      }),
    };
    const results = await importMultipleAssets(
      ['/imports/video.mp4', '/imports/audio.mp3'],
      fs,
      options,
    );

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.asset.id)).toEqual(['asset-1', 'asset-2']);
  });
});

describe('imported asset completion', () => {
  const fs = {
    getMediaMetadata: vi.fn(),
    ensureDir: vi.fn(),
    generateThumbnail: vi.fn(),
    generateImageThumbnail: vi.fn(),
    generateAudioPeakData: vi.fn(),
  } as unknown as FileSystemAdapter;

  beforeEach(() => {
    vi.mocked(fs.getMediaMetadata).mockReset();
    vi.mocked(fs.ensureDir).mockReset();
    vi.mocked(fs.generateThumbnail).mockReset();
    vi.mocked(fs.generateImageThumbnail).mockReset();
    vi.mocked(fs.generateAudioPeakData).mockReset();
    toWebViewUrlMock.mockClear();

    vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
    vi.mocked(fs.generateThumbnail).mockResolvedValue('/project/Thumbnails/asset-1.jpg');
  });

  it('refreshes missing metadata before generating an imported video thumbnail', async () => {
    vi.mocked(fs.getMediaMetadata).mockResolvedValue({
      duration: 320,
      width: 1280,
      height: 720,
      frameRate: 30,
      audioChannels: 2,
      sampleRate: 48000,
    });

    const completed = await completeImportedAsset(
      {
        id: 'asset-1',
        name: 'clip.mp4',
        type: 'video',
        source: 'original',
        url: 'asset:///project/Assets/Video/asset-1.mp4',
        relativePath: 'Assets/Video/asset-1.mp4',
        fileSize: 1024,
        mimeType: 'video/mp4',
        tags: [],
        favorite: false,
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      '/project/Assets/Video/asset-1.mp4',
      fs,
      '/project',
    );

    expect(fs.getMediaMetadata).toHaveBeenCalledWith('/project/Assets/Video/asset-1.mp4');
    expect(fs.generateThumbnail).toHaveBeenCalledWith(
      '/project/Assets/Video/asset-1.mp4',
      '/project/Thumbnails/asset-1.jpg',
      0.16,
    );
    expect(completed).toEqual(expect.objectContaining({
      duration: 320,
      width: 1280,
      height: 720,
      fps: 30,
      audioChannels: 2,
      sampleRate: 48000,
      mediaMetadataHydrated: true,
      thumbnailUrl: 'asset:///project/Thumbnails/asset-1.jpg',
    }));
  });

  it('keeps absolute source paths intact for non-copy imports', () => {
    expect(resolveImportedAssetAbsolutePath({
      relativePath: '/external/video.mp4',
      sourcePath: '/external/video.mp4',
    }, '/project')).toBe('/external/video.mp4');

    expect(resolveImportedAssetAbsolutePath({
      relativePath: 'C:\\external\\video.mp4',
      sourcePath: 'C:\\external\\video.mp4',
    }, '/project')).toBe('C:\\external\\video.mp4');
  });
});

describe('resolveVideoThumbnailTimeSec', () => {
  it('uses the clip midpoint for short videos and caps longer clips at 1 second', () => {
    expect(resolveVideoThumbnailTimeSec(320)).toBe(0.16);
    expect(resolveVideoThumbnailTimeSec(4000)).toBe(1);
    expect(resolveVideoThumbnailTimeSec()).toBe(0.1);
  });
});

describe('deleteAssetFiles', () => {
  it('ignores missing files while deleting asset files', async () => {
    const fs = {
      deleteFile: vi.fn()
        .mockRejectedValueOnce(new Error('File not found: /project/Assets/Video/asset-1.mp4'))
        .mockRejectedValueOnce(new Error('No such file: /project/Thumbnails/asset-1.jpg')),
    } as unknown as FileSystemAdapter;

    await expect(deleteAssetFiles({
      id: 'asset-1',
      name: 'video.mp4',
      type: 'video',
      source: 'original',
      url: 'asset:///project/Assets/Video/asset-1.mp4',
      relativePath: 'Assets/Video/asset-1.mp4',
      fileSize: 1024,
      mimeType: 'video/mp4',
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, fs, '/project')).resolves.toBeUndefined();

    expect(fs.deleteFile).toHaveBeenNthCalledWith(1, '/project/Assets/Video/asset-1.mp4');
    expect(fs.deleteFile).toHaveBeenNthCalledWith(2, '/project/Thumbnails/asset-1.jpg');
  });

  it('rethrows non-missing delete errors', async () => {
    const fs = {
      deleteFile: vi.fn().mockRejectedValue(new Error('Permission denied')),
    } as unknown as FileSystemAdapter;

    await expect(deleteAssetFiles({
      id: 'asset-1',
      name: 'audio.mp3',
      type: 'audio',
      source: 'original',
      url: 'asset:///project/Assets/Audio/asset-1.mp3',
      relativePath: 'Assets/Audio/asset-1.mp3',
      fileSize: 1024,
      mimeType: 'audio/mpeg',
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, fs, '/project')).rejects.toThrow('Permission denied');
  });
});
