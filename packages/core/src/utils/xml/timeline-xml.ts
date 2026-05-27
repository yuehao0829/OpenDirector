/**
 * Timeline.xml XML Serializer
 *
 * Handles serialization and parsing of the timeline data file
 */

import type { XmlElement } from './types';
import type { GenerationParamDefaults } from '../../types/generation';
import type { CropRect, TrimRange } from '../../types/asset';
import { parseXml, getChildElements, getChildElement, getElementText } from './parser';
import { serializeXml, createElement, textElement } from './serializer';

// Types for timeline file structure
export interface TimelineFile {
  duration: number;
  updatedAt: Date;
  tracks: TimelineTrack[];
  scenes: TimelineScene[];
  fragments: TimelineFragment[];
}

export interface TimelineTrack {
  id: string;
  type: 'video' | 'audio';
  name: string;
  order: number;
  muted: boolean;
  locked: boolean;
}

export interface TimelineScene {
  id: string;
  name: string;
  start: number;  // milliseconds
  duration: number;  // milliseconds
  referenceRefs: string[];
}

export interface TimelineFragment {
  id: string;
  trackRef: string;
  sceneRef?: string;
  start: number;  // milliseconds
  duration: number;  // milliseconds
  status: FragmentStatus;
  prompt: string;
  references: FragmentReference[];
  sourceAssetRef?: string;
  resultAssetRef?: string;
  trimStart?: number;
  muted?: boolean;
  linkedAudioFragmentRef?: string;
  providerInstanceId?: string;
  providerModelId?: string;
  genParams?: GenerationParamDefaults;
}

export type FragmentStatus = 'draft' | 'generating' | 'completed' | 'failed';

/** Map transient runtime statuses to their persistable equivalent.
 *  'generating' is a runtime-only state — it should never be written to disk. */
export function toPersistableStatus(status: FragmentStatus): 'draft' | 'completed' | 'failed' {
  return status === 'generating' ? 'draft' : status;
}

export interface FragmentReference {
  assetRef: string;
  type: 'video' | 'image' | 'audio';
  weight: number;
  role?: string;
  cropRect?: CropRect;
  trimRange?: TrimRange;
}

/**
 * Serialize TimelineFile to XML string
 */
export function serializeTimelineFile(timeline: TimelineFile): string {
  const rootElement = createElement('timeline', {
    duration: timeline.duration,
    updatedAt: timeline.updatedAt.toISOString(),
  });

  // Tracks section
  const tracksElement = createElement('tracks');
  for (const track of timeline.tracks) {
    tracksElement.child(createTrackElement(track));
  }
  rootElement.children(tracksElement.build());

  // Scenes section
  const scenesElement = createElement('scenes');
  for (const scene of timeline.scenes) {
    scenesElement.child(createSceneElement(scene));
  }
  rootElement.children(scenesElement.build());

  // Fragments section
  const fragmentsElement = createElement('fragments');
  for (const fragment of timeline.fragments) {
    fragmentsElement.child(createFragmentElement(fragment));
  }
  rootElement.children(fragmentsElement.build());

  return serializeXml(rootElement.build());
}

/**
 * Create XML element for a track
 */
function createTrackElement(track: TimelineTrack): XmlElement {
  return createElement('track', {
    id: track.id,
    type: track.type,
    name: track.name,
    order: track.order,
    muted: track.muted,
    locked: track.locked,
  }).build();
}

/**
 * Create XML element for a scene
 */
function createSceneElement(scene: TimelineScene): XmlElement {
  const sceneElement = createElement('scene', {
    id: scene.id,
    name: scene.name,
    start: scene.start,
    duration: scene.duration,
  });

  // Reference refs
  const refsElement = createElement('referenceRefs');
  for (const ref of scene.referenceRefs) {
    refsElement.child(textElement('ref', ref));
  }
  sceneElement.children(refsElement.build());

  return sceneElement.build();
}

/**
 * Create XML element for a fragment
 */
