/**
 * Assets.xml XML Serializer
 *
 * Handles serialization and parsing of the asset data file.
 * Assets.xml is the single source of truth for asset records.
 */

import type { XmlElement } from './types';
import { parseXml, getChildElements, getChildElement, getElementText } from './parser';
import { serializeXml, createElement, textElement } from './serializer';
import type { AssetResourceSource } from './project-xml';
import type { Asset } from '../../types/asset';

// ─── Types ───

export interface AssetsFile {
  assets: AssetRecord[];
}

export interface AssetRecord {
  id: string;
  type: 'video' | 'image' | 'audio';
  source: AssetResourceSource;
  name: string;
  path: string;
  sourcePath?: string;
  fileSize: number;
  mimeType: string;
  duration?: number;
  width?: number;
  height?: number;
  audioChannels?: number;
  sampleRate?: number;
  mediaMetadataHydrated?: boolean;
  generationId?: string;
  remoteAssetId?: string;
  remoteAssetStatus?: 'Processing' | 'Active' | 'Failed';
  remoteAssetUploadedAt?: string;
  providerInstanceId?: string;
  groupId?: string;
  tags: string[];
  createdAt: string;
}

/** Convert an in-memory Asset to an AssetRecord for persistence. */
export function assetToRecord(asset: Asset): AssetRecord {
  return {
    id: asset.id,
    type: asset.type,
    source: asset.source as AssetResourceSource,
    name: asset.name,
    path: asset.relativePath ?? '',
    sourcePath: asset.sourcePath,
    fileSize: asset.fileSize,
    mimeType: asset.mimeType,
    duration: asset.duration,
    width: asset.width,
    height: asset.height,
    audioChannels: asset.audioChannels,
    sampleRate: asset.sampleRate,
    mediaMetadataHydrated: asset.mediaMetadataHydrated,
    generationId: asset.generationId,
    remoteAssetId: asset.remoteAssetId,
    remoteAssetStatus: asset.remoteAssetStatus,
    tags: asset.tags,
    createdAt: asset.createdAt.toISOString(),
  };
}

// ─── Serialization ───

export function serializeAssetsFile(file: AssetsFile): string {
  const rootElement = createElement('assets');

  for (const asset of file.assets) {
    rootElement.child(createAssetRecordElement(asset));
  }

  return serializeXml(rootElement.build());
}

function createAssetRecordElement(asset: AssetRecord): XmlElement {
  const attrs: Record<string, string | number | boolean> = {
    id: asset.id,
    type: asset.type,
    source: asset.source,
    name: asset.name,
    path: asset.path,
    fileSize: asset.fileSize,
    mimeType: asset.mimeType,
    createdAt: asset.createdAt,
  };

  if (asset.duration !== undefined) attrs.duration = asset.duration;
  if (asset.width !== undefined) attrs.width = asset.width;
  if (asset.height !== undefined) attrs.height = asset.height;
  if (asset.audioChannels !== undefined) attrs.audioChannels = asset.audioChannels;
  if (asset.sampleRate !== undefined) attrs.sampleRate = asset.sampleRate;
  if (asset.mediaMetadataHydrated === true) attrs.mediaMetadataHydrated = 'true';
  if (asset.generationId !== undefined) attrs.generationRef = asset.generationId;
  if (asset.sourcePath !== undefined) attrs.sourcePath = asset.sourcePath;
  if (asset.remoteAssetId !== undefined) attrs.remoteAssetId = asset.remoteAssetId;
  if (asset.remoteAssetStatus !== undefined) attrs.remoteAssetStatus = asset.remoteAssetStatus;
  if (asset.remoteAssetUploadedAt !== undefined) attrs.remoteAssetUploadedAt = asset.remoteAssetUploadedAt;
  if (asset.providerInstanceId !== undefined) attrs.providerInstanceId = asset.providerInstanceId;
  if (asset.groupId !== undefined) attrs.groupId = asset.groupId;

  const element = createElement('asset', attrs);

  // Tags
  if (asset.tags.length > 0) {
    const tagsElement = createElement('tags');
    for (const tag of asset.tags) {
      tagsElement.child(textElement('tag', tag));
    }
    element.children(tagsElement.build());
  }

  return element.build();
}

// ─── Parsing ───

export function parseAssetsFile(xml: string): AssetsFile {
  const root = parseXml(xml);

  if (root.tagName !== 'assets') {
    throw new Error(`Invalid assets file: expected root element 'assets', got '${root.tagName}'`);
  }

  const assets: AssetRecord[] = [];
  for (const assetEl of getChildElements(root, 'asset')) {
    assets.push(parseAssetRecordElement(assetEl));
  }

  return { assets };
}

function parseAssetRecordElement(element: XmlElement): AssetRecord {
  const id = element.attributes.id;
  const type = element.attributes.type as 'video' | 'image' | 'audio';
  const source = (element.attributes.source || element.attributes.category) as AssetResourceSource;
  const name = element.attributes.name;
  const path = element.attributes.path ?? '';
  const fileSize = parseInt(element.attributes.fileSize, 10);
  const mimeType = element.attributes.mimeType;

  if (!id || !type || !source || !name) {
    throw new Error('Invalid asset element: missing required attributes');
  }

  // Optional attributes
  const duration = element.attributes.duration !== undefined
    ? parseInt(element.attributes.duration, 10)
    : undefined;
  const width = element.attributes.width !== undefined
    ? parseInt(element.attributes.width, 10)
    : undefined;
  const height = element.attributes.height !== undefined
    ? parseInt(element.attributes.height, 10)
    : undefined;
  const audioChannels = element.attributes.audioChannels !== undefined
    ? parseInt(element.attributes.audioChannels, 10)
    : undefined;
  const sampleRate = element.attributes.sampleRate !== undefined
    ? parseInt(element.attributes.sampleRate, 10)
    : undefined;
  const mediaMetadataHydrated = element.attributes.mediaMetadataHydrated === 'true'
    ? true
    : undefined;
  const generationId = element.attributes.generationRef;
  const sourcePath = element.attributes.sourcePath;
  const remoteAssetId = element.attributes.remoteAssetId;
  const remoteAssetStatus = element.attributes.remoteAssetStatus as AssetRecord['remoteAssetStatus'] | undefined;
  const remoteAssetUploadedAt = element.attributes.remoteAssetUploadedAt;
  const providerInstanceId = element.attributes.providerInstanceId;
  const groupId = element.attributes.groupId;
  const createdAt = element.attributes.createdAt || new Date().toISOString();

  // Parse tags
  const tags: string[] = [];
  const tagsElement = getChildElement(element, 'tags');
  if (tagsElement) {
    const tagElements = getChildElements(tagsElement, 'tag');
    for (const tagEl of tagElements) {
      const tagText = getElementText(tagEl);
      if (tagText) {
        tags.push(tagText);
      }
    }
  }

  return {
    id,
    type,
    source,
    name,
    path,
    fileSize,
    mimeType,
    duration,
    width,
    height,
    audioChannels,
    sampleRate,
    mediaMetadataHydrated,
    generationId,
    sourcePath,
    remoteAssetId,
    remoteAssetStatus,
    remoteAssetUploadedAt,
    providerInstanceId,
    groupId,
    tags,
    createdAt,
  };
}
