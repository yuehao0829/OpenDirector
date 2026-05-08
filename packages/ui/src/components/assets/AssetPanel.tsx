/**
 * Asset Panel Component
 *
 * Main panel container for asset management with Original/Generated tabs
 */

import { useCallback, useState } from 'react';
import { getPlatformAdapter } from '@opendirector/core/adapters';
import {
  completeImportedAsset,
  importMultipleAssets,
  resolveImportedAssetAbsolutePath,
  type ImportResult,
} from '@opendirector/core/services/asset-import';
import type { Asset } from '@opendirector/core/types';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useTranslation } from 'react-i18next';
import { SourceTabs } from './SourceTabs';
import { FileCategoryTabs } from './FileCategoryTabs';
import { SearchBar } from './SearchBar';
import { OriginalPanel } from './OriginalPanel';
import { GeneratedPanel } from './GeneratedPanel';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';

interface AssetPanelProps {
  onImport?: (results: ImportResult[]) => void;
}

const IMPORT_COMPLETION_UPDATE_KEYS = [
  'duration',
  'width',
  'height',
  'fps',
  'audioChannels',
  'sampleRate',
  'mediaMetadataHydrated',
  'thumbnailUrl',
  'waveformDataPath',
] as const satisfies ReadonlyArray<keyof Asset>;

type ImportCompletionUpdateKey = (typeof IMPORT_COMPLETION_UPDATE_KEYS)[number];

function setImportedAssetCompletionUpdate<K extends ImportCompletionUpdateKey>(
  updates: Partial<Asset>,
  key: K,
  value: Asset[K],
): void {
  updates[key] = value;
}

function buildImportedAssetCompletionUpdates(
  originalAsset: Asset,
  completedAsset: Asset,
): Partial<Asset> {
  const updates: Partial<Asset> = {};

  for (const key of IMPORT_COMPLETION_UPDATE_KEYS) {
    if (!Object.is(originalAsset[key], completedAsset[key])) {
      setImportedAssetCompletionUpdate(updates, key, completedAsset[key]);
    }
  }

  return updates;
}

export function AssetPanel({ onImport }: AssetPanelProps) {
  const { t } = useTranslation();
  const [showProjectDialog, setShowProjectDialog] = useState(false);

  const source = useAssetStore((s) => s.source);
  const fileCategory = useAssetStore((s) => s.fileCategory);
  const searchQuery = useAssetStore((s) => s.searchQuery);
  const showUploadedOnly = useAssetStore((s) => s.showUploadedOnly);
  const hasUploadedAssets = useAssetStore((s) => s.assets.some((a) => a.remoteAssetStatus === 'Active'));

  const setSource = useAssetStore((s) => s.setSource);
  const setFileCategory = useAssetStore((s) => s.setFileCategory);
  const setSearchQuery = useAssetStore((s) => s.setSearchQuery);
  const setShowUploadedOnly = useAssetStore((s) => s.setShowUploadedOnly);
  const addAsset = useAssetStore((s) => s.addAsset);
  const updateAsset = useAssetStore((s) => s.updateAsset);
  const getAssetBySourcePath = useAssetStore((s) => s.getAssetBySourcePath);

  const currentProject = useProjectStore((s) => s.currentProject);
  const createProject = useProjectStore((s) => s.createProject);
  const openProjectDialog = useProjectStore((s) => s.openProjectDialog);
  const saveProject = useProjectStore((s) => s.saveProject);

  const handleImportClick = useCallback(async () => {
    const adapter = await getPlatformAdapter();
    if (!adapter.fs) {
      console.error('File import is only available in the desktop shell.');
      return;
    }

    if (!currentProject?.folderPath) {
      setShowProjectDialog(true);
      return;
    }

    try {
      const selectedPaths = await adapter.fs.selectFile({
        multiple: true,
        filters: [
          { name: t('common.fileFilters.mediaFiles'), extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'] },
          { name: t('common.video'), extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'] },
          { name: t('common.image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
          { name: t('common.audio'), extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'] },
        ],
      });
      if (!selectedPaths) return;

      const pathList = Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths];
      const fs = adapter.fs;
      const projectPath = currentProject.folderPath;
      const seenSourcePaths = new Set<string>();
      const pendingImports = pathList.filter((sourcePath) => {
        const normalizedSourcePath = sourcePath.replace(/\\/g, '/');
        if (seenSourcePaths.has(normalizedSourcePath) || getAssetBySourcePath(sourcePath)) {
          console.warn(`Asset already imported, skipping: ${sourcePath}`);
          return false;
        }
        seenSourcePaths.add(normalizedSourcePath);
        return true;
      });
      if (pendingImports.length === 0) return;

      const allResults = await importMultipleAssets(
        pendingImports,
        fs,
        {
          projectPath,
          copyToProject: true,
          onAssetImported: (result) => {
            addAsset(result.asset);
            const assetAbsolutePath = resolveImportedAssetAbsolutePath(result.asset, projectPath);
            if (!assetAbsolutePath) {
              return;
            }

            void (async () => {
              const completedAsset = await completeImportedAsset(
                result.asset,
                assetAbsolutePath,
                fs,
                projectPath,
              );
              const updates = buildImportedAssetCompletionUpdates(result.asset, completedAsset);

              if (Object.keys(updates).length > 0) {
                updateAsset(result.asset.id, updates);
              }
            })().catch((error) => {
              console.warn(`Failed to complete imported asset ${result.asset.id}:`, error);
            });
          },
        },
      );

      onImport?.(allResults);
    } catch (error) {
      console.error('Import failed:', error);
    }
  }, [currentProject?.folderPath, addAsset, getAssetBySourcePath, onImport, t, updateAsset]);

  const handleCreateProject = useCallback(async () => {
    await createProject(t('titleBar.untitledProject'));
    setShowProjectDialog(false);
    // Prompt save-as so the project gets a folderPath on disk
    await saveProject();
  }, [createProject, saveProject, t]);

  const handleOpenProject = useCallback(async () => {
    try {
      await openProjectDialog();
      setShowProjectDialog(false);
    } catch (error) {
      console.error(`${t('app.menu.openProjectFailed')}:`, error);
    }
  }, [openProjectDialog, t]);

  return (
    <div className="h-full flex flex-col bg-zinc-900" data-testid="asset-panel">
      {/* Source Tabs */}
      <SourceTabs source={source} onSourceChange={setSource} />

      {/* Search Bar */}
      <SearchBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onImportClick={source === 'original' ? handleImportClick : undefined}
        placeholder={
          source === 'original'
            ? t('assetPanel.search.originalPlaceholder')
            : t('assetPanel.search.generatedPlaceholder')
        }
      />

      {/* File Category Tabs */}
      <FileCategoryTabs
        category={fileCategory}
        onCategoryChange={setFileCategory}
        showUploadedOnly={showUploadedOnly}
        onShowUploadedOnlyChange={setShowUploadedOnly}
        hasUploadedAssets={hasUploadedAssets}
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {source === 'original' ? (
          <OriginalPanel />
        ) : (
          <GeneratedPanel />
        )}
      </div>

      {/* Project guidance dialog */}
      <Modal
        isOpen={showProjectDialog}
        onClose={() => setShowProjectDialog(false)}
        title={t('assetPanel.importDialog.title')}
      >
        <p className="text-sm text-zinc-400 mb-6">
          {t('assetPanel.importDialog.description')}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setShowProjectDialog(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="ghost" onClick={handleOpenProject}>
            {t('app.menu.openProject')}
          </Button>
          <Button variant="primary" onClick={handleCreateProject}>
            {t('app.menu.newProject')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