function createFragmentElement(fragment: TimelineFragment): XmlElement {
  const attrs: Record<string, string | number | boolean> = {
    id: fragment.id,
    trackRef: fragment.trackRef,
    start: fragment.start,
    duration: fragment.duration,
    status: toPersistableStatus(fragment.status),
    prompt: fragment.prompt,
  };

  if (fragment.sceneRef) {
    attrs.sceneRef = fragment.sceneRef;
  }

  if (fragment.sourceAssetRef) {
    attrs.sourceAssetRef = fragment.sourceAssetRef;
  }

  if (fragment.trimStart !== undefined && fragment.trimStart > 0) {
    attrs.trimStart = fragment.trimStart;
  }

  if (fragment.muted) {
    attrs.muted = fragment.muted;
  }

  if (fragment.linkedAudioFragmentRef) {
    attrs.linkedAudioFragmentRef = fragment.linkedAudioFragmentRef;
  }

  if (fragment.providerInstanceId) {
    attrs.providerInstanceId = fragment.providerInstanceId;
  }

  if (fragment.providerModelId) {
    attrs.providerModelId = fragment.providerModelId;
  }

  const fragmentElement = createElement('fragment', attrs);

  // References
  if (fragment.references.length > 0) {
    const refsElement = createElement('references');
    for (const ref of fragment.references) {
      refsElement.child(createReferenceElement(ref));
    }
    fragmentElement.children(refsElement.build());
  }

  // Result
  if (fragment.resultAssetRef) {
    fragmentElement.child(
      createElement('result', { assetRef: fragment.resultAssetRef }).build()
    );
  }

  // GenParams
  if (fragment.genParams) {
    const gp = fragment.genParams;
    fragmentElement.child(
      createElement('genParams', {
        resolution: gp.resolution,
        aspectRatio: gp.aspectRatio,
        enableAudio: gp.enableAudio,
        enableMusic: gp.enableMusic,
        enableSubtitle: gp.enableSubtitle,
        enableWatermark: gp.enableWatermark,
        enableWebSearch: gp.enableWebSearch,
      }).build()
    );
  }

  return fragmentElement.build();
}

/**
 * Create XML element for a reference
 */
function createReferenceElement(ref: FragmentReference): XmlElement {
  const attrs: Record<string, string | number | boolean> = {
    assetRef: ref.assetRef,
    type: ref.type,
    weight: ref.weight,
  };
  if (ref.role) {
    attrs.role = ref.role;
  }
  if (ref.cropRect) {
    attrs.cropX = ref.cropRect.x;
    attrs.cropY = ref.cropRect.y;
    attrs.cropW = ref.cropRect.width;
    attrs.cropH = ref.cropRect.height;
  }
  if (ref.trimRange) {
    attrs.trimStartMs = ref.trimRange.startMs;
    attrs.trimEndMs = ref.trimRange.endMs;
  }
  return createElement('reference', attrs).build();
}

/**
 * Parse Timeline.xml string to TimelineFile
 */
export function parseTimelineFile(xml: string): TimelineFile {
  const root = parseXml(xml);

  if (root.tagName !== 'timeline') {
    throw new Error(`Invalid timeline file: expected root element 'timeline', got '${root.tagName}'`);
  }

  const duration = parseInt(root.attributes.duration, 10) || 0;
  const updatedAt = new Date(root.attributes.updatedAt || new Date());

  // Parse tracks
  const tracks: TimelineTrack[] = [];
  const tracksElement = getChildElement(root, 'tracks');
  if (tracksElement) {
    for (const trackEl of getChildElements(tracksElement, 'track')) {
      tracks.push(parseTrackElement(trackEl));
    }
  }

  // Parse scenes
  const scenes: TimelineScene[] = [];
  const scenesElement = getChildElement(root, 'scenes');
  if (scenesElement) {
    for (const sceneEl of getChildElements(scenesElement, 'scene')) {
      scenes.push(parseSceneElement(sceneEl));
    }
  }

  // Parse fragments
  const fragments: TimelineFragment[] = [];
  const fragmentsElement = getChildElement(root, 'fragments');
  if (fragmentsElement) {
    for (const fragEl of getChildElements(fragmentsElement, 'fragment')) {
      fragments.push(parseFragmentElement(fragEl));
    }
  }

  return {
    duration,
    updatedAt,
    tracks,
    scenes,
    fragments,
  };
}

