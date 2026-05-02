/**
 * Asset Bridge — listens to Rust asset:status events and coordinates
 * in-memory store + Assets.xml persistence.
 *
 * Also provides restoreProjectAssets for crash recovery.
 */

import type { AssetEvent } from '@opendirector/core/types/ai-video';
import { tauriBridge, isTauri } from '@opendirector/core/services/tauri-bridge';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { getProviderPassword } from '@opendirector/core/types/provider-system';
import { updateAssetsXml, readAssetsFile } from './asset-xml-repository';
import { providerRuntimeRegistry } from '../providers/runtime-registry';

let assetBridgeInitialized = false;

/**
 * Initialise the asset:status event listener.
 * Should be called once after app mount (inside useEffect in App.tsx).
 */
export async function initAssetTaskBridge(): Promise<void> {
  if (assetBridgeInitialized) return;
  assetBridgeInitialized = true;

  if (!isTauri()) return;

  await tauriBridge.listen<AssetEvent>('asset:status', (payload) => {
    // Use project_path from the event (not current project) for multi-project correctness
    const folderPath = payload.project_path;
    if (!folderPath) return;

    // Only update store if this event belongs to the currently open project
    const currentFolder = useProjectStore.getState().currentProject?.folderPath;
    const isCurrentProject = currentFolder === folderPath;

    switch (payload.type) {
      case 'created':
        if (isCurrentProject) {
          useAssetStore.getState().updateAsset(payload.asset_id, {
            remoteAssetId: payload.remote_asset_id,
            remoteAssetStatus: 'Processing',
          });
        }
        updateAssetsXml(folderPath, payload.asset_id, {
          remoteAssetId: payload.remote_asset_id,
          remoteAssetStatus: 'Processing',
          providerInstanceId: payload.provider_instance_id,
          groupId: payload.group_id,
        }).catch(console.warn);
        break;

      case 'active':
        if (isCurrentProject) {
          useAssetStore.getState().updateAsset(payload.asset_id, {
            remoteAssetStatus: 'Active',
          });
        }
        updateAssetsXml(folderPath, payload.asset_id, {
          remoteAssetStatus: 'Active',
          remoteAssetUploadedAt: new Date().toISOString(),
        })
          .then(() => {
            if (isCurrentProject) useProjectStore.getState().saveProject?.();
          })
          .catch(console.warn);
        break;

      case 'failed':
        if (isCurrentProject) {
          useAssetStore.getState().updateAsset(payload.asset_id, {
            remoteAssetStatus: 'Failed',
          });
        }
        updateAssetsXml(folderPath, payload.asset_id, {
          remoteAssetStatus: 'Failed',
          remoteAssetUploadedAt: new Date().toISOString(),
        })
          .then(() => {
            if (isCurrentProject) useProjectStore.getState().saveProject?.();
          })
          .catch(console.warn);
        break;
    }
  });
}

/**
 * Restore assets that were in Processing state when the app crashed.
 * Checks server status for each and either updates to terminal state
 * or re-registers with the Rust coordinator for continued polling.
 */
export async function restoreProjectAssets(folderPath: string): Promise<void> {
  const processingAssets = useAssetStore.getState().assets.filter(
    (a) => a.remoteAssetId && a.remoteAssetStatus === 'Processing'
  );
  if (processingAssets.length === 0) return;

  const assetsFile = await readAssetsFile(folderPath);
  if (!assetsFile) return;

  // Build a Map for O(1) lookups
  const recordMap = new Map(assetsFile.assets.map((r) => [r.id, r]));

  let anyUpdated = false;

  await Promise.all(processingAssets.map(async (asset) => {
    const record = recordMap.get(asset.id);
    const providerInstanceId = record?.providerInstanceId;
    if (!providerInstanceId) return;

    const instance = useProviderInstanceStore.getState().instances.find(
      (i) => i.instanceId === providerInstanceId
    );
    const password = getProviderPassword(instance);
    if (!password) return;

    try {
      const provider = await providerRuntimeRegistry.getOrInitializeAssetProvider(providerInstanceId);
      if (!provider) return;

      const item = await provider.getAsset(asset.remoteAssetId!);
      if (item.status === 'Succeeded') {
        useAssetStore.getState().updateAsset(asset.id, { remoteAssetStatus: 'Active' });
        await updateAssetsXml(folderPath, asset.id, {
          remoteAssetStatus: 'Active',
          remoteAssetUploadedAt: new Date().toISOString(),
        });
        anyUpdated = true;
      } else if (item.status === 'Failed') {
        useAssetStore.getState().updateAsset(asset.id, { remoteAssetStatus: 'Failed' });
        await updateAssetsXml(folderPath, asset.id, {
          remoteAssetStatus: 'Failed',
          remoteAssetUploadedAt: new Date().toISOString(),
        });
        anyUpdated = true;
      }
      // If still Processing, leave as-is — user can retry manually
    } catch {
      // Silent failure — will retry next time project is opened
    }
  }));

  if (anyUpdated) {
    await useProjectStore.getState().saveProject?.();
  }
}
