/**
 * TauriBridge - unified wrapper around all Tauri invoke() calls.
 *
 * Every method checks isTauri() first and throws outside the desktop shell.
 * Rust-side command names use snake_case matching #[tauri::command] signatures.
 */

import type {
  ProviderCredentials,
  SeedanceTaskParams,
  CreateTaskResult,
  TaskStatusResult,
  AssetGroup,
  AssetGroupListResult,
  AssetItem,
  AssetListResult,
  ProviderImportResult,
  MultiProviderExportPreview,
  MultiProviderImportEntry,
  StartGenerationParams,
  PendingGenerationTask,
  OpenAiImageGenerationParams,
  OpenAiImageGenerationResult,
  MinimaxTtsStartGenerationParams,
  MinimaxGetVoicesResult,
  SeedAudioTtsStartGenerationParams,
} from '../types/ai-video';
import type { FileUploadResult } from '../types/asset-provider';
import type {
  AssetProcessRequest,
  MediaConcatRequest,
  MediaConcatResult,
  MediaProbeResult,
  MediaProbeRequest,
  MediaProcessResult,
  TimelineRenderRequest,
  TimelineRenderResult,
} from '../types/media-backend';
import type {
  PreviewDiagnostics,
  PreviewSessionInfo,
  PreviewViewport,
  TimelinePreviewSnapshot,
} from '../types/media-preview';

// TOS API return types (from tos_api.rs)
interface TOSPresignResult {
  url: string;
  expires_at: string;
}

export interface TOSValidationResult {
  valid: boolean;
  message: string;
}

// ─── Platform guard ───

export { isTauri } from '../utils/platform';
import { isTauri } from '../utils/platform';
import { generateRandomHexPassword } from '../utils/common';
import { guardedInvoke as invoke } from '../utils/tauri-invoke';

// ─── Provider Key (OS Keychain) ───

export const providerKey = {
  /** Check if credentials exist for a provider */
  has(providerId: string): Promise<boolean> {
    return invoke('has_provider_credentials', { providerId });
  },

  /**
   * Save credentials encrypted to a local file.
   *
   * Generates a fresh random encryption password internally and returns it so
   * the caller can store it in the instance config (`_encPassword`). The
   * `credentials` object is serialized verbatim — it is already a flat
   * `{ storageKey: value }` map built from the provider's declarative
   * `credentialFields`, so no provider-specific shaping happens here. The
   * bridge is therefore type-agnostic: adding a provider requires no change.
   */
  async save(providerId: string, credentials: ProviderCredentials): Promise<string> {
    const password = generateRandomHexPassword();
    await invoke('save_provider_credentials', {
      providerId,
      credentialsJson: JSON.stringify(credentials),
      password,
    });
    return password;
  },

  /** Delete credentials file */
  remove(providerId: string): Promise<void> {
    return invoke('delete_provider_credentials', { providerId });
  },

  /** Update fields in existing encrypted credentials. Returns new password. */
  updateCredentials(
    providerId: string,
    password: string,
    updates: Record<string, unknown>,
  ): Promise<string> {
    return invoke('update_provider_credentials', {
      providerId,
      password,
      updatesJson: JSON.stringify(updates),
    });
  },
};

// ─── Provider Config (Export / Import) ───

export const providerConfig = {
  /** Export multiple provider configs to a single .odprovider file */
  exportMulti(
    providers: Array<{ provider_id: string; master_password: string; type_id: string; display_name: string; config?: Record<string, string> }>,
    password: string,
    filePath: string,
  ): Promise<void> {
    return invoke('export_multi_provider_config', {
      providers,
      password,
      filePath,
    });
  },

  /** Preview a multi-provider export file without decrypting */
  verifyMulti(filePath: string): Promise<MultiProviderExportPreview> {
    return invoke('verify_multi_provider_config', { filePath });
  },

  /** Import multiple providers from a multi-provider export file */
  importMulti(
    filePath: string,
    password: string,
    entries: MultiProviderImportEntry[],
  ): Promise<ProviderImportResult[]> {
    return invoke('import_multi_provider_config', {
      filePath,
      password,
      entries,
    });
  },
};

// ─── Seedance API (HMAC-signed via Rust) ───

