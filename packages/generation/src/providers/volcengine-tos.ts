import type {
  AssetGroup,
  AssetGroupListResult,
  AssetItem,
  AssetListResult,
} from '@opendirector/core/types/ai-video';
import type { AssetProvider, FileUploadResult } from '@opendirector/core/types/asset-provider';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';

/**
 * VolcengineTosAssetProvider — cloud asset management via Volcengine TOS + Ark Asset API.
 */
export class VolcengineTosAssetProvider implements AssetProvider {
  id: string;
  name = 'Volcengine TOS';
  private password = '';
  private projectName = 'default';

  /**
   * @param instanceId — the runtime instance ID (e.g. 'volcengine-tos-1')
   */
  constructor(instanceId: string) {
    this.id = instanceId;
  }

  /** Set the master password used to decrypt provider credentials */
  setPassword(password: string): void {
    this.password = password;
  }

  /** Set the project name for API calls */
  setProjectName(name: string): void {
    this.projectName = name || 'default';
  }

  private requirePassword(): string {
    if (!this.password) throw new Error('Provider password not set. Call setPassword() first.');
    return this.password;
  }

  // ── Asset Groups ──

  listGroups(): Promise<AssetGroupListResult> {
    return tauriBridge.seedanceApi.listAssetGroups(this.id, this.requirePassword(), this.projectName);
  }

  createGroup(name: string, description?: string): Promise<AssetGroup> {
    return tauriBridge.seedanceApi.createAssetGroup(
      this.id,
      this.requirePassword(),
      name,
      description,
      undefined,
      this.projectName,
    );
  }

  // ── Assets ──

  listAssets(groupId: string, assetType?: string): Promise<AssetListResult> {
    return tauriBridge.seedanceApi.listAssets(
      this.id,
      this.requirePassword(),
      groupId,
      assetType,
      this.projectName,
    );
  }

  getAsset(assetId: string): Promise<AssetItem> {
    return tauriBridge.seedanceApi.getAsset(this.id, this.requirePassword(), assetId, this.projectName);
  }

  deleteAsset(assetId: string): Promise<void> {
    return tauriBridge.seedanceApi.deleteAsset(this.id, this.requirePassword(), assetId, this.projectName);
  }

  // ── Local file upload (direct to TOS, no base64 round-trip) ──

  uploadLocalFile(filePath: string): Promise<FileUploadResult> {
    return tauriBridge.tosApi.uploadLocalFile(this.id, this.requirePassword(), filePath);
  }
}
