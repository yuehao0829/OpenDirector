/**
 * Generations.xml XML Serializer
 *
 * Handles serialization and parsing of the generations data file.
 * Generations.xml is the single source of truth for generation records.
 */

import type { XmlElement } from './types';
import { t } from '../../i18n';
import { parseXml, getChildElements, getChildElement, getElementText } from './parser';
import { serializeXml, createElement, textElement } from './serializer';
import type { GenerationReference, GenerationStatus } from '../../types/generation';
import type { Generation } from '../../types/generation';
import type { AssetType } from '../../types/persistence';

// Single schema table driving BOTH serialize and parse of providerParams.
// Every provider-param field declared on GenerationParams MUST appear here —
// adding a field here is the only change needed to make it round-trip.
const PROVIDER_PARAM_SCHEMA = [
  { key: 'model', type: 'string' },
  { key: 'modelName', type: 'string' },
  { key: 'duration', type: 'number' },
  { key: 'aspectRatio', type: 'string' },
  { key: 'resolution', type: 'string' },
  { key: 'generateAudio', type: 'boolean' },
  { key: 'generateWatermark', type: 'boolean' },
  { key: 'style', type: 'string' },
  { key: 'negativePrompt', type: 'string' },
  { key: 'imageSize', type: 'string' },
  { key: 'imageQuality', type: 'string' },
  { key: 'imageOutputFormat', type: 'string' },
  { key: 'imageBackground', type: 'string' },
  { key: 'imageModeration', type: 'string' },
  { key: 'imageOutputCompression', type: 'number' },
  // TTS (MiniMax)
  { key: 'voiceId', type: 'string' },
  { key: 'speed', type: 'number' },
  { key: 'emotion', type: 'string' },
  { key: 'audioFormat', type: 'string' },
  { key: 'sampleRate', type: 'string' },
  { key: 'volume', type: 'number' },
  { key: 'pitch', type: 'number' },
  { key: 'bitrate', type: 'number' },
  { key: 'channel', type: 'number' },
  // TTS 高级参数 (MiniMax)
  { key: 'languageBoost', type: 'string' },
  { key: 'voiceModifyPitch', type: 'number' },
  { key: 'voiceModifyIntensity', type: 'number' },
  { key: 'voiceModifyTimbre', type: 'number' },
  { key: 'voiceModifySoundEffects', type: 'string' },
  { key: 'pronunciationTone', type: 'array' },
  { key: 'aigcWatermark', type: 'boolean' },
  { key: 'englishNormalization', type: 'boolean' },
] as const;

// Derive the known-key set from the schema so the fallback exclusion list can
// never drift from the serialize/parse coverage (the original source of the
// 6-dropped-image-fields bug).
// Typed as Set<string> (not the narrow literal union) so .has() accepts
// arbitrary string keys from Object.entries without a cast.
const PROVIDER_PARAM_KNOWN_KEYS: Set<string> = new Set(PROVIDER_PARAM_SCHEMA.map((s) => s.key));

// ─── Types ───

export interface GenerationsFile {
  generations: GenerationRecord[];
}

export interface GenerationProviderParams {
  model?: string;
  modelName?: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  generateWatermark?: boolean;
  style?: string;
  negativePrompt?: string;
  // TTS (MiniMax)
  voiceId?: string;
  speed?: number;
  emotion?: string;
  audioFormat?: string;
  sampleRate?: string;
  volume?: number;
  pitch?: number;
  bitrate?: number;
  channel?: number;
  // TTS 高级参数 (MiniMax)
  languageBoost?: string;
  voiceModifyPitch?: number;
  voiceModifyIntensity?: number;
  voiceModifyTimbre?: number;
  voiceModifySoundEffects?: string;
  pronunciationTone?: string[];
  aigcWatermark?: boolean;
  englishNormalization?: boolean;
  [key: string]: unknown;
}

export interface GenerationResultInfo {
  fileName: string;
  fileSize: number;
  duration: number;
  width?: number;
  height?: number;
  mimeType: string;
  lastFrameUrl?: string;
  lastFrameAssetId?: string;
  usage?: Record<string, unknown>;
  revisedPrompt?: string;
  created?: number;
}

