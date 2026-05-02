/**
 * Original Panel Component
 *
 * Displays user-imported assets in a grid layout.
 * Asset selection triggers preview in PreviewPanel (not inline).
 * Asset upload is now handled by the Rust AssetTaskManager via tauriBridge.assetTaskApi.
 */

import { useState } from 'react';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import type { Asset } from '@opendirector/core/types/asset';
import { getProviderPassword, getUploadReadyProviders } from '@opendirector/core/types/provider-system';
import { toArkAssetType } from '@opendirector/core/utils/common';
import { AssetGrid } from './AssetGrid';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';

export function OriginalPanel() {
  const deleteAsset = useAssetStore((s) => s.deleteAsset);
  const filteredAssets = useAssetStore((s) => s.getFilteredAssets());

  // Get current selection state for toggle logic
  const secondaryFocus = useSelectionStore((s) => s.secondaryFocus);

  const [uploadConfirmAsset, setUploadConfirmAsset] = useState<Asset | null>(null);

  const handleAssetClick = (asset: Asset, e: React.MouseEvent) => {
    const store = useSelectionStore.getState();
    const isMultiSelect = e.metaKey || e.ctrlKey;
    const isShiftSelect = e.shiftKey;

    if (isShiftSelect && secondaryFocus?.type === 'asset' && secondaryFocus.assetIds.length > 0) {
      // Shift+click: range select from first selected asset to clicked asset
      const allAssetIds = filteredAssets.map((a) => a.id);
      const fromId = secondaryFocus.assetIds[0];
      store.selectAssetRange(fromId, asset.id, allAssetIds);
    } else if (isMultiSelect) {
      // CMD/Ctrl+click: toggle this asset in multi-selection
      store.selectAsset(asset.id, true);
    } else if (secondaryFocus?.type === 'asset' && secondaryFocus.assetIds.includes(asset.id) && secondaryFocus.assetIds.length === 1) {
      // Click on sole selected asset: deselect
      store.clearSecondaryFocus();
    } else {
      // Normal click: single select
      store.selectAsset(asset.id);
    }
  };

  const handleAssetUploadRequest = (asset: Asset) => {
    setUploadConfirmAsset(asset);
  };

  const handleConfirmUpload = () => {
    if (uploadConfirmAsset) {
      handleAssetUpload(uploadConfirmAsset);
    }
    setUploadConfirmAsset(null);
  };

  const handleCancelUpload = () => {
    setUploadConfirmAsset(null);
  };

  const handleAssetUpload = async (asset: Asset) => {
    const assetProviders = getUploadReadyProviders(
      useProviderInstanceStore.getState().instances
    );
    if (assetProviders.length === 0) return;

    const instance = assetProviders[0];
    const password = getProviderPassword(instance);
    if (!password) return;

    // Resolve local file path
    const project = useProjectStore.getState().currentProject;
    const localPath = (asset.relativePath && project?.folderPath ? `${project.folderPath}/${asset.relativePath}` : null) || asset.sourcePath;
    if (!localPath) return;

    const arkAssetType = toArkAssetType(asset.type);

    // Mark as Processing immediately
    useAssetStore.getState().updateAsset(asset.id, { remoteAssetStatus: 'Processing' });

    try {
      // Delegate to Rust AssetTaskManager (handles TOS upload, CreateAsset, and polling)
      await tauriBridge.assetTaskApi.startAssetUpload({
        asset_id: asset.id,
        provider_id: instance.instanceId,
        password,
        file_path: localPath,
        asset_type: arkAssetType,
        project_path: project?.folderPath ?? '',
      });
    } catch (err) {
      console.error('[OriginalPanel] Asset upload failed:', err);
      useAssetStore.getState().updateAsset(asset.id, { remoteAssetStatus: 'Failed' });
    }
  };

  return (
    <>
      <AssetGrid
        assets={filteredAssets}
        onAssetClick={handleAssetClick}
        onAssetDelete={(asset) => deleteAsset(asset.id)}
        onAssetUploadRequest={handleAssetUploadRequest}
      />
      <Modal
        isOpen={uploadConfirmAsset !== null}
        onClose={handleCancelUpload}
        title="上传确认"
        size="sm"
      >
        <p className="text-sm text-zinc-300 mb-3">
          您即将上传该资源至版权素材库，请确认上传内容符合以下要求：
        </p>
        <ul className="text-sm text-zinc-400 mb-6 space-y-1.5 list-disc list-inside">
          <li>不侵犯他人知识产权</li>
          <li>不包含政治敏感内容</li>
          <li>不包含色情或违法内容</li>
        </ul>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={handleCancelUpload}>取消</Button>
          <Button variant="primary" onClick={handleConfirmUpload}>确认上传</Button>
        </div>
      </Modal>
    </>
  );
}
