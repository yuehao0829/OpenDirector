/**
 * AssetProvider — interface for cloud asset management providers.
 * Handles asset group CRUD, asset upload/CRUD, and TOS direct upload.
 */
import type {
  AssetGroup,
  AssetGroupListResult,
  AssetItem,
  AssetListResult,
} from './ai-video';

export interface FileUploadResult {
  objectKey: string;
  url: string;
  presignedUrl: string;
  expiresAt: string;
  fileSize: number;
  contentType: string;
}

export interface AssetProvider {
  id: string;
  name: string;

  // ── Asset Groups ──

  listGroups(): Promise<AssetGroupListResult>;
  createGroup(name: string, description?: string): Promise<AssetGroup>;

  // ── Assets ──

  listAssets(groupId: string, assetType?: string): Promise<AssetListResult>;
  getAsset(assetId: string): Promise<AssetItem>;
  deleteAsset(assetId: string): Promise<void>;

  // ── Local file upload (direct to storage, no base64 round-trip) ──

  uploadLocalFile(filePath: string): Promise<FileUploadResult>;
}