/**
 * Parse track element
 */
function parseTrackElement(element: XmlElement): TimelineTrack {
  return {
    id: element.attributes.id,
    type: element.attributes.type as 'video' | 'audio',
    name: element.attributes.name,
    order: parseInt(element.attributes.order, 10) || 0,
    muted: element.attributes.muted === 'true',
    locked: element.attributes.locked === 'true',
  };
}

/**
 * Parse scene element
 */
function parseSceneElement(element: XmlElement): TimelineScene {
  const referenceRefs: string[] = [];
  const refsElement = getChildElement(element, 'referenceRefs');
  if (refsElement) {
    for (const refEl of getChildElements(refsElement, 'ref')) {
      const refText = getElementText(refEl);
      if (refText) {
        referenceRefs.push(refText);
      }
    }
  }

  return {
    id: element.attributes.id,
    name: element.attributes.name,
    start: parseInt(element.attributes.start, 10) || 0,
    duration: parseInt(element.attributes.duration, 10) || 0,
    referenceRefs,
  };
}

/**
 * Parse fragment element
 */
function parseFragmentElement(element: XmlElement): TimelineFragment {
  const references: FragmentReference[] = [];
  const refsElement = getChildElement(element, 'references');
  if (refsElement) {
    for (const refEl of getChildElements(refsElement, 'reference')) {
      const ref: FragmentReference = {
        assetRef: refEl.attributes.assetRef,
        type: refEl.attributes.type as 'video' | 'image' | 'audio',
        weight: parseFloat(refEl.attributes.weight) || 0.5,
        role: refEl.attributes.role || undefined,
      };
      // Parse cropRect if present
      if (refEl.attributes.cropX !== undefined) {
        ref.cropRect = {
          x: parseFloat(refEl.attributes.cropX) || 0,
          y: parseFloat(refEl.attributes.cropY) || 0,
          width: parseFloat(refEl.attributes.cropW) || 1,
          height: parseFloat(refEl.attributes.cropH) || 1,
        };
      }
      // Parse trimRange if present
      if (refEl.attributes.trimStartMs !== undefined) {
        ref.trimRange = {
          startMs: parseInt(refEl.attributes.trimStartMs, 10) || 0,
          endMs: parseInt(refEl.attributes.trimEndMs, 10) || 0,
        };
      }
      references.push(ref);
    }
  }

  // Result asset ref
  let resultAssetRef: string | undefined;
  const resultElement = getChildElement(element, 'result');
  if (resultElement) {
    resultAssetRef = resultElement.attributes.assetRef;
  }

  // GenParams
  let genParams: TimelineFragment['genParams'];
  const genParamsElement = getChildElement(element, 'genParams');
  if (genParamsElement) {
    genParams = {
      resolution: genParamsElement.attributes.resolution,
      aspectRatio: genParamsElement.attributes.aspectRatio,
      enableAudio: genParamsElement.attributes.enableAudio === 'true',
      enableMusic: genParamsElement.attributes.enableMusic === 'true',
      enableSubtitle: genParamsElement.attributes.enableSubtitle === 'true',
      enableWatermark: genParamsElement.attributes.enableWatermark === 'true',
      enableWebSearch: genParamsElement.attributes.enableWebSearch === 'true',
    };
  }

  return {
    id: element.attributes.id,
    trackRef: element.attributes.trackRef,
    sceneRef: element.attributes.sceneRef,
    start: parseInt(element.attributes.start, 10) || 0,
    duration: parseInt(element.attributes.duration, 10) || 0,
    status: element.attributes.status as FragmentStatus,
    prompt: element.attributes.prompt || '',
    references,
    sourceAssetRef: element.attributes.sourceAssetRef,
    resultAssetRef,
    trimStart: element.attributes.trimStart ? parseInt(element.attributes.trimStart, 10) : undefined,
    muted: element.attributes.muted === 'true' ? true : undefined,
    linkedAudioFragmentRef: element.attributes.linkedAudioFragmentRef || undefined,
    providerInstanceId: element.attributes.providerInstanceId || undefined,
    providerModelId: element.attributes.providerModelId || undefined,
    genParams,
  };
}
