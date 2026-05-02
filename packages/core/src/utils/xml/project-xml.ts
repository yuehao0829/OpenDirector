/**
 * Project.odp XML Serializer
 *
 * Handles serialization and parsing of the main project file (Project.odp)
 */

import type { XmlElement } from './types';
import { parseXml, getChildElements, getChildElement, getElementText } from './parser';
import { serializeXml, createElement } from './serializer';

// Types for project file structure
export interface ProjectFile {
  version: string;
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  /** @deprecated Only used for migration from old format. New files store assets in Assets.xml. */
  resources?: ProjectResource[];
}

export interface ProjectResource {
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
  generationId?: string;
  remoteAssetId?: string;
  remoteAssetStatus?: string;
  tags: string[];
  createdAt: Date;
}

export type AssetResourceSource = 'original' | 'generated';

/**
 * Serialize ProjectFile to XML string
 * Note: <resources> is no longer written; assets are persisted in Assets.xml.
 */
export function serializeProjectFile(project: ProjectFile): string {
  const rootElement = createElement('project', {
    version: project.version,
    id: project.id,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });

  // No longer writing <resources> — assets live in Assets.xml

  return serializeXml(rootElement.build());
}

/**
 * Parse Project.odp XML string to ProjectFile
 * Maintains backward compatibility: if <resources> is present, parse it for migration.
 */
export function parseProjectFile(xml: string): ProjectFile {
  const root = parseXml(xml);

  if (root.tagName !== 'project') {
    throw new Error(`Invalid project file: expected root element 'project', got '${root.tagName}'`);
  }

  const version = root.attributes.version || '1.0';
  const id = root.attributes.id;
  const name = root.attributes.name;
  const createdAt = new Date(root.attributes.createdAt);
  const updatedAt = new Date(root.attributes.updatedAt);

  if (!id || !name) {
    throw new Error('Invalid project file: missing required attributes (id, name)');
  }

  // Parse resources (backward compatibility — old format includes <resources>)
  const resourcesElement = getChildElement(root, 'resources');
  const resources: ProjectResource[] | undefined = resourcesElement
    ? getChildElements(resourcesElement, 'asset').map((el) => parseAssetElement(el))
    : undefined;

  return {
    version,
    id,
    name,
    createdAt,
    updatedAt,
    ...(resources && resources.length > 0 ? { resources } : {}),
  };
}

/**
 * Parse asset element to ProjectResource
 */
function parseAssetElement(element: XmlElement): ProjectResource {
  const id = element.attributes.id;
  const type = element.attributes.type as 'video' | 'image' | 'audio';
  const source = (element.attributes.source || element.attributes.category) as AssetResourceSource;
  const name = element.attributes.name;
  const path = element.attributes.path;
  const fileSize = parseInt(element.attributes.fileSize, 10);
  const mimeType = element.attributes.mimeType;

  if (!id || !type || !source || !name || !path || !mimeType) {
    throw new Error('Invalid asset element: missing required attributes');
  }

  // Optional attributes
  const duration = element.attributes.duration ? parseInt(element.attributes.duration, 10) : undefined;
  const width = element.attributes.width ? parseInt(element.attributes.width, 10) : undefined;
  const height = element.attributes.height ? parseInt(element.attributes.height, 10) : undefined;
  const generationId = element.attributes.generationRef;
  const sourcePath = element.attributes.sourcePath;
  const remoteAssetId = element.attributes.remoteAssetId;
  const remoteAssetStatus = element.attributes.remoteAssetStatus;
  const createdAt = new Date(element.attributes.createdAt || new Date());

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
    generationId,
    sourcePath,
    remoteAssetId,
    remoteAssetStatus,
    tags,
    createdAt,
  };
}