export interface GenerationRecord {
  id: string;
  status: GenerationStatus;
  fragmentId?: string;
  fragmentName?: string;
  prompt: string;
  references: GenerationReference[];
  providerInstanceId: string;
  providerDisplayName: string;
  providerParams: GenerationProviderParams;
  outputType: AssetType;
  resultAssetId?: string;
  providerTaskId?: string;
  continuousMode?: boolean;
  continuousPlan?: number[];
  currentSegmentIndex?: number;
  continuousGroupId?: string;
  lastFrameAssetId?: string;
  compositeAssetId?: string;
  firstFrameAsReference?: boolean;
  result?: GenerationResultInfo;
  error?: string;
  isSelected: boolean;
  createdAt: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

// ─── Bidirectional mapping ───

/**
 * Convert a GenerationRecord (from XML) to a Generation (in-memory).
 * Records with processing/pending/recovering status are conservatively marked
 * as 'recovering' because we cannot confirm the task is still running at load time.
 * `restoreProjectGenerations` will re-activate any that are still live.
 */
export function recordToGeneration(record: GenerationRecord, projectId: string): Generation {
  const isTransient = record.status === 'processing' || record.status === 'pending';
  return {
    id: record.id,
    projectId,
    fragmentId: record.fragmentId,
    fragmentName: record.fragmentName,
    promptText: record.prompt,
    references: record.references,
    providerInstanceId: record.providerInstanceId,
    providerDisplayName: record.providerDisplayName,
    providerParams: record.providerParams,
    outputType: record.outputType,
    resultAssetId: record.resultAssetId,
    status: isTransient ? 'recovering' : record.status,
    errorMessage:
      record.error
      || (isTransient ? t('generation.task.unknownStatusCheckingServer') : undefined),
    providerTaskId: record.providerTaskId,
    continuousMode: record.continuousMode,
    continuousPlan: record.continuousPlan,
    currentSegmentIndex: record.currentSegmentIndex,
    continuousGroupId: record.continuousGroupId,
    lastFrameAssetId: record.lastFrameAssetId,
    compositeAssetId: record.compositeAssetId,
    firstFrameAsReference: record.firstFrameAsReference,
    result: record.result,
    queuedAt: record.queuedAt ? new Date(record.queuedAt) : undefined,
    startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
    completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
    isSelected: record.isSelected,
    createdAt: new Date(record.createdAt),
  };
}

/** Convert a Generation (in-memory) to a GenerationRecord (for XML). */
export function generationToRecord(gen: Generation): GenerationRecord {
  return {
    id: gen.id,
    status: gen.status,
    fragmentId: gen.fragmentId,
    fragmentName: gen.fragmentName,
    prompt: gen.promptText,
    references: gen.references.map((r) => ({
      assetId: r.assetId,
      type: r.type,
      weight: r.weight,
      role: r.role,
    })),
    providerInstanceId: gen.providerInstanceId,
    providerDisplayName: gen.providerDisplayName,
    providerParams: gen.providerParams as Record<string, unknown>,
    outputType: gen.outputType,
    resultAssetId: gen.resultAssetId,
    providerTaskId: gen.providerTaskId,
    continuousMode: gen.continuousMode,
    continuousPlan: gen.continuousPlan,
    currentSegmentIndex: gen.currentSegmentIndex,
    continuousGroupId: gen.continuousGroupId,
    lastFrameAssetId: gen.lastFrameAssetId,
    compositeAssetId: gen.compositeAssetId,
    firstFrameAsReference: gen.firstFrameAsReference,
    result: gen.result,
    isSelected: gen.isSelected,
    createdAt: gen.createdAt.toISOString(),
    queuedAt: gen.queuedAt?.toISOString(),
    startedAt: gen.startedAt?.toISOString(),
    completedAt: gen.completedAt?.toISOString(),
    error: gen.errorMessage,
  };
}

// ─── Serialization ───

export function serializeGenerationsFile(file: GenerationsFile): string {
  const rootElement = createElement('generations');

  for (const gen of file.generations) {
    rootElement.child(createGenerationElement(gen));
  }

  return serializeXml(rootElement.build());
}

function createGenerationElement(gen: GenerationRecord): XmlElement {
  const attrs: Record<string, string | number | boolean> = {
    id: gen.id,
    status: gen.status,
  };

  if (gen.fragmentId) attrs.fragmentId = gen.fragmentId;
  if (gen.fragmentName) attrs.fragmentName = gen.fragmentName;
  if (gen.providerInstanceId) attrs.providerInstanceId = gen.providerInstanceId;
  if (gen.providerDisplayName) attrs.providerDisplayName = gen.providerDisplayName;
  attrs.outputType = gen.outputType;
  if (gen.resultAssetId) attrs.resultAssetId = gen.resultAssetId;
  if (gen.isSelected) attrs.isSelected = gen.isSelected;
  if (gen.continuousMode) attrs.continuousMode = gen.continuousMode;
  if (gen.continuousPlan?.length) attrs.continuousPlan = gen.continuousPlan.join(',');
  if (gen.currentSegmentIndex !== undefined) attrs.currentSegmentIndex = gen.currentSegmentIndex;
  if (gen.continuousGroupId) attrs.continuousGroupId = gen.continuousGroupId;
  if (gen.lastFrameAssetId) attrs.lastFrameAssetId = gen.lastFrameAssetId;
  if (gen.compositeAssetId) attrs.compositeAssetId = gen.compositeAssetId;
  if (gen.firstFrameAsReference) attrs.firstFrameAsReference = gen.firstFrameAsReference;
  if (gen.createdAt) attrs.createdAt = gen.createdAt;
  if (gen.queuedAt) attrs.queuedAt = gen.queuedAt;
  if (gen.startedAt) attrs.startedAt = gen.startedAt;
  if (gen.completedAt) attrs.completedAt = gen.completedAt;

  const element = createElement('generation', attrs);

  element.child(textElement('prompt', gen.prompt));

  if (gen.references.length > 0) {
    const refsElement = createElement('references');
    for (const ref of gen.references) {
      const refAttrs: Record<string, string | number | boolean> = {
        assetId: ref.assetId,
        type: ref.type,
        weight: ref.weight,
      };
      if (ref.role) refAttrs.role = ref.role;
      refsElement.child(createElement('reference', refAttrs).build());
    }
    element.children(refsElement.build());
  }

  const pp = gen.providerParams;
  const ppAttrs: Record<string, string | number | boolean> = {};
  for (const { key, type } of PROVIDER_PARAM_SCHEMA) {
    const value = pp[key];
    // Guard is `!== undefined` (NOT truthy) so that boolean false and 0 are
    // preserved — `String(false)` === 'false', `String(0)` === '0'.
    if (value !== undefined) {
      if (type === 'array') {
        ppAttrs[key] = JSON.stringify(value);
      } else {
        ppAttrs[key] = String(value);
      }
    }
  }

  // Forward-compat fallback: provider-specific extras not in the schema are
  // still serialized as raw strings (objects/functions skipped).
  for (const [key, value] of Object.entries(pp)) {
    if (!PROVIDER_PARAM_KNOWN_KEYS.has(key) && value !== undefined && typeof value !== 'object') {
      ppAttrs[key] = String(value);
    }
  }

  element.child(createElement('providerParams', ppAttrs).build());

  if (gen.providerTaskId) {
    element.child(textElement('providerTaskId', gen.providerTaskId));
  }

  if (gen.result) {
    const resultAttrs: Record<string, string | number | boolean> = {
      fileName: gen.result.fileName,
      fileSize: gen.result.fileSize,
      duration: gen.result.duration,
      mimeType: gen.result.mimeType,
    };
    if (gen.result.width !== undefined) resultAttrs.width = gen.result.width;
    if (gen.result.height !== undefined) resultAttrs.height = gen.result.height;
    if (gen.result.lastFrameUrl) resultAttrs.lastFrameUrl = gen.result.lastFrameUrl;
    if (gen.result.lastFrameAssetId) resultAttrs.lastFrameAssetId = gen.result.lastFrameAssetId;
    if (gen.result.created !== undefined) resultAttrs.created = gen.result.created;
    if (gen.result.revisedPrompt) resultAttrs.revisedPrompt = gen.result.revisedPrompt;
    if (gen.result.usage) resultAttrs.usage = JSON.stringify(gen.result.usage);
    element.child(createElement('result', resultAttrs).build());
  }

  if (gen.error) {
    element.child(textElement('error', gen.error));
  }

  return element.build();
}

// ─── Parsing ───

export function parseGenerationsFile(xml: string): GenerationsFile {
  const root = parseXml(xml);

  if (root.tagName !== 'generations') {
    throw new Error(`Invalid generations file: expected root element 'generations', got '${root.tagName}'`);
  }

  const generations: GenerationRecord[] = [];
  for (const genEl of getChildElements(root, 'generation')) {
    generations.push(parseGenerationElement(genEl));
  }

  return { generations };
}

function parseGenerationElement(element: XmlElement): GenerationRecord {
  const references: GenerationReference[] = [];
  const refsElement = getChildElement(element, 'references');
  if (refsElement) {
    for (const refEl of getChildElements(refsElement, 'reference')) {
      references.push({
        assetId: refEl.attributes.assetId,
        type: refEl.attributes.type as 'video' | 'image' | 'audio',
        weight: parseFloat(refEl.attributes.weight) || 1,
        role: refEl.attributes.role as GenerationReference['role'] || undefined,
      });
    }
  }

  const promptElement = getChildElement(element, 'prompt');
  const prompt = promptElement ? getElementText(promptElement) : '';

  const ppElement = getChildElement(element, 'providerParams');
  const providerParams: GenerationProviderParams = {};
  if (ppElement) {
    for (const { key, type } of PROVIDER_PARAM_SCHEMA) {
      const attr = ppElement.attributes[key];
      if (attr === undefined) continue;
      // number → Number(attr) preserves fractional values (e.g. duration=5.5);
      // the previous parseInt() truncated 5.5 → 5.
      // boolean → attr === 'true' (false persists, unlike a truthy-coalesced
      // pattern that would collapse false to undefined).
      if (type === 'boolean') {
        providerParams[key] = attr === 'true';
      } else if (type === 'number') {
        providerParams[key] = Number(attr);
      } else if (type === 'array') {
        try {
          const parsed = JSON.parse(attr);
          providerParams[key] = Array.isArray(parsed) ? parsed : [];
        } catch {
          providerParams[key] = [];
        }
      } else {
        providerParams[key] = attr;
      }
    }
    // Forward-compat fallback: unknown keys are kept as raw strings.
    for (const [key, value] of Object.entries(ppElement.attributes)) {
      if (!PROVIDER_PARAM_KNOWN_KEYS.has(key)) {
        providerParams[key] = value;
      }
    }
  }

  const providerTaskIdEl = getChildElement(element, 'providerTaskId');
  const providerTaskId = providerTaskIdEl ? getElementText(providerTaskIdEl) : undefined;

  let result: GenerationResultInfo | undefined;
  const resultElement = getChildElement(element, 'result');
  if (resultElement) {
    result = {
      fileName: resultElement.attributes.fileName,
      fileSize: parseInt(resultElement.attributes.fileSize, 10) || 0,
      duration: parseInt(resultElement.attributes.duration, 10) || 0,
      width: resultElement.attributes.width ? parseInt(resultElement.attributes.width, 10) : undefined,
      height: resultElement.attributes.height ? parseInt(resultElement.attributes.height, 10) : undefined,
      mimeType: resultElement.attributes.mimeType,
      lastFrameUrl: resultElement.attributes.lastFrameUrl || undefined,
      lastFrameAssetId: resultElement.attributes.lastFrameAssetId || undefined,
      created: resultElement.attributes.created ? parseInt(resultElement.attributes.created, 10) : undefined,
      revisedPrompt: resultElement.attributes.revisedPrompt || undefined,
      usage: parseJsonRecord(resultElement.attributes.usage),
    };
  }

  const errorElement = getChildElement(element, 'error');
  const error = errorElement ? getElementText(errorElement) : undefined;

  return {
    id: element.attributes.id,
    status: element.attributes.status as GenerationStatus,
    fragmentId: element.attributes.fragmentId || undefined,
    fragmentName: element.attributes.fragmentName || undefined,
    providerInstanceId: element.attributes.providerInstanceId || '',
    providerDisplayName: element.attributes.providerDisplayName || '',
    outputType: element.attributes.outputType as AssetType,
    resultAssetId: element.attributes.resultAssetId || undefined,
    isSelected: element.attributes.isSelected === 'true',
    continuousMode: element.attributes.continuousMode === 'true' || undefined,
    continuousPlan: element.attributes.continuousPlan
      ? element.attributes.continuousPlan.split(',').map(Number)
      : undefined,
    currentSegmentIndex: element.attributes.currentSegmentIndex
      ? parseInt(element.attributes.currentSegmentIndex, 10)
      : undefined,
    continuousGroupId: element.attributes.continuousGroupId || undefined,
    lastFrameAssetId: element.attributes.lastFrameAssetId || undefined,
    compositeAssetId: element.attributes.compositeAssetId || undefined,
    firstFrameAsReference: element.attributes.firstFrameAsReference === 'true' || undefined,
    createdAt: element.attributes.createdAt || new Date().toISOString(),
    queuedAt: element.attributes.queuedAt || undefined,
    startedAt: element.attributes.startedAt || undefined,
    completedAt: element.attributes.completedAt || undefined,
    prompt,
    references,
    providerParams,
    providerTaskId,
    result,
    error,
  };
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
