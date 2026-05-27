import type { Reference } from './asset';
import type { FragmentProviderSelection } from './provider-system';
import type { GenerationParamDefaults } from './generation';

export type ToolMode = 'select' | 'razor';

export interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface Scene {
  id: string;
  name: string;
  start: number;      // milliseconds
  duration: number;   // milliseconds
  referenceIds: string[]; // 最多 2 张参考图
  createdAt: Date;
  updatedAt: Date;
}

export interface Track {
  id: string;
  type: 'video' | 'audio';
  name: string;
  muted: boolean;
  locked: boolean;
  order: number;
}

export interface Fragment {
  id: string;
  trackId: string;
  start: number; // milliseconds
  duration: number; // milliseconds
  prompt: string;
  references: Reference[];
  status: 'draft' | 'generating' | 'completed' | 'failed';
  sceneId?: string;  // 所属场景 ID (后台逻辑)
  sourceAssetId?: string;  // 可播放源资源 (最多1个)
  resultAssetId?: string;  // 最近一次生成产出的 asset ID
  trimStart?: number;      // 源素材内的起始偏移 (ms)，仅 sourceAssetId 存在时有意义
  muted?: boolean;           // 是否静音（音频分离后视频片段设为 true）
  linkedAudioFragmentId?: string;  // 关联的音频片段 ID（音频分离后指向新创建的音频片段）
  generatedUrl?: string;
  thumbnailUrl?: string;
  providerSelection?: FragmentProviderSelection;
  genParams?: GenerationParamDefaults;
  createdAt: Date;
  updatedAt: Date;
}

export interface DraftFragment {
  trackId: string;
  start: number;
  duration: number;
}

/** Clipboard data structure for copy/paste operations */
export interface ClipboardData {
  fragments: Fragment[];
  scenes: Scene[];
  baseTime: number;  // Base time (earliest container's start)
  baseTrackOrder: number;  // Base track type-local order (earliest fragment's track)
  baseTrackType: 'video' | 'audio';  // Track type of the base fragment
}

/** Paste indicator state showing where content will be pasted */
export interface PasteIndicator {
  time: number;  // Paste start time
  trackId?: string;  // Target track ID (undefined = Scene track)
}

/** Snap line for visual feedback during drag/resize operations */
export interface SnapLine {
  time: number;  // Snap position in milliseconds
  type: 'playhead' | 'fragment-edge' | 'scene-edge';
}

/** Result of snap detection containing adjusted position and snap lines to display */
export interface SnapResult {
  time: number;  // Snapped time position
  snapLines: SnapLine[];  // Snap lines to display for visual feedback
}

/** Context for snap detection operations */
export interface SnapContext {
  playhead: number;
  fragments: Fragment[];
  scenes: Scene[];
  excludeFragmentIds?: string[];  // Fragment IDs to exclude from snap detection
  trackId?: string;  // Current track for filtering fragments
}

export interface TimelineState {
  tracks: Track[];
  fragments: Fragment[];
  scenes: Scene[];
  playhead: number;
  zoom: number;
  scroll: { x: number; y: number };
  duration: number;
  isPlaying: boolean;
  nativePreviewTransportControlled: boolean;
  toolMode: ToolMode;
  selectionBox: SelectionBox | null;
  draftFragment: DraftFragment | null;
  draftPrompt: string;        // Prompt for draft fragment (tracked in store for auto-create)
  maxVideoTracks: number;
  clipboard: ClipboardData | null;
  pasteIndicator: PasteIndicator | null;
  // Snap settings
  snapEnabled: boolean;       // Global snap toggle
  snapThreshold: number;      // Snap threshold in pixels
  activeSnapLines: SnapLine[];  // Currently active snap lines for UI display
}
