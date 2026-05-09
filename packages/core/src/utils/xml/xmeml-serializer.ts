/**
 * XMEML Serializer
 *
 * Handles serialization and parsing of XMEML (FCP7 XML Interchange Format,
 * Version 5) for interoperability with Adobe Premiere Pro, DaVinci Resolve,
 * and other NLEs that support the Final Cut Pro 7 XML format.
 *
 * Time system:
 *   - OpenDirector internally uses milliseconds
 *   - XMEML uses integer frame counts with <rate> (ntsc + timebase) encoding
 *   - All time values are frame-aligned on export
 */

import type { XmlElement } from './types';
import { parseXml, getChildElement, getChildElements, getElementText } from './parser';
import { serializeXml, createElement, textElement } from './serializer';
import { msToFrames, framesToMs } from '../time';
import { DEFAULT_PROJECT_SETTINGS } from '../../constants';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Frame rate encoding: ntsc (TRUE) applies 1000/1001 pulldown to timebase */
export interface XmemlRate {
  ntsc: boolean;
  timebase: number;
}

// ─── Export types (OpenDirector → XMEML) ─────────────────────────────────────

export interface XmemlExportAsset {
  id: string;                    // file id, e.g. "file-1"
  name: string;
  filePath: string;              // absolute local path for pathurl encoding
  duration: number;              // milliseconds
  type: 'video' | 'audio';
  hasAudio: boolean;             // true when a video asset has embedded audio
  width?: number;
  height?: number;
  audioChannels?: number;
  sampleRate?: number;
}

export interface XmemlExportFragment {
  id: string;                    // clipitem id, e.g. "clip-1"
  name: string;
  start: number;                 // milliseconds
  duration: number;              // milliseconds
  trimStart?: number;            // milliseconds (source in-point offset)
  sourceDuration?: number;       // milliseconds - total source file duration
  sourceAssetId: string;         // references XmemlExportAsset.id
  trackType: 'video' | 'audio';
  trackIndex: number;            // track order for multi-track layout
}

export interface XmemlExportScene {
  name: string;
  start: number;                 // milliseconds
  duration: number;              // milliseconds
}

export interface XmemlExportOptions {
  projectName: string;
  fps: number;
  width: number;
  height: number;
  assets: XmemlExportAsset[];
  fragments: XmemlExportFragment[];
  scenes?: XmemlExportScene[];
}

// ─── Import types (XMEML → OpenDirector) ─────────────────────────────────────

export interface XmemlImportResult {
  fps: number;
  width: number;
  height: number;
  assets: XmemlImportAsset[];
  tracks: XmemlImportTrack[];
  totalDuration: number;         // milliseconds
  warnings: string[];
}

export interface XmemlImportAsset {
  id: string;
  name: string;
  localPath: string;             // decoded from file:// URL
  duration: number;              // milliseconds
  hasVideo: boolean;
  hasAudio: boolean;
  exists?: boolean;              // set by I/O layer after verifying disk presence
  width?: number;
  height?: number;
}

export interface XmemlImportTrack {
  type: 'video' | 'audio';
  order: number;
  fragments: XmemlImportFragment[];
}

