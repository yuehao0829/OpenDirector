/**
 * Types for AI video generation via Tauri bridge.
 * Maps to Rust structs in provider_key.rs, provider_config.rs, seedance_api.rs.
 */

// ─── Provider Credentials (→ Rust Credentials) ───

/**
 * Provider credentials, serialized to a flat `{"key": "value"}` object that
 * maps 1:1 to the Rust `Credentials` pure-KV map. Field names are declared
 * per provider type (`credentialFields[].key`); the storage layer is
 * field-name-agnostic, so this type is just `Record<string, string>`.
 */
export type ProviderCredentials = Record<string, string>;

export interface OpenAiImageGenerationParams {
  provider_id: string;
  password: string;
  task_id: string;
  project_path: string;
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  output_format?: string;
  background?: string;
  moderation?: string;
  output_compression?: number;
  user?: string;
}

export interface OpenAiImageGenerationResult {
  file_path: string;
  file_size: number;
  mime_type: string;
  output_format: string;
  width?: number;
  height?: number;
  created?: number;
  usage?: Record<string, unknown>;
  revised_prompt?: string;
}

// ─── MiniMax TTS (→ Rust minimax_tts.rs) ───

/** Parameters for minimax_tts_start_generation. */
export interface MinimaxTtsStartGenerationParams {
  provider_id: string;
  password: string;
  task_id: string;
  project_path: string;
  fragment_id: string;
  model: string;
  text: string;
  voice_id: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
  audio_format?: string;
  sample_rate?: number;
  bitrate?: number;
  channel?: number;
  language_boost?: string;
  voice_modify_pitch?: number;
  voice_modify_intensity?: number;
  voice_modify_timbre?: number;
  voice_modify_sound_effects?: string;
  pronunciation_tone?: string[];
  aigc_watermark?: boolean;
  english_normalization?: boolean;
}

export interface MinimaxVoice {
  voice_id: string;
  name?: string;
  description?: string;
  voice_type?: string;
  status?: string;
}

export interface MinimaxGetVoicesResult {
  voices: MinimaxVoice[];
}

// ─── Seedance Content & Task Params (→ Rust CreateTaskParams) ───

export type SeedanceContentRole =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio';

export interface SeedanceContentItem {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url';
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  role?: SeedanceContentRole;
}

export type SeedanceAspectRatio =
  | '16:9'
  | '4:3'
  | '1:1'
  | '3:4'
  | '9:16'
  | '21:9'
  | 'adaptive';

export interface SeedanceTaskParams {
  content: SeedanceContentItem[];
  model?: string;
  resolution?: '480p' | '720p' | '1080p';
  ratio?: SeedanceAspectRatio;
  duration?: number;
  generate_audio?: boolean;
  return_last_frame?: boolean;
}

// ─── Task Results (→ Rust CreateTaskResult / TaskStatusResult) ───

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface CreateTaskResult {
  task_id: string;
  status: TaskStatus;
  created_at: string;
}

export interface TaskStatusResult {
  task_id: string;
  status: TaskStatus;
  result_url?: string;
  last_frame_url?: string;
  error?: unknown;
}

// ─── Cloud Assets (→ Rust AssetGroup / AssetItem / etc.) ───

export interface AssetGroup {
  group_id: string;
  name: string;
  description: string;
  group_type: string;
  created_at: string;
  updated_at?: string;
}

export interface AssetGroupListResult {
  total: number;
  groups: AssetGroup[];
}

export type AssetStatus =
  | 'Processing'
  | 'Succeeded'
  | 'Failed';

export interface AssetItem {
  asset_id: string;
  group_id: string;
  url: string;
  asset_type: string;
  project_name: string;
  name?: string;
  created_at: string;
  status: AssetStatus;
  error_message?: string;
}

export interface AssetListResult {
  total: number;
  assets: AssetItem[];
}

// ─── Provider Config Export/Import (→ Rust structs) ───

export interface ProviderExportFilePreview {
  format_version: number;
  provider_id: string;
  type_id: string;
  provider_name: string;
  config: Record<string, string>;
  exported_at: string;
}

export interface ProviderImportResult {
  success: boolean;
  provider_id: string;
  type_id: string;
  provider_name: string;
  credentials_saved: boolean;
  error?: string;
  config?: Record<string, string>;
}

// ─── Multi-Provider Export/Import ───

export interface MultiProviderExportPreview {
  format_version: number;
  providers: ProviderExportFilePreview[];
  exported_at: string;
}

export interface MultiProviderImportEntry {
  provider_index: number;
  master_password: string;
  save: boolean;
  /** Local instance ID to save the .enc file under */
  target_provider_id: string;
}

// ─── Generation Task Events (from Rust → JS via Tauri events) ───

export interface GenerationEventCreated {
  type: 'created';
  task_id: string;
  api_task_id: string;
  project_path?: string;
}

export interface GenerationEventDownloadProgress {
  type: 'download_progress';
  task_id: string;
}

export interface GenerationEventCompleted {
  type: 'completed';
  task_id: string;
  api_task_id: string;
  file_path: string;
  file_size: number;
  video_url: string;
  last_frame_url?: string;
  project_path?: string;
}

export interface GenerationEventFailed {
  type: 'failed';
  task_id: string;
  error: string;
  project_path?: string;
}

export interface GenerationEventCancelled {
  type: 'cancelled';
  task_id: string;
  project_path?: string;
}

export type GenerationEvent =
  | GenerationEventCreated
  | GenerationEventDownloadProgress
  | GenerationEventCompleted
  | GenerationEventFailed
  | GenerationEventCancelled;

/** Parameters for seedance_start_generation Tauri command */
export interface StartGenerationParams {
  task_id: string;
  provider_id: string;
  password: string;
  model: string;
  content: SeedanceContentItem[];
  resolution: string;
  ratio: string;
  duration: number;
  generate_audio: boolean;
  return_last_frame?: boolean;
  local_references: LocalReference[];
  project_path: string;
  extra_params?: Record<string, unknown>;
  fragment_id: string;
}

export interface LocalReference {
  content_index: number;
  file_path: string;
}

// ─── Asset Task Events (from Rust → JS via Tauri events) ───

export interface AssetEventCreated {
  type: 'created';
  asset_id: string;
  remote_asset_id: string;
  provider_instance_id: string;
  group_id: string;
  project_path: string;
}

export interface AssetEventActive {
  type: 'active';
  asset_id: string;
  remote_asset_id: string;
  project_path: string;
}

export interface AssetEventFailed {
  type: 'failed';
  asset_id: string;
  remote_asset_id: string;
  error: string;
  project_path: string;
}

export type AssetEvent =
  | AssetEventCreated
  | AssetEventActive
  | AssetEventFailed;

// ─── Pending Task Persistence (→ Rust PendingTaskRecord) ───

export interface PendingGenerationTask {
  task_id: string;
  api_task_id: string;
  provider_id: string;
  fragment_id: string;
  model: string;
  project_path: string;
  registered_at_epoch_ms: number;
  status: 'pending' | 'completed' | 'failed';
  outcome_video_path?: string;
  outcome_video_url?: string;
  outcome_last_frame_url?: string;
  outcome_file_size?: number;
  outcome_error?: string;
  /** MiniMax TTS — file_id of the generated audio (used to re-download after crash if the audio file is missing). */
  outcome_file_id?: number;
}