export const seedanceApi = {
  // ── Task management ──

  /** Start a full generation lifecycle (create + poll + download) in a Rust background task */
  startGeneration(params: StartGenerationParams): Promise<string> {
    return invoke('seedance_start_generation', { params });
  },

  /** Cancel a running generation task */
  cancelGeneration(taskId: string): Promise<boolean> {
    return invoke('seedance_cancel_generation', { taskId });
  },

  /** Resume a pending generation task after app restart */
  resumeGeneration(taskId: string, password: string): Promise<boolean> {
    return invoke('seedance_resume_generation', { taskId, password });
  },

  createTask(providerId: string, password: string, params: SeedanceTaskParams): Promise<CreateTaskResult> {
    return invoke('seedance_create_task', { providerId, password, params });
  },

  getTaskStatus(providerId: string, password: string, taskId: string): Promise<TaskStatusResult> {
    return invoke('seedance_get_task_status', { providerId, password, taskId });
  },

  // ── Cloud Asset Groups ──

  createAssetGroup(
    providerId: string,
    password: string,
    name: string,
    description?: string,
    groupType?: string,
    projectName?: string,
  ): Promise<AssetGroup> {
    return invoke('seedance_create_asset_group', {
      providerId,
      password,
      name,
      description,
      groupType,
      projectName,
    });
  },

  listAssetGroups(providerId: string, password: string, projectName?: string): Promise<AssetGroupListResult> {
    return invoke('seedance_list_asset_groups', { providerId, password, projectName });
  },

  // ── Cloud Assets ──

  listAssets(
    providerId: string,
    password: string,
    groupId: string,
    assetType?: string,
    projectName?: string,
  ): Promise<AssetListResult> {
    return invoke('seedance_list_assets', { providerId, password, groupId, assetType, projectName });
  },

  getAsset(providerId: string, password: string, assetId: string, projectName?: string): Promise<AssetItem> {
    return invoke('seedance_get_asset', { providerId, password, assetId, projectName });
  },

  deleteAsset(providerId: string, password: string, assetId: string, projectName?: string): Promise<void> {
    return invoke('seedance_delete_asset', { providerId, password, assetId, projectName });
  },

  createAsset(
    providerId: string,
    password: string,
    groupId: string,
    url: string,
    assetType: string,
    projectName?: string,
  ): Promise<{ asset_id: string; status: string }> {
    return invoke('seedance_create_asset', {
      providerId,
      password,
      groupId,
      url,
      assetType,
      projectName,
    });
  },

  /** Download a generation result video to the project directory */
  downloadGenerationVideo(url: string, projectPath: string, generationId: string): Promise<{ file_path: string; file_size: number }> {
    return invoke('download_generation_video', { url, projectPath, generationId });
  },

  /** Download a generation result image (e.g. last frame) to the project directory */
  downloadGenerationImage(url: string, projectPath: string, generationId: string): Promise<{ file_path: string; file_size: number }> {
    return invoke('download_generation_image', { url, projectPath, generationId });
  },

  /** Batch query task statuses from the ARK API */
  batchQueryTasks(providerId: string, password: string, taskIds: string[]): Promise<TaskStatusResult[]> {
    return invoke('seedance_batch_query_tasks', { providerId, password, taskIds });
  },
};

export const openAIImageApi = {
  generateImage(params: OpenAiImageGenerationParams): Promise<OpenAiImageGenerationResult> {
    return invoke('openai_generate_image', { params });
  },
};

// ─── MiniMax TTS API (pure Bearer, async create/poll/download via Rust) ───

export const minimaxTtsApi = {
  /** Start a full TTS lifecycle (create + poll + download) in a Rust background task. Returns the local task_id. */
  startGeneration(params: MinimaxTtsStartGenerationParams): Promise<string> {
    return invoke('minimax_tts_start_generation', { params });
  },

  /** Cancel a running TTS task (stops local polling; the MiniMax-side task continues) */
  cancelGeneration(taskId: string): Promise<boolean> {
    return invoke('minimax_tts_cancel_generation', { taskId });
  },

  /** Resume a pending TTS task after app restart */
  resumeGeneration(taskId: string, password: string): Promise<boolean> {
    return invoke('minimax_tts_resume_generation', { taskId, password });
  },

  /** Fetch available voices (system / cloned / designed) from /v1/get_voice */
  getVoices(providerId: string, password: string): Promise<MinimaxGetVoicesResult> {
    return invoke('minimax_get_voices', { providerId, password });
  },
};