export interface XmemlImportFragment {
  start: number;                 // milliseconds
  duration: number;              // milliseconds
  trimStart?: number;            // milliseconds (source offset)
  sourceAssetId: string;         // references XmemlImportAsset.id
  name: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = DEFAULT_PROJECT_SETTINGS.resolution.width;
const DEFAULT_HEIGHT = DEFAULT_PROJECT_SETTINGS.resolution.height;
const DEFAULT_AUDIO_DEPTH = 16;
const DEFAULT_AUDIO_SAMPLE_RATE = 48000;
const DEFAULT_AUDIO_CHANNELS = 2;

/** XMEML encodes booleans as TRUE/FALSE strings. */
function xmemlBool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

// ─── Frame rate conversion ────────────────────────────────────────────────────

const TIMEBASE_MAP: Record<number, XmemlRate> = {
  23.976: { ntsc: true, timebase: 24 },
  24:     { ntsc: false, timebase: 24 },
  25:     { ntsc: false, timebase: 25 },
  29.97:  { ntsc: true, timebase: 30 },
  30:     { ntsc: false, timebase: 30 },
  50:     { ntsc: false, timebase: 50 },
  59.94:  { ntsc: true, timebase: 60 },
  60:     { ntsc: false, timebase: 60 },
};

function fpsToRate(fps: number): XmemlRate {
  // Exact match first (handles integer fps and exact 29.97 etc.)
  const result = TIMEBASE_MAP[fps];
  if (result) return result;

  // Approximate match for floating-point round-trip from rateToFps()
  // e.g. rateToFps(true, 30) = 29.97002997... should match TIMEBASE_MAP[29.97]
  for (const knownFps of Object.keys(TIMEBASE_MAP).map(Number)) {
    if (Math.abs(fps - knownFps) < 0.001) {
      return TIMEBASE_MAP[knownFps]!;
    }
  }

  // Unknown frame rate: round to nearest integer timebase, no NTSC pulldown
  return { ntsc: false, timebase: Math.round(fps) };
}

function rateToFps(ntsc: boolean, timebase: number): number {
  return ntsc ? timebase * 1000 / 1001 : timebase;
}

// ─── Path URL encoding/decoding ──────────────────────────────────────────────

function localPathToPathurl(localPath: string): string {
  let normalized = localPath.replace(/\\/g, '/');

  // Ensure the path starts with '/' (required by file://localhost/... format).
  // On Windows, "C:/path" becomes "/C:/path" so the drive letter is a
  // top-level directory under localhost — matching how FCP7 / Premiere expect it.
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }

  // On Windows, preserve the drive-letter colon (C:) unencoded.
  // Premiere Pro expects file://localhost/C:/... not /C%3A/...
  const driveMatch = normalized.match(/^\/([A-Za-z]):\//);
  let drivePrefix = '';
  if (driveMatch) {
    drivePrefix = `/${driveMatch[1]}:`;
    normalized = normalized.slice(drivePrefix.length);
  }

  const encoded = normalized
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `file://localhost${drivePrefix}${encoded}`;
}

function parsePathurl(pathurl: string): string {
  let path = pathurl;
  if (path.startsWith('file://')) {
    path = path.slice('file://'.length);
    if (path.startsWith('localhost')) {
      path = path.slice('localhost'.length);
    }
  }
  path = decodeURIComponent(path);
  path = path.replace(/^\/([A-Za-z]:\/)/, '$1');
  return path;
}

// ─── XML element builders (export) ───────────────────────────────────────────

/** Shared context for building clip/track elements during serialization. */
interface ClipBuildContext {
  rate: XmemlRate;
  fps: number;
  fileElements: Map<string, XmlElement>;
  emittedFileIds: Set<string>;
  masterclipIds: Map<string, string>;
}

function buildRateElement(rate: XmemlRate): XmlElement {
  return createElement('rate')
    .child(textElement('ntsc', xmemlBool(rate.ntsc)))
    .child(textElement('timebase', String(rate.timebase)))
    .build();
}

/**
 * Build a timecode element for the sequence start.
 *
 * FCP7 spec:
 *   - DF (drop-frame) timecodes use semicolons for the frame separator: 01:00:00;00
 *   - NDF (non-drop-frame) timecodes use colons: 01:00:00:00
 *   - Frame count for NDF uses timebase directly; for DF uses actual fps (accounts for dropped frames)
 *   - NTSC 30 and 60 are DF; NTSC 24 (23.976) is NDF per FCP convention
 */
function buildTimecode(rate: XmemlRate): XmlElement {
  const isDf = rate.ntsc && (rate.timebase === 30 || rate.timebase === 60);
  const separator = isDf ? ';' : ':';

  // Frame count for 01:00:00:00
  // NDF: timebase * 3600 (no frames dropped)
  // DF:  actual fps * 3600 (accounts for dropped frames)
  const timebaseFrame = isDf
    ? Math.round(rateToFps(rate.ntsc, rate.timebase) * 3600)
    : rate.timebase * 3600;

  const timecodeString = `01:00:00${separator}00`;

  return createElement('timecode')
    .child(buildRateElement(rate))
    .child(textElement('string', timecodeString))
    .child(textElement('frame', String(timebaseFrame)))
    .child(textElement('displayformat', isDf ? 'DF' : 'NDF'))
    .child(textElement('source', 'source'))
    .build();
}

function buildVideoFormat(width: number, height: number, rate: XmemlRate): XmlElement {
  return createElement('format')
    .child(
      createElement('samplecharacteristics')
        .child(textElement('width', String(width)))
        .child(textElement('height', String(height)))
        .child(textElement('anamorphic', xmemlBool(false)))
        .child(textElement('pixelaspectratio', 'square'))
        .child(textElement('fielddominance', 'none'))
        .child(buildRateElement(rate))
        .child(textElement('colordepth', '24'))
        .build()
    )
    .build();
}

function buildAudioSampleCharacteristics(sampleRate?: number): XmlElement {
  return createElement('samplecharacteristics')
    .child(textElement('depth', String(DEFAULT_AUDIO_DEPTH)))
    .child(textElement('samplerate', String(sampleRate ?? DEFAULT_AUDIO_SAMPLE_RATE)))
    .build();
}

function buildAudioFormat(): XmlElement {
  return createElement('format')
    .child(buildAudioSampleCharacteristics())
    .build();
}

function buildAudioOutputs(): XmlElement {
  return createElement('outputs')
    .child(
      createElement('group')
        .child(textElement('index', '1'))
        .child(textElement('numchannels', '2'))
        .child(textElement('downmix', '0'))
        .child(
          createElement('channel')
            .child(textElement('index', '1'))
            .build()
        )
        .child(
          createElement('channel')
            .child(textElement('index', '2'))
            .build()
        )
        .build()
    )
    .build();
}

function buildAudioMediaElement(asset: XmemlExportAsset, durationFrames: number): XmlElement {
  const channels = asset.audioChannels ?? DEFAULT_AUDIO_CHANNELS;
  const layout = channels === 1 ? 'mono' : 'stereo';
  return createElement('audio')
    .child(textElement('duration', String(durationFrames)))
    .child(buildAudioSampleCharacteristics(asset.sampleRate))
    .child(textElement('channelcount', String(channels)))
    .child(textElement('layout', layout))
    .build();
}

function buildFileElement(asset: XmemlExportAsset, rate: XmemlRate, fps: number): XmlElement {
  const durationFrames = asset.duration > 0 ? msToFrames(asset.duration, fps) : 0;
  const durationStr = String(durationFrames);

  const fileEl = createElement('file', { id: asset.id })
    .child(textElement('name', asset.name))
    .child(textElement('pathurl', localPathToPathurl(asset.filePath)))
    .child(buildRateElement(rate))
    .child(textElement('duration', durationStr));

  const mediaEl = createElement('media');

  if (asset.type === 'video') {
    mediaEl.child(
      createElement('video')
        .child(textElement('duration', durationStr))
        .child(
          createElement('samplecharacteristics')
            .child(textElement('width', String(asset.width || DEFAULT_WIDTH)))
            .child(textElement('height', String(asset.height || DEFAULT_HEIGHT)))
            .build()
        )
        .build()
    );

    if (asset.hasAudio) {
      mediaEl.child(buildAudioMediaElement(asset, durationFrames));
    }
  } else {
    mediaEl.child(buildAudioMediaElement(asset, durationFrames));
  }

  fileEl.child(mediaEl.build());

  return fileEl.build();
}

function buildClipItemElement(
  frag: XmemlExportFragment,
  ctx: ClipBuildContext,
): XmlElement {
  const { rate, fps, fileElements, emittedFileIds, masterclipIds } = ctx;
  const startFrame = msToFrames(frag.start, fps);
  const durationFrames = msToFrames(frag.duration, fps);
  const endFrame = startFrame + durationFrames;

  // Per FCP7 spec: "duration encodes the total number of frames; it does not change
  // when in/out points are set."
  const sourceDurationFrames = frag.sourceDuration != null
    ? msToFrames(frag.sourceDuration, fps)
    : durationFrames;

  const inFrame = frag.trimStart ? msToFrames(frag.trimStart, fps) : 0;
  const outFrame = inFrame + durationFrames;

  const clipEl = createElement('clipitem', { id: frag.id })
    .child(textElement('name', frag.name))
    .child(textElement('masterclipid', masterclipIds.get(frag.sourceAssetId)!))
    .child(textElement('duration', String(sourceDurationFrames)))
    .child(buildRateElement(rate))
    .child(textElement('in', String(inFrame)))
    .child(textElement('out', String(outFrame)))
    .child(textElement('start', String(startFrame)))
    .child(textElement('end', String(endFrame)))
    .child(textElement('enabled', xmemlBool(true)));

  // Video-only elements — anamorphic and alphatype are only valid for video clipitems.
  // Including them in audio clipitems can cause Premiere Pro import errors.
  if (frag.trackType === 'video') {
    clipEl.child(textElement('anamorphic', xmemlBool(false)));
    clipEl.child(textElement('alphatype', 'none'));
  }

  // File element: first occurrence emits full <file> content; subsequent
  // occurrences use a self-closing reference (<file id="file-N"/>).
  // Premiere Pro resolves file id references within the same <video> or
  // <audio> section across tracks — it uses the id registration table
  // built during top-down parsing.
  const fileId = frag.sourceAssetId;
  const fileEl = fileElements.get(fileId);
  if (fileEl) {
    if (!emittedFileIds.has(fileId)) {
      emittedFileIds.add(fileId);
      clipEl.child(fileEl);
    } else {
      clipEl.child(createElement('file', { id: fileId }).build());
    }
  }

  // sourcetrack: Premiere Pro only outputs <sourcetrack> for audio clipitems.
  // Video clipitems do not include sourcetrack in Premiere's own XMEML export.
  if (frag.trackType === 'audio') {
    clipEl.child(
      createElement('sourcetrack')
        .child(textElement('mediatype', frag.trackType))
        .child(textElement('trackindex', String(frag.trackIndex + 1)))  // XMEML is 1-based
        .build()
    );
  }

  return clipEl.build();
}

function buildTrackElement(
  fragments: XmemlExportFragment[],
  ctx: ClipBuildContext,
): XmlElement {
  const sorted = [...fragments].sort((a, b) => a.start - b.start);

  const trackEl = createElement('track');
  for (const frag of sorted) {
    trackEl.child(buildClipItemElement(frag, ctx));
  }

  trackEl.child(textElement('enabled', xmemlBool(true)));
  trackEl.child(textElement('locked', xmemlBool(false)));

  return trackEl.build();
}

function buildMarkerElement(scene: XmemlExportScene, fps: number): XmlElement {
  const startFrame = msToFrames(scene.start, fps);
  const endFrame = msToFrames(scene.start + scene.duration, fps);

  return createElement('marker')
    .child(textElement('name', scene.name))
    .child(textElement('in', String(startFrame)))
    .child(textElement('out', String(endFrame)))
    .build();
}

// ─── Serialization (OpenDirector → XMEML) ────────────────────────────────────

/**
 * Serialize OpenDirector project data to XMEML XML string.
 */
export function serializeToXmeml(options: XmemlExportOptions): string {
  const fps = options.fps;
  const rate = fpsToRate(fps);

  // Group fragments by (trackType, trackIndex)
  const videoTrackMap = new Map<number, XmemlExportFragment[]>();
  const audioTrackMap = new Map<number, XmemlExportFragment[]>();

  for (const frag of options.fragments) {
    const map = frag.trackType === 'audio' ? audioTrackMap : videoTrackMap;
    if (!map.has(frag.trackIndex)) map.set(frag.trackIndex, []);
    map.get(frag.trackIndex)!.push(frag);
  }

  // Calculate sequence duration: max end frame across all fragments
  let sequenceDurationFrames = 0;
  for (const frag of options.fragments) {
    const endFrame = msToFrames(frag.start + frag.duration, fps);
    if (endFrame > sequenceDurationFrames) sequenceDurationFrames = endFrame;
  }
  if (sequenceDurationFrames === 0) sequenceDurationFrames = 1;

  // Pre-build file elements (one per unique asset)
  const fileElements = new Map<string, XmlElement>();
  for (const asset of options.assets) {
    fileElements.set(asset.id, buildFileElement(asset, rate, fps));
  }

  // Track which file ids have already been emitted as full <file> elements.
  // First occurrence gets the full definition; subsequent ones get a self-closing
  // reference (<file id="file-N"/>) matching Premiere Pro's own XMEML export format.
  const emittedFileIds = new Set<string>();

  // Generate masterclip ids — one per unique asset.
  // Premiere Pro requires <masterclipid> on clipitems to associate multiple
  // instances of the same source file across tracks.
  let masterclipIndex = 0;
  const masterclipIds = new Map<string, string>();
  for (const asset of options.assets) {
    masterclipIds.set(asset.id, `masterclip-${++masterclipIndex}`);
  }

  const ctx: ClipBuildContext = { rate, fps, fileElements, emittedFileIds, masterclipIds };

  // Build media — always include both video and audio sections for compatibility
  const mediaEl = createElement('media');

  const videoEl = createElement('video');
  videoEl.child(buildVideoFormat(options.width, options.height, rate));
  const videoTrackIndices = [...videoTrackMap.keys()].sort((a, b) => a - b);
  for (const idx of videoTrackIndices) {
    videoEl.child(buildTrackElement(videoTrackMap.get(idx)!, ctx));
  }
  mediaEl.child(videoEl.build());

  const audioEl = createElement('audio');
  audioEl.child(buildAudioFormat());
  audioEl.child(buildAudioOutputs());
  const audioTrackIndices = [...audioTrackMap.keys()].sort((a, b) => a - b);
  for (const idx of audioTrackIndices) {
    audioEl.child(buildTrackElement(audioTrackMap.get(idx)!, ctx));
  }
  mediaEl.child(audioEl.build());

  // Build sequence
  const sequenceEl = createElement('sequence', { id: options.projectName })
    .child(textElement('name', options.projectName))
    .child(textElement('duration', String(sequenceDurationFrames)))
    .child(buildRateElement(rate))
    .child(buildTimecode(rate))
    .child(mediaEl.build());

  if (options.scenes && options.scenes.length > 0) {
    for (const scene of options.scenes) {
      sequenceEl.child(buildMarkerElement(scene, fps));
    }
  }

  // Build root
  const root = createElement('xmeml', { version: '5' });
  root.child(sequenceEl.build());

  return serializeXml(root.build(), { doctype: '<!DOCTYPE xmeml>' });
}

// ─── Parsing (XMEML → OpenDirector model) ────────────────────────────────────

/**
 * Parse XMEML XML string to structured import data.
 */
export function parseXmeml(xml: string): XmemlImportResult {
  const root = parseXml(xml);
  const warnings: string[] = [];

  if (root.tagName === 'fcpxml') {
    throw new Error(
      'FCPXML format is no longer supported. ' +
      'Please convert your FCPXML file to XMEML (FCP7 XML) format using ' +
      'Final Cut Pro or a conversion tool, then try importing again.'
    );
  }

  if (root.tagName !== 'xmeml') {
    throw new Error(
      `Invalid XML interchange format: expected root element 'xmeml', got '${root.tagName}'. ` +
      'Only XMEML (FCP7 XML Interchange Format, Version 5) is supported.'
    );
  }

  const version = root.attributes.version || '5';
  if (version !== '5') {
    warnings.push(`XMEML version ${version} is not officially supported (expected 5). Parsing will proceed but may be incomplete.`);
  }

  // Find sequence — support <sequence>, <project><sequence>, and <project><children><sequence>
  let sequenceEl = getChildElement(root, 'sequence');
  if (!sequenceEl) {
    const projectEl = getChildElement(root, 'project');
    if (projectEl) {
      sequenceEl = getChildElement(projectEl, 'sequence');
      if (!sequenceEl) {
        const childrenEl = getChildElement(projectEl, 'children');
        if (childrenEl) {
          sequenceEl = getChildElement(childrenEl, 'sequence');
        }
      }
    }
  }
  if (!sequenceEl) {
    throw new Error('No <sequence> found in XMEML document');
  }

  const rateEl = getChildElement(sequenceEl, 'rate');
  const fps = rateEl ? parseRateElement(rateEl) : 30;

  const mediaEl = getChildElement(sequenceEl, 'media');
  let width = 0;
  let height = 0;

  // Priority 1: sequence > media > video > format > samplecharacteristics
  if (mediaEl) {
    const videoEl = getChildElement(mediaEl, 'video');
    if (videoEl) {
      const formatEl = getChildElement(videoEl, 'format');
      if (formatEl) {
        const scEl = getChildElement(formatEl, 'samplecharacteristics');
        if (scEl) {
          width = getIntChild(scEl, 'width') || 0;
          height = getIntChild(scEl, 'height') || 0;
        }
      }
    }
  }

  // Priority 2: fall back to file > media > video > samplecharacteristics (resolved after track parsing)

  const totalDurationFrames = getIntChild(sequenceEl, 'duration');
  const totalDuration = framesToMs(totalDurationFrames, fps);

  // File map populated on-demand during track parsing
  const fileMap = new Map<string, XmemlImportAsset>();
  const tracks: XmemlImportTrack[] = [];

  if (mediaEl) {
    const videoEl = getChildElement(mediaEl, 'video');
    if (videoEl) {
      let trackOrder = 0;
      for (const trackEl of getChildElements(videoEl, 'track')) {
        const track = parseTrackElement(trackEl, 'video', trackOrder++, fps, fileMap, warnings);
        if (track) tracks.push(track);
      }
    }

    const audioEl = getChildElement(mediaEl, 'audio');
    if (audioEl) {
      let trackOrder = 0;
      for (const trackEl of getChildElements(audioEl, 'track')) {
        const track = parseTrackElement(trackEl, 'audio', trackOrder++, fps, fileMap, warnings);
        if (track) tracks.push(track);
      }
    }
  }

  // Priority 2: fall back to file dimensions if sequence format didn't specify them
  if ((width === 0 || height === 0) && fileMap.size > 0) {
    for (const asset of fileMap.values()) {
      if (asset.width && asset.height) {
        width = asset.width;
        height = asset.height;
        break;
      }
    }
  }

  // Priority 3: default 1920×1080
  if (width === 0) width = DEFAULT_WIDTH;
  if (height === 0) height = DEFAULT_HEIGHT;

  return {
    fps,
    width,
    height,
    assets: [...fileMap.values()],
    tracks,
    totalDuration,
    warnings,
  };
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function getIntChild(parent: XmlElement, tagName: string, fallback = 0): number {
  const el = getChildElement(parent, tagName);
  return el ? parseInt(getElementText(el), 10) || fallback : fallback;
}

function parseRateElement(rateEl: XmlElement): number {
  const ntscEl = getChildElement(rateEl, 'ntsc');
  const ntsc = ntscEl ? getElementText(ntscEl) === 'TRUE' : false;
  const timebase = getIntChild(rateEl, 'timebase', 30);
  return rateToFps(ntsc, timebase);
}

function parseFileElement(fileEl: XmlElement, fps: number): XmemlImportAsset {
  const id = fileEl.attributes.id;
  const nameEl = getChildElement(fileEl, 'name');
  const name = nameEl ? getElementText(nameEl) : 'Unnamed';

  const pathurlEl = getChildElement(fileEl, 'pathurl');
  const localPath = pathurlEl ? parsePathurl(getElementText(pathurlEl)) : '';

  const durationFrames = getIntChild(fileEl, 'duration');
  const duration = framesToMs(durationFrames, fps);

  let hasVideo = false;
  let hasAudio = false;
  let width: number | undefined;
  let height: number | undefined;

  // The DTD allows <width> and <height> as direct children of <file>
  const directWidth = getIntChild(fileEl, 'width');
  const directHeight = getIntChild(fileEl, 'height');
  if (directWidth) width = directWidth;
  if (directHeight) height = directHeight;

  const mediaEl = getChildElement(fileEl, 'media');
  if (mediaEl) {
    const videoEl = getChildElement(mediaEl, 'video');
    if (videoEl) {
      hasVideo = true;
      const scEl = getChildElement(videoEl, 'samplecharacteristics');
      if (scEl) {
        const w = getIntChild(scEl, 'width');
        const h = getIntChild(scEl, 'height');
        if (w) width = w;
        if (h) height = h;
      }
    }
    const audioEl = getChildElement(mediaEl, 'audio');
    if (audioEl) {
      hasAudio = true;
    }
  }

  return { id, name, localPath, duration, hasVideo, hasAudio, width, height };
}

function parseTrackElement(
  trackEl: XmlElement,
  type: 'video' | 'audio',
  order: number,
  fps: number,
  fileMap: Map<string, XmemlImportAsset>,
  warnings: string[],
): XmemlImportTrack | null {
  const fragments: XmemlImportFragment[] = [];

  for (const child of getChildElements(trackEl)) {
    const tagName = child.tagName;

    if (tagName === 'transitionitem' || tagName === 'generatoritem') continue;
    if (tagName === 'filter' || tagName === 'effect') continue;
    if (tagName === 'marker') continue;
    if (tagName !== 'clipitem') continue;

    const startVal = getIntChild(child, 'start');
    const endVal = getIntChild(child, 'end');

    // XMEML uses -1 for start/end on clips adjacent to transitions
    if (startVal === -1 || endVal === -1) {
      warnings.push('Skipping clipitem with start/end = -1 (transition-adjacent)');
      continue;
    }

    const fileEl = getChildElement(child, 'file');
    const fileId = fileEl?.attributes.id || '';

    if (!fileId) {
      warnings.push('Skipping clipitem without file reference');
      continue;
    }

    // Parse file on-demand if it has full content and is not yet in the map
    if (fileEl && !fileMap.has(fileId) && getChildElement(fileEl, 'name')) {
      fileMap.set(fileId, parseFileElement(fileEl, fps));
    }

    // Skip clipitem if the file reference was never fully resolved
    if (!fileMap.has(fileId)) {
      warnings.push(`Skipping clipitem with unresolved file reference "${fileId}"`);
      continue;
    }

    const nameEl = getChildElement(child, 'name');
    const clipName = nameEl ? getElementText(nameEl) : 'Unnamed';

    const inFrame = getIntChild(child, 'in');

    fragments.push({
      start: framesToMs(startVal, fps),
      duration: framesToMs(endVal - startVal, fps),
      trimStart: inFrame > 0 ? framesToMs(inFrame, fps) : undefined,
      sourceAssetId: fileId,
      name: clipName,
    });
  }

  if (fragments.length === 0) return null;

  return { type, order, fragments };
}
