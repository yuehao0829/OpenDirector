/**
 * Settings XML Serializer
 *
 * Handles serialization and parsing of:
 * - ProjectSettings.xml (project-specific settings, travels with project)
 * - LocalSettings.xml (local preferences, stays on local machine)
 */

import { parseXml, getChildElements, getChildElement, getElementText } from './parser';
import { serializeXml, createElement, textElement } from './serializer';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_FPS, DEFAULT_PROVIDER, DEFAULT_ASPECT_RATIO } from '../../constants';

// Project Settings (travels with project)
export interface ProjectSettingsFile {
  video: VideoSettings;
  generation: GenerationSettings;
  metadata?: ProjectMetadata;
}

export interface VideoSettings {
  fps: number;
  resolution: { width: number; height: number };
  aspectRatio: string;
}

export interface GenerationSettings {
  defaultProvider: string;
  defaultDuration: number;
  defaultAspectRatio: string;
}

export interface ProjectMetadata {
  author?: string;
  description?: string;
  customFields?: Record<string, string>;
}

// Local Settings (stays on local machine)
export interface LocalSettingsFile {
  ui?: UISettings;
  cache?: CacheSettings;
  recent?: RecentSettings;
}

export interface UISettings {
  timelineZoom?: number;
  showThumbnails?: boolean;
  panelLayout?: string;
}

export interface CacheSettings {
  maxSizeGB?: number;
  autoClean?: boolean;
}

export interface RecentSettings {
  lastOpenedTab?: string;
  expandedPanels?: string[];
}

/**
 * Serialize ProjectSettingsFile to XML string
 */
export function serializeProjectSettings(settings: ProjectSettingsFile): string {
  const rootElement = createElement('projectSettings');

  // Video settings
  const videoElement = createElement('video');
  videoElement
    .child(textElement('fps', String(settings.video.fps)))
    .child(
      createElement('resolution', {
        width: settings.video.resolution.width,
        height: settings.video.resolution.height,
      }).build()
    )
    .child(textElement('aspectRatio', settings.video.aspectRatio));
  rootElement.children(videoElement.build());

  // Generation settings
  const genElement = createElement('generation');
  genElement
    .child(textElement('defaultProvider', settings.generation.defaultProvider))
    .child(textElement('defaultDuration', String(settings.generation.defaultDuration)))
    .child(textElement('defaultAspectRatio', settings.generation.defaultAspectRatio));
  rootElement.children(genElement.build());

  // Metadata (optional)
  if (settings.metadata) {
    const metaElement = createElement('metadata');
    if (settings.metadata.author) {
      metaElement.child(textElement('author', settings.metadata.author));
    }
    if (settings.metadata.description) {
      metaElement.child(textElement('description', settings.metadata.description));
    }
    if (settings.metadata.customFields) {
      const fieldsElement = createElement('customFields');
      for (const [key, value] of Object.entries(settings.metadata.customFields)) {
        fieldsElement.child(
          createElement('field', { key }).text(value).build()
        );
      }
      metaElement.children(fieldsElement.build());
    }
    rootElement.children(metaElement.build());
  }

  return serializeXml(rootElement.build());
}

/**
 * Parse ProjectSettings.xml string to ProjectSettingsFile
 */
export function parseProjectSettings(xml: string): ProjectSettingsFile {
  const root = parseXml(xml);

  if (root.tagName !== 'projectSettings') {
    throw new Error(`Invalid project settings file: expected root element 'projectSettings', got '${root.tagName}'`);
  }

  // Parse video settings
  const videoElement = getChildElement(root, 'video');
  const video: VideoSettings = {
    fps: DEFAULT_FPS,
    resolution: { ...DEFAULT_PROJECT_SETTINGS.resolution },
    aspectRatio: '16:9',
  };

  if (videoElement) {
    const fpsEl = getChildElement(videoElement, 'fps');
    if (fpsEl) video.fps = parseInt(getElementText(fpsEl) || String(DEFAULT_FPS), 10);

    const resEl = getChildElement(videoElement, 'resolution');
    if (resEl) {
      video.resolution.width = parseInt(resEl.attributes.width || String(DEFAULT_PROJECT_SETTINGS.resolution.width), 10);
      video.resolution.height = parseInt(resEl.attributes.height || String(DEFAULT_PROJECT_SETTINGS.resolution.height), 10);
    }

    const arEl = getChildElement(videoElement, 'aspectRatio');
    if (arEl) video.aspectRatio = getElementText(arEl) || '16:9';
  }

  // Parse generation settings
  const genElement = getChildElement(root, 'generation');
  const generation: GenerationSettings = {
    defaultProvider: DEFAULT_PROVIDER,
    defaultDuration: 5000,
    defaultAspectRatio: DEFAULT_ASPECT_RATIO,
  };

  if (genElement) {
    const providerEl = getChildElement(genElement, 'defaultProvider');
    if (providerEl) generation.defaultProvider = getElementText(providerEl) || DEFAULT_PROVIDER;

    const durationEl = getChildElement(genElement, 'defaultDuration');
    if (durationEl) generation.defaultDuration = parseInt(getElementText(durationEl) || '5000', 10);

    const arEl = getChildElement(genElement, 'defaultAspectRatio');
    if (arEl) generation.defaultAspectRatio = getElementText(arEl) || '16:9';
  }

  // Parse metadata (optional)
  let metadata: ProjectMetadata | undefined;
  const metaElement = getChildElement(root, 'metadata');
  if (metaElement) {
    metadata = {};

    const authorEl = getChildElement(metaElement, 'author');
    if (authorEl) metadata.author = getElementText(authorEl);

    const descEl = getChildElement(metaElement, 'description');
    if (descEl) metadata.description = getElementText(descEl);

    const fieldsElement = getChildElement(metaElement, 'customFields');
    if (fieldsElement) {
      metadata.customFields = {};
      for (const fieldEl of getChildElements(fieldsElement, 'field')) {
        const key = fieldEl.attributes.key;
        const value = getElementText(fieldEl);
        if (key && value) {
          metadata.customFields[key] = value;
        }
      }
    }
  }

  return { video, generation, metadata };
}