// ─── SeedAudio TTS API (X-Api-Key auth, single-shot create via Rust) ───

export const seedaudioTtsApi = {
  /** Start a single-shot TTS lifecycle (POST /api/v3/tts/create) in a Rust background task. Returns the local task_id. */
  startGeneration(params: SeedAudioTtsStartGenerationParams): Promise<string> {
    return invoke('seedaudio_tts_start_generation', { params });
  },

  /** Cancel a running TTS task (aborts the in-flight HTTP request) */
  cancelGeneration(taskId: string): Promise<boolean> {
    return invoke('seedaudio_tts_cancel_generation', { taskId });
  },

  /** Resume a pending TTS task after app restart (re-emits terminal state; no query endpoint) */
  resumeGeneration(taskId: string, password: string): Promise<boolean> {
    return invoke('seedaudio_tts_resume_generation', { taskId, password });
  },
};

// ─── TOS API (SDK-backed via Rust) ───

export const tosApi = {
  /** Validate TOS credentials with HeadBucket check (no .enc file needed) */
  validateTosCredentials(
    ak: string,
    sk: string,
    bucket: string,
    endpoint: string,
    region: string,
  ): Promise<TOSValidationResult> {
    return invoke('validate_tos_credentials', { ak, sk, bucket, endpoint, region });
  },

  /** Generate a presigned GET URL */
  presignUrl(
    providerId: string,
    password: string,
    bucket: string,
    key: string,
    expiresSeconds: number,
  ): Promise<TOSPresignResult> {
    return invoke('tos_presign_url', {
      providerId,
      password,
      bucket,
      key,
      expiresSeconds,
    });
  },

  /** Delete an object from TOS */
  deleteObject(providerId: string, password: string, bucket: string, key: string): Promise<void> {
    return invoke('tos_delete_object', { providerId, password, bucket, key });
  },

  /** Upload a local file directly to TOS (no base64 round-trip) */
  uploadLocalFile(providerId: string, password: string, filePath: string): Promise<FileUploadResult> {
    return invoke('tos_upload_local_file', { providerId, password, filePath });
  },
};

// ─── Generation Log API ───

type LogLevel = 'info' | 'warn' | 'error';

