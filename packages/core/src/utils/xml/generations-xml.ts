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

const PROVIDER_PARAM_KNOWN_KEYS = new Set([
  'model', 'modelName', 'duration', 'aspectRatio', 'resolution', 'generateAudio', 'generateWatermark', 'style', 'negativePrompt',
  'imageSize', 'imageQuality', 'imageOutputFormat', 'imageBackground', 'imageModeration', 'imageOutputCompression',
]);

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
  if (pp.model) ppAttrs.model = pp.model;
  if (pp.modelName) ppAttrs.modelName = pp.modelName;
  if (pp.duration !== undefined) ppAttrs.duration = pp.duration;
  if (pp.aspectRatio) ppAttrs.aspectRatio = pp.aspectRatio;
  if (pp.resolution) ppAttrs.resolution = pp.resolution;
  if (pp.generateAudio !== undefined) ppAttrs.generateAudio = pp.generateAudio;
  if (pp.generateWatermark !== undefined) ppAttrs.generateWatermark = pp.generateWatermark;
  if (pp.style) ppAttrs.style = pp.style;
  if (pp.negativePrompt) ppAttrs.negativePrompt = pp.negativePrompt;

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
    if (ppElement.attributes.model) providerParams.model = ppElement.attributes.model;
    if (ppElement.attributes.modelName) providerParams.modelName = ppElement.attributes.modelName;
    if (ppElement.attributes.duration) providerParams.duration = parseInt(ppElement.attributes.duration, 10);
    if (ppElement.attributes.aspectRatio) providerParams.aspectRatio = ppElement.attributes.aspectRatio;
    if (ppElement.attributes.resolution) providerParams.resolution = ppElement.attributes.resolution;
    if (ppElement.attributes.generateAudio !== undefined) providerParams.generateAudio = ppElement.attributes.generateAudio === 'true';
    if (ppElement.attributes.generateWatermark !== undefined) providerParams.generateWatermark = ppElement.attributes.generateWatermark === 'true';
    if (ppElement.attributes.style) providerParams.style = ppElement.attributes.style;
    if (ppElement.attributes.negativePrompt) providerParams.negativePrompt = ppElement.attributes.negativePrompt;
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