/**
 * Serialize LocalSettingsFile to XML string
 */
export function serializeLocalSettings(settings: LocalSettingsFile): string {
  const rootElement = createElement('localSettings');

  // UI settings
  if (settings.ui) {
    const uiElement = createElement('ui');
    if (settings.ui.timelineZoom !== undefined) {
      uiElement.child(textElement('timelineZoom', String(settings.ui.timelineZoom)));
    }
    if (settings.ui.showThumbnails !== undefined) {
      uiElement.child(textElement('showThumbnails', String(settings.ui.showThumbnails)));
    }
    if (settings.ui.panelLayout !== undefined) {
      uiElement.child(textElement('panelLayout', settings.ui.panelLayout));
    }
    rootElement.children(uiElement.build());
  }

  // Cache settings
  if (settings.cache) {
    const cacheElement = createElement('cache');
    if (settings.cache.maxSizeGB !== undefined) {
      cacheElement.child(textElement('maxSizeGB', String(settings.cache.maxSizeGB)));
    }
    if (settings.cache.autoClean !== undefined) {
      cacheElement.child(textElement('autoClean', String(settings.cache.autoClean)));
    }
    rootElement.children(cacheElement.build());
  }

  // Recent settings
  if (settings.recent) {
    const recentElement = createElement('recent');
    if (settings.recent.lastOpenedTab !== undefined) {
      recentElement.child(textElement('lastOpenedTab', settings.recent.lastOpenedTab));
    }
    if (settings.recent.expandedPanels && settings.recent.expandedPanels.length > 0) {
      const panelsElement = createElement('expandedPanels');
      for (const panel of settings.recent.expandedPanels) {
        panelsElement.child(textElement('panel', panel));
      }
      recentElement.children(panelsElement.build());
    }
    rootElement.children(recentElement.build());
  }

  return serializeXml(rootElement.build());
}

/**
 * Parse LocalSettings.xml string to LocalSettingsFile
 */
export function parseLocalSettings(xml: string): LocalSettingsFile {
  const root = parseXml(xml);

  if (root.tagName !== 'localSettings') {
    throw new Error(`Invalid local settings file: expected root element 'localSettings', got '${root.tagName}'`);
  }

  const settings: LocalSettingsFile = {};

  // Parse UI settings
  const uiElement = getChildElement(root, 'ui');
  if (uiElement) {
    settings.ui = {};

    const zoomEl = getChildElement(uiElement, 'timelineZoom');
    if (zoomEl) settings.ui.timelineZoom = parseFloat(getElementText(zoomEl) || '1.0');

    const thumbsEl = getChildElement(uiElement, 'showThumbnails');
    if (thumbsEl) settings.ui.showThumbnails = getElementText(thumbsEl) === 'true';

    const layoutEl = getChildElement(uiElement, 'panelLayout');
    if (layoutEl) settings.ui.panelLayout = getElementText(layoutEl);
  }

  // Parse cache settings
  const cacheElement = getChildElement(root, 'cache');
  if (cacheElement) {
    settings.cache = {};

    const sizeEl = getChildElement(cacheElement, 'maxSizeGB');
    if (sizeEl) settings.cache.maxSizeGB = parseInt(getElementText(sizeEl) || '10', 10);

    const cleanEl = getChildElement(cacheElement, 'autoClean');
    if (cleanEl) settings.cache.autoClean = getElementText(cleanEl) === 'true';
  }

  // Parse recent settings
  const recentElement = getChildElement(root, 'recent');
  if (recentElement) {
    settings.recent = {};

    const tabEl = getChildElement(recentElement, 'lastOpenedTab');
    if (tabEl) settings.recent.lastOpenedTab = getElementText(tabEl);

    const panelsElement = getChildElement(recentElement, 'expandedPanels');
    if (panelsElement) {
      settings.recent.expandedPanels = [];
      for (const panelEl of getChildElements(panelsElement, 'panel')) {
        const panelText = getElementText(panelEl);
        if (panelText) {
          settings.recent.expandedPanels.push(panelText);
        }
      }
    }
  }

  return settings;
}
