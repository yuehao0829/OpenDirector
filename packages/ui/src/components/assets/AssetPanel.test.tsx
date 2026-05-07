import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@opendirector/core/types';
import type { ReactNode } from 'react';

const {
  getPlatformAdapterMock,
  importMultipleAssetsMock,
  completeImportedAssetMock,
  addAssetMock,
  updateAssetMock,
} = vi.hoisted(() => ({
  getPlatformAdapterMock: vi.fn(),
  importMultipleAssetsMock: vi.fn(),
  completeImportedAssetMock: vi.fn(),
  addAssetMock: vi.fn(),
  updateAssetMock: vi.fn(),
}));

const assetStoreState = vi.hoisted(() => ({
  source: 'original' as const,
  fileCategory: 'all' as const,
  searchQuery: '',
  showUploadedOnly: false,
  assets: [] as Array<{ remoteAssetStatus?: string }>,
  setSource: vi.fn(),
  setFileCategory: vi.fn(),
  setSearchQuery: vi.fn(),
  setShowUploadedOnly: vi.fn(),
  addAsset: addAssetMock,
  updateAsset: updateAssetMock,
  getAssetBySourcePath: vi.fn(() => null),
}));

const projectStoreState = vi.hoisted(() => ({
  currentProject: { folderPath: '/project' },
  createProject: vi.fn(),
  openProjectDialog: vi.fn(),
  saveProject: vi.fn(),
}));

vi.mock('@opendirector/core/adapters', () => ({
  getPlatformAdapter: getPlatformAdapterMock,
}));

vi.mock('@opendirector/core/services/asset-import', () => ({
  importMultipleAssets: importMultipleAssetsMock,
  completeImportedAsset: completeImportedAssetMock,
  resolveImportedAssetAbsolutePath: (asset: Pick<Asset, 'relativePath' | 'sourcePath'>, projectPath?: string) => {
    if (asset.relativePath?.startsWith('/')) {
      return asset.relativePath;
    }
    return asset.relativePath && projectPath
      ? `${projectPath}/${asset.relativePath}`
      : asset.sourcePath;
  },
}));

vi.mock('@opendirector/core/stores/assetStore', () => ({
  useAssetStore: (selector: (state: typeof assetStoreState) => unknown) => selector(assetStoreState),
}));

vi.mock('@opendirector/core/stores/projectStore', () => ({
  useProjectStore: (selector: (state: typeof projectStoreState) => unknown) => selector(projectStoreState),
}));

vi.mock('./SourceTabs', () => ({
  SourceTabs: () => null,
}));

vi.mock('./FileCategoryTabs', () => ({
  FileCategoryTabs: () => null,
}));

vi.mock('./OriginalPanel', () => ({
  OriginalPanel: () => null,
}));

vi.mock('./GeneratedPanel', () => ({
  GeneratedPanel: () => null,
}));

vi.mock('./SearchBar', () => ({
  SearchBar: ({ onImportClick }: { onImportClick?: () => void }) => (
    <button data-testid="import-button" onClick={onImportClick}>import</button>
  ),
}));

vi.mock('../common/Modal', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => (
    isOpen ? <div>{children}</div> : null
  ),
}));

vi.mock('../common/Button', () => ({
  Button: ({ onClick, children }: { onClick?: () => void; children: ReactNode }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { AssetPanel } from './AssetPanel';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe('AssetPanel import completion', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    getPlatformAdapterMock.mockReset();
    importMultipleAssetsMock.mockReset();
    completeImportedAssetMock.mockReset();
    addAssetMock.mockReset();
    updateAssetMock.mockReset();

    assetStoreState.assets = [];
    assetStoreState.getAssetBySourcePath.mockReset();
    assetStoreState.getAssetBySourcePath.mockReturnValue(null);

    getPlatformAdapterMock.mockResolvedValue({
      fs: {
        selectFile: vi.fn().mockResolvedValue('/imports/video.mp4'),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('adds imported assets immediately and completes them once in the background', async () => {
    const importedAsset: Asset = {
      id: 'asset-1',
      name: 'video.mp4',
      type: 'video',
      source: 'original',
      url: 'asset:///project/Assets/Video/asset-1.mp4',
      relativePath: 'Assets/Video/asset-1.mp4',
      sourcePath: '/imports/video.mp4',
      fileSize: 1024,
      mimeType: 'video/mp4',
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: new Date('2026-04-30T00:00:00.000Z'),
      updatedAt: new Date('2026-04-30T00:00:00.000Z'),
    };
    const completedAsset: Asset = {
      ...importedAsset,
      duration: 3000,
      thumbnailUrl: 'asset:///project/Thumbnails/asset-1.jpg',
    };
    const completion = createDeferred<Asset>();
    const onImport = vi.fn();
    const callbackReturnValues: unknown[] = [];

    completeImportedAssetMock.mockReturnValue(completion.promise);
    importMultipleAssetsMock.mockImplementation(async (_paths, _fs, options) => {
      const result = {
        asset: importedAsset,
        originalPath: '/imports/video.mp4',
      };
      callbackReturnValues.push(options.onAssetImported?.(result));
      return [result];
    });

    await act(async () => {
      root.render(<AssetPanel onImport={onImport} />);
    });

    const importButton = container.querySelector('[data-testid="import-button"]');
    expect(importButton).not.toBeNull();

    await act(async () => {
      importButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(importMultipleAssetsMock).toHaveBeenCalledWith(
      ['/imports/video.mp4'],
      expect.any(Object),
      expect.objectContaining({
        projectPath: '/project',
        copyToProject: true,
        onAssetImported: expect.any(Function),
      }),
    );
    expect(callbackReturnValues).toEqual([undefined]);
    expect(addAssetMock).toHaveBeenCalledWith(importedAsset);
    expect(completeImportedAssetMock).toHaveBeenCalledTimes(1);
    expect(completeImportedAssetMock).toHaveBeenCalledWith(
      importedAsset,
      '/project/Assets/Video/asset-1.mp4',
      expect.any(Object),
      '/project',
    );
    expect(updateAssetMock).not.toHaveBeenCalled();
    expect(onImport).toHaveBeenCalledWith([
      {
        asset: importedAsset,
        originalPath: '/imports/video.mp4',
      },
    ]);

    await act(async () => {
      completion.resolve(completedAsset);
      await Promise.resolve();
    });

    expect(updateAssetMock).toHaveBeenCalledWith('asset-1', {
      duration: 3000,
      thumbnailUrl: 'asset:///project/Thumbnails/asset-1.jpg',
    });
  });
});