interface WriteGenerationLogParams {
  projectPath: string;
  level: LogLevel;
  taskId?: string;
  phase: string;
  msg: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export const generationLogApi = {
  /** Write a structured log entry to the project's generation.log */
  writeGenerationLog(params: WriteGenerationLogParams): Promise<void> {
    return invoke('write_generation_log', {
      project_path: params.projectPath,
      level: params.level,
      task_id: params.taskId,
      phase: params.phase,
      msg: params.msg,
      duration_ms: params.durationMs,
      data: params.data,
    });
  },
};

// ─── Asset Task API (Rust-backed upload + polling) ───

interface StartAssetUploadParams {
  asset_id: string;
  provider_id: string;
  password: string;
  file_path: string;
  asset_type: string;
  project_path: string;
}

export const assetTaskApi = {
  /** Start a full asset upload lifecycle (TOS upload + CreateAsset + poll) in a Rust background task */
  startAssetUpload(params: StartAssetUploadParams): Promise<void> {
    return invoke('start_asset_upload', { params });
  },

  /** Cancel a running asset upload */
  cancelAssetUpload(assetId: string): Promise<boolean> {
    return invoke('cancel_asset_upload', { assetId });
  },
};

// Media Processing

export const mediaApi = {
  process(request: AssetProcessRequest): Promise<MediaProcessResult> {
    return invoke('media_process', { request });
  },

  concat(request: MediaConcatRequest): Promise<MediaConcatResult> {
    return invoke('media_concat', { request });
  },

  probe(request: MediaProbeRequest): Promise<MediaProbeResult> {
    return invoke('media_probe', { request });
  },

  render(request: TimelineRenderRequest): Promise<TimelineRenderResult> {
    return invoke('media_render_timeline', { request });
  },
};

export const previewApi = {
  createSession(windowLabel?: string): Promise<PreviewSessionInfo> {
    return invoke('media_preview_create_session', { windowLabel });
  },

  destroySession(sessionId: string): Promise<void> {
    return invoke('media_preview_destroy_session', { sessionId });
  },

  attachSurface(
    sessionId: string,
    surfaceId?: string | null,
    viewport?: PreviewViewport | null,
    surfaceSyncRevision?: number | null,
  ): Promise<PreviewSessionInfo> {
    return invoke('media_preview_attach_surface', {
      sessionId,
      surfaceId,
      viewport,
      surfaceSyncRevision,
    });
  },

  setViewport(
    sessionId: string,
    viewport: PreviewViewport,
    surfaceSyncRevision?: number | null,
  ): Promise<void> {
    return invoke('media_preview_set_viewport', { sessionId, viewport, surfaceSyncRevision });
  },

  setSurfacePresenting(
    sessionId: string,
    presenting: boolean,
    surfaceSyncRevision?: number | null,
  ): Promise<void> {
    return invoke('media_preview_set_surface_presenting', {
      sessionId,
      presenting,
      surfaceSyncRevision,
    });
  },

  setTimeline(sessionId: string, snapshot: TimelinePreviewSnapshot): Promise<void> {
    return invoke('media_preview_set_timeline', { sessionId, snapshot });
  },

  play(sessionId: string, epoch: number): Promise<void> {
    return invoke('media_preview_play', { sessionId, epoch });
  },

  playFrom(sessionId: string, timeMs: number, epoch: number): Promise<void> {
    return invoke('media_preview_play_from', { sessionId, timeMs, epoch });
  },

  pause(sessionId: string, epoch: number): Promise<void> {
    return invoke('media_preview_pause', { sessionId, epoch });
  },

  seek(sessionId: string, timeMs: number, epoch: number): Promise<void> {
    return invoke('media_preview_seek', { sessionId, timeMs, epoch });
  },

  stepFrame(sessionId: string, direction: number, epoch: number): Promise<void> {
    return invoke('media_preview_step_frame', { sessionId, direction, epoch });
  },

  setRate(sessionId: string, rate: number, epoch: number): Promise<void> {
    return invoke('media_preview_set_rate', { sessionId, rate, epoch });
  },

  getDiagnostics(sessionId: string): Promise<PreviewDiagnostics> {
    return invoke('media_preview_get_diagnostics', { sessionId });
  },
};

// ─── Shared Generation Task API (provider-agnostic) ───

/**
 * Acknowledge a completed/failed task — deletes the persisted pending record.
 *
 * Provider-agnostic: the pending-tasks directory is shared across all async
 * generation providers (Seedance, MiniMax, …), and `task_id` is a globally
 * unique UUID, so a single command serves every provider type. This replaces
 * the former per-provider `seedanceApi.acknowledgeTask` /
 * `minimaxTtsApi.acknowledgeTask` wrappers (which were byte-identical).
 */
export async function acknowledgeTask(taskId: string): Promise<void> {
  return invoke('acknowledge_task', { taskId });
}

/**
 * List pending generation tasks (across all providers) that were in-flight
 * when the app last closed. Scans the shared pending-tasks directory.
 */
export async function listPendingTasks(): Promise<PendingGenerationTask[]> {
  return invoke('list_pending_tasks');
}

// ─── Singleton ───

/** Subscribe to a Tauri event. Only works in the Tauri desktop shell. */
async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) {
    return () => {};
  }
  const mod = await import('@tauri-apps/api/event');
  const unlisten = await mod.listen(event, (e: { payload: T }) => handler(e.payload));
  return unlisten;
}

export const tauriBridge = {
  providerKey,
  providerConfig,
  seedanceApi,
  openAIImageApi,
  minimaxTtsApi,
  seedaudioTtsApi,
  tosApi,
  assetTaskApi,
  mediaApi,
  previewApi,
  generationLogApi,
  // Provider-agnostic generation task commands (shared pending-tasks dir)
  acknowledgeTask,
  listPendingTasks,
  listen,
  isTauri,
};
