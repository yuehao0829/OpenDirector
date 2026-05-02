import type { MediaExchangeSummary, MediaExchangeWarning } from '../../types/media-exchange';

export interface OtioRationalTime {
  OTIO_SCHEMA: 'RationalTime.1';
  rate: number;
  value: number;
}

export interface OtioTimeRange {
  OTIO_SCHEMA: 'TimeRange.1';
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
}

export interface OtioExternalReference {
  OTIO_SCHEMA: 'ExternalReference.1';
  metadata: Record<string, unknown>;
  name: string;
  available_range: OtioTimeRange | null;
  target_url: string;
}

export interface OtioGap {
  OTIO_SCHEMA: 'Gap.1';
  effects: [];
  enabled: true;
  markers: [];
  metadata: Record<string, unknown>;
  name: string;
  source_range: OtioTimeRange;
}

export interface OtioUnknownItem {
  OTIO_SCHEMA: string;
  source_range?: unknown;
  metadata?: unknown;
  name?: unknown;
  media_reference?: unknown;
}

export interface OtioClip {
  OTIO_SCHEMA: 'Clip.1';
  effects: [];
  enabled: true;
  markers: [];
  media_reference: OtioExternalReference | null;
  metadata: Record<string, unknown>;
  name: string;
  source_range: OtioTimeRange;
}

export interface OtioTrack {
  OTIO_SCHEMA: 'Track.1';
  children: Array<OtioGap | OtioClip | OtioUnknownItem>;
  effects: [];
  enabled: true;
  kind: 'Video' | 'Audio';
  markers: [];
  metadata: Record<string, unknown>;
  name: string;
  source_range: null;
}

export interface OtioStack {
  OTIO_SCHEMA: 'Stack.1';
  children: OtioTrack[];
  effects: [];
  enabled: true;
  markers: [];
  metadata: Record<string, unknown>;
  name: string;
  source_range: null;
}

export interface OtioTimeline {
  OTIO_SCHEMA: 'Timeline.1';
  metadata: Record<string, unknown>;
  name: string;
  tracks: OtioStack;
}

export interface OtioMappingResult {
  timeline: OtioTimeline;
  warnings: MediaExchangeWarning[];
  summary: MediaExchangeSummary;
}

export interface OtioImportAsset {
  id: string;
  name: string;
  localPath: string;
  duration?: number;
  type: 'video' | 'image' | 'audio';
  width?: number;
  height?: number;
  exists?: boolean;
}

export interface OtioImportFragment {
  id: string;
  name: string;
  start: number;
  duration: number;
  trimStart?: number;
  sourceAssetId?: string;
}

export interface OtioImportTrack {
  id: string;
  type: 'video' | 'audio';
  name: string;
  muted: boolean;
  order: number;
  fragments: OtioImportFragment[];
}

export interface OtioImportResult {
  projectName: string;
  fps: number;
  width: number;
  height: number;
  assets: OtioImportAsset[];
  tracks: OtioImportTrack[];
  totalDuration: number;
  warnings: MediaExchangeWarning[];
  summary: MediaExchangeSummary;
}
