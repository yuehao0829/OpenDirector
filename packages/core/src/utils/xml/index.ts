/**
 * XML Utilities
 *
 * Provides XML parsing and serialization for project files
 */

// Core types
export type {
  XmlAttribute,
  XmlNode,
  XmlElement,
  XmlParseOptions,
  XmlSerializeOptions,
  XmlSerializable,
  CoercedValue,
  ElementDescriptor,
} from './types';

// Parser
export {
  parseXml,
  getElementText,
  getAttribute,
  getChildElement,
  getChildElements,
  coerceValue,
  parseElementToObject,
} from './parser';

// Serializer
export {
  serializeXml,
  escapeXml,
  escapeXmlAttribute,
  createElement,
  textElement,
  attrElement,
  XmlElementBuilder,
} from './serializer';

// Project file (Project.odp)
export {
  serializeProjectFile,
  parseProjectFile,
  type ProjectFile,
  type ProjectResource,
  type AssetResourceSource,
} from './project-xml';

// Timeline file (Timeline.xml)
export {
  serializeTimelineFile,
  parseTimelineFile,
  toPersistableStatus,
  type TimelineFile,
  type TimelineTrack,
  type TimelineScene,
  type TimelineFragment,
  type FragmentStatus,
  type FragmentReference,
} from './timeline-xml';

// Settings files
export {
  serializeProjectSettings,
  parseProjectSettings,
  serializeLocalSettings,
  parseLocalSettings,
  type ProjectSettingsFile,
  type VideoSettings,
  type GenerationSettings,
  type ProjectMetadata,
  type LocalSettingsFile,
  type UISettings,
  type CacheSettings,
  type RecentSettings,
} from './settings-xml';

// Generations file (Generations.xml)
export {
  serializeGenerationsFile,
  parseGenerationsFile,
  recordToGeneration,
  generationToRecord,
  type GenerationsFile,
  type GenerationRecord,
  type GenerationProviderParams,
  type GenerationResultInfo,
} from './generations-xml';

// Assets file (Assets.xml)
export {
  serializeAssetsFile,
  parseAssetsFile,
  assetToRecord,
  type AssetsFile,
  type AssetRecord,
} from './assets-xml';

// XMEML (FCP7 XML Interchange Format)
export {
  serializeToXmeml,
  parseXmeml,
  type XmemlRate,
  type XmemlExportOptions,
  type XmemlExportAsset,
  type XmemlExportFragment,
  type XmemlExportScene,
  type XmemlImportResult,
  type XmemlImportAsset,
  type XmemlImportTrack,
  type XmemlImportFragment,
} from './xmeml-serializer';
