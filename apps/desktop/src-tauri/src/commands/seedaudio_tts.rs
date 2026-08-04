//! SeedAudio TTS — ByteDance openspeech non-streaming speech synthesis.
//!
//! Single-shot API: `POST /api/v3/tts/create` with `X-Api-Key` auth returns
//! base64 audio (+ url) in one response (max 120s of audio). Unlike MiniMax /
//! Seedance there is no polling endpoint and no queryable remote task_id, so
//! this provider does NOT reuse the `AsyncPollingTaskRunner` coordinator. Each
//! task runs in its own `tokio::spawn` with a `watch::channel` cancel signal,
//! racing the HTTP future against `cancel_rx.changed()` via `tokio::select!`.
//! Shared infrastructure (pending-task persistence, `GenerationEvent`,
//! `AsyncTaskHandle`, `validate_local_path`, logging) is reused as-is.

use super::async_task_runner::AsyncTaskHandle;
use super::generation_log::{GenerationLogManager, LogContext};
use super::generation_task::{
    delete_pending_task, load_pending_task, write_pending_task, GenerationEvent,
    PendingTaskRecord, PendingTaskStatus,
};
use super::seedance_api::SeedanceState;
use super::util::{build_allowed_dirs, truncate_body, validate_local_path, MAX_DOWNLOAD_SIZE};
use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

const DEFAULT_SEEDAUDIO_BASE_URL: &str = "https://openspeech.bytedance.com";
const LOG_TAG: &str = "SeedAudioTask";
/// SeedAudio synthesis is capped at 120s; allow a small margin for network.
const SEEDAUDIO_REQUEST_TIMEOUT: Duration = Duration::from_secs(130);
/// Max size for an inline reference file (audio / image) before base64. Mirrors
/// the JS-side `referenceAssetConstraints` (10MB); the TOS upload path uses
/// `tos_api.rs`'s own (larger) limit. Primary validation lives in JS — this is a
/// defense-in-depth cap for the base64 fallback.
const MAX_REFERENCE_FILE_SIZE: usize = 10 * 1024 * 1024;

/// Map an audio format string to its file extension.
fn format_to_extension(format: &str) -> &'static str {
    match format {
        "wav" => "wav",
        "mp3" => "mp3",
        "pcm" => "pcm",
        "ogg_opus" => "ogg",
        _ => "mp3",
    }
}

/// A reference input from JS — speaker / audio / image (mutually exclusive per
/// entry). The controller sends exactly one populated field per entry:
/// `speaker` (voice id), `audio_url` / `image_url` (TOS presigned URL, passed
/// through verbatim), or `audio_file_path` / `image_file_path` (local path,
/// base64-encoded inline as `audio_data` / `image_data` — the no-TOS fallback).
#[derive(Deserialize)]
pub struct SeedAudioReferenceInput {
    #[serde(default)]
    pub speaker: Option<String>,
    #[serde(default)]
    pub audio_file_path: Option<String>,
    #[serde(default)]
    pub image_file_path: Option<String>,
    #[serde(default)]
    pub audio_url: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
}

/// Parameters passed from JS to `seedaudio_tts_start_generation`.
#[derive(Deserialize)]
pub struct SeedAudioTtsStartParams {
    pub task_id: String,
    pub provider_id: String,
    pub password: String,
    pub project_path: String,
    pub fragment_id: String,
    pub model: String,
    pub text_prompt: String,
    #[serde(default)]
    pub references: Vec<SeedAudioReferenceInput>,
    pub audio_format: Option<String>,
    pub sample_rate: Option<i32>,
    /// speech_rate ← speed
    pub speech_rate: Option<f64>,
    /// loudness_rate ← volume
    pub loudness_rate: Option<f64>,
    /// pitch_rate ← pitch
    pub pitch_rate: Option<i32>,
}

/// Lightweight task manager — no coordinator loop (SeedAudio is single-shot).
/// Mirrors the cancel pattern from `async_task_runner::TaskManager::cancel`.
pub struct SeedAudioTaskManager {
    pub(crate) tasks: Arc<tokio::sync::Mutex<HashMap<String, AsyncTaskHandle>>>,
    pub(crate) log_manager: Arc<GenerationLogManager>,
}

impl SeedAudioTaskManager {
    pub fn new(log_manager: GenerationLogManager) -> Self {
        Self {
            tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            log_manager: Arc::new(log_manager),
        }
    }

    /// Send a cancellation signal to a running task. Returns `false` if the
    /// task is not currently registered.
    pub async fn cancel(&self, task_id: &str) -> bool {
        let tasks = self.tasks.lock().await;
        if let Some(handle) = tasks.get(task_id) {
            let _ = handle.cancel_tx.send(true);
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn seedaudio_tts_start_generation(
    app: AppHandle,
    state: tauri::State<'_, SeedanceState>,
    manager: tauri::State<'_, SeedAudioTaskManager>,
    params: SeedAudioTtsStartParams,
) -> Result<String, String> {
    let task_id = params.task_id.clone();
    let (cancel_tx, cancel_rx) = watch::channel(false);

    let client = state.http.clone();
    let log_mgr = manager.log_manager.clone();
    let tasks = manager.tasks.clone();
    let task_id_for_cleanup = task_id.clone();

    let handle = tokio::spawn(async move {
        run_seedaudio_lifecycle(app.clone(), client, params, cancel_rx, &log_mgr).await;
        tasks.lock().await.remove(&task_id_for_cleanup);
    });

    manager.tasks.lock().await.insert(
        task_id.clone(),
        AsyncTaskHandle {
            cancel_tx,
            _join_handle: handle,
        },
    );

    Ok(task_id)
}

#[tauri::command]
pub async fn seedaudio_tts_cancel_generation(
    manager: tauri::State<'_, SeedAudioTaskManager>,
    task_id: String,
) -> Result<bool, String> {
    Ok(manager.cancel(&task_id).await)
}

/// Resume a pending SeedAudio task after app restart.
///
/// SeedAudio has no queryable remote task_id, so a `Pending` task cannot be
/// resumed — it is marked Failed (the user must regenerate). `Completed` tasks
/// re-emit if the file still exists; if the file is gone, they re-download from
/// the persisted `outcome_video_url` (valid ~2h after generation) before
/// failing. `Failed` tasks re-emit the stored failure.
#[tauri::command]
#[allow(unused_variables)]
pub async fn seedaudio_tts_resume_generation(
    app: AppHandle,
    state: tauri::State<'_, SeedanceState>,
    task_id: String,
    password: String,
) -> Result<bool, String> {
    resume_seedaudio_task(&app, state.http.clone(), task_id).await
}

// ---------------------------------------------------------------------------
// Per-task lifecycle
// ---------------------------------------------------------------------------

async fn run_seedaudio_lifecycle(
    app: AppHandle,
    client: reqwest::Client,
    params: SeedAudioTtsStartParams,
    mut cancel_rx: watch::Receiver<bool>,
    log_mgr: &Arc<GenerationLogManager>,
) {
    let task_id = params.task_id.clone();
    let project_path = params.project_path.clone();

    let (api_key, base_url) = match get_seedaudio_api_key_and_base_url(
        &params.provider_id,
        &params.password,
    ) {
        Ok(creds) => creds,
        Err(e) => {
            emit_failed(&app, &task_id, &e, &project_path, log_mgr);
            return;
        }
    };

    // Resolve references (speaker / audio file / image file) into API JSON.
    let references = match resolve_seedaudio_references(&params.references, &project_path).await {
        Ok(r) => r,
        Err(e) => {
            emit_failed(&app, &task_id, &e, &project_path, log_mgr);
            return;
        }
    };

    let audio_format = params
        .audio_format
        .clone()
        .unwrap_or_else(|| "mp3".to_string());
    let extension = format_to_extension(&audio_format).to_string();

    let mut audio_config = serde_json::json!({ "format": audio_format });
    if let Some(sr) = params.sample_rate {
        audio_config["sample_rate"] = serde_json::json!(sr);
    }
    // speech_rate / loudness_rate are integer-offset fields (range -50..100,
    // step 1). Serialize as integers so a strict server-side schema doesn't reject
    // a float like `50.0`; pitch_rate is already i32, and these should match.
    if let Some(speech) = params.speech_rate {
        audio_config["speech_rate"] = serde_json::json!(speech.round() as i32);
    }
    if let Some(loudness) = params.loudness_rate {
        audio_config["loudness_rate"] = serde_json::json!(loudness.round() as i32);
    }
    if let Some(pitch) = params.pitch_rate {
        audio_config["pitch_rate"] = serde_json::json!(pitch);
    }

    LogContext::new(log_mgr, &project_path)
        .info("seedaudio_lifecycle_start", "SeedAudio TTS lifecycle started")
        .task_id(&task_id)
        .data(serde_json::json!({
            "provider_id": params.provider_id,
            "model": params.model,
            "fragment_id": params.fragment_id,
            "text_length": params.text_prompt.len(),
            "audio_format": audio_format,
            "references_count": references.len(),
        }))
        .log();

    // Emit Created. SeedAudio has no remote task_id, so api_task_id = task_id.
    let _ = app.emit(
        "generation:status",
        GenerationEvent::Created {
            task_id: task_id.clone(),
            api_task_id: task_id.clone(),
            project_path: Some(project_path.clone()),
        },
    );

    // Persist pending task record (Pending) for crash recovery.
    let pending_record = PendingTaskRecord {
        task_id: task_id.clone(),
        api_task_id: task_id.clone(),
        provider_id: params.provider_id.clone(),
        fragment_id: params.fragment_id.clone(),
        model: params.model.clone(),
        project_path: project_path.clone(),
        registered_at_epoch_ms: chrono::Utc::now().timestamp_millis(),
        status: PendingTaskStatus::Pending,
        outcome_video_path: None,
        outcome_video_url: None,
        outcome_last_frame_url: None,
        outcome_file_size: None,
        outcome_error: None,
        outcome_file_id: None,
    };
    if let Err(e) = write_pending_task(&app, &pending_record) {
        eprintln!("[{}] Failed to save pending task record: {}", LOG_TAG, e);
    }

    // Race the single-shot HTTP request against cancellation. `biased` checks
    // cancel first so a cancel signalled mid-request wins over a simultaneously
    // completing response.
    let http_future = seedaudio_create_tts_http(
        &client,
        &api_key,
        &base_url,
        &params.model,
        &params.text_prompt,
        references,
        &audio_config,
    );
    tokio::pin!(http_future);

    let result = tokio::select! {
        biased;
        _ = cancel_rx.changed() => {
            LogContext::new(log_mgr, &project_path)
                .info("seedaudio_cancelled", "SeedAudio task cancelled")
                .task_id(&task_id)
                .log();
            let _ = delete_pending_task(&app, &task_id);
            let _ = app.emit(
                "generation:status",
                GenerationEvent::Cancelled {
                    task_id: task_id.clone(),
                    project_path: Some(project_path.clone()),
                },
            );
            return;
        }
        r = &mut http_future => r,
    };

    match result {
        Ok((audio_bytes, url)) => {
            let file_size = audio_bytes.len() as u64;
            let output_dir = PathBuf::from(&project_path)
                .join("Generated")
                .join("Audio");
            let output_path = output_dir.join(format!("{}.{}", task_id, extension));
            let file_path_str = output_path.to_string_lossy().to_string();

            // Persist the response url + intended output path BEFORE the file
            // write, so a crash during the write (or a write failure) doesn't
            // lose the ~2h-valid download link or the target path. The record
            // stays Pending here; resume's Pending branch recovers via the file
            // (if written) or a url re-download.
            let mut updated = pending_record.clone();
            updated.outcome_video_url = url.clone();
            updated.outcome_video_path = Some(file_path_str.clone());
            if let Err(e) = write_pending_task(&app, &updated) {
                eprintln!("[{}] Failed to persist outcome url/path: {}", LOG_TAG, e);
            }

            let output_dir_clone = output_dir.clone();
            let output_path_clone = output_path.clone();
            let write_result: Result<(), String> = tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&output_dir_clone)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
                std::fs::write(&output_path_clone, &audio_bytes)
                    .map_err(|e| format!("Failed to write file: {}", e))?;
                Ok::<(), String>(())
            })
            .await
            .map_err(|e| format!("Task join error: {}", e))
            .and_then(|r| r);

            if let Err(e) = write_result {
                // url + path already persisted above — resume can re-download.
                updated.status = PendingTaskStatus::Failed;
                updated.outcome_error = Some(e.clone());
                let _ = write_pending_task(&app, &updated);
                emit_failed(&app, &task_id, &e, &project_path, log_mgr);
                return;
            }

            updated.status = PendingTaskStatus::Completed;
            updated.outcome_file_size = Some(file_size);
            if let Err(e) = write_pending_task(&app, &updated) {
                eprintln!("[{}] Failed to persist completed status: {}", LOG_TAG, e);
            }

            LogContext::new(log_mgr, &project_path)
                .info("seedaudio_completed", "SeedAudio task completed")
                .task_id(&task_id)
                .data(serde_json::json!({ "file_path": file_path_str, "file_size": file_size }))
                // Flush: a successful run writes no Error (the only auto-flush
                // level), so without this the completed log would stay buffered
                // in the BufWriter until the 10-entry threshold or the next
                // failure — making it unreadable when root-causing a later issue.
                .flush_immediate()
                .log();

            let _ = app.emit(
                "generation:status",
                GenerationEvent::Completed {
                    task_id: task_id.clone(),
                    api_task_id: task_id.clone(),
                    file_path: file_path_str,
                    file_size,
                    video_url: url.clone().unwrap_or_default(),
                    last_frame_url: None,
                    project_path: Some(project_path.clone()),
                },
            );
        }
        Err(e) => {
            let mut updated = pending_record.clone();
            updated.status = PendingTaskStatus::Failed;
            updated.outcome_error = Some(e.clone());
            let _ = write_pending_task(&app, &updated);
            emit_failed(&app, &task_id, &e, &project_path, log_mgr);
        }
    }
}

/// Resume helper — see `seedaudio_tts_resume_generation` docs.
async fn resume_seedaudio_task(
    app: &AppHandle,
    client: reqwest::Client,
    task_id: String,
) -> Result<bool, String> {
    let record = load_pending_task(app, &task_id)?;

    match record.status {
        PendingTaskStatus::Completed => {
            // Fast path: the generated file still exists → re-emit Completed.
            if let Some(ref file_path) = record.outcome_video_path {
                if Path::new(file_path).exists() {
                    eprintln!(
                        "[{}] Re-emitting completed event for task {} (file exists)",
                        LOG_TAG, record.task_id
                    );
                    emit_completed(
                        app,
                        &record,
                        file_path,
                        record.outcome_file_size.unwrap_or(0),
                    );
                    return Ok(true);
                }
            }
            // File missing — re-download from the persisted outcome_video_url
            // (valid ~2h after generation). The base64-first response path
            // persists this url even when base64 supplied the original bytes, so
            // a crash / completed-but-file-gone task can recover here.
            match redownload_completed(app, &client, &record).await {
                Ok(true) => Ok(true),
                Ok(false) => {
                    // No url to re-download from — fail (SeedAudio has no query endpoint).
                    let msg = "Generated audio file is missing and SeedAudio has no re-download endpoint; please regenerate".to_string();
                    fail_resume_task(app, &record, msg)
                }
                Err(e) => {
                    let msg = format!("文件已过期或下载失败，请重新生成: {}", e);
                    fail_resume_task(app, &record, msg)
                }
            }
        }
        PendingTaskStatus::Failed => {
            eprintln!(
                "[{}] Re-emitting failed event for task {}",
                LOG_TAG, record.task_id
            );
            let _ = app.emit(
                "generation:status",
                GenerationEvent::Failed {
                    task_id: record.task_id.clone(),
                    error: record
                        .outcome_error
                        .clone()
                        .unwrap_or_else(|| "Generation failed".to_string()),
                    project_path: Some(record.project_path.clone()),
                },
            );
            Ok(true)
        }
        PendingTaskStatus::Pending => {
            // Interrupted mid-lifecycle. run_seedaudio_lifecycle persists the
            // outcome url + target path BEFORE the file write, so try to recover:
            // 1. If the output file already exists (write completed but the
            //    Completed record wasn't persisted), re-emit Completed.
            // 2. Else re-download from outcome_video_url (valid ~2h).
            // 3. Else fail (SeedAudio has no query endpoint to resume a Pending task).
            if let Some(ref file_path) = record.outcome_video_path {
                if Path::new(file_path).exists() {
                    eprintln!(
                        "[{}] Recovering interrupted task {} (file exists)",
                        LOG_TAG, record.task_id
                    );
                    let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
                    let mut updated = record.clone();
                    updated.status = PendingTaskStatus::Completed;
                    updated.outcome_file_size = Some(file_size);
                    let _ = write_pending_task(app, &updated);
                    emit_completed(app, &record, file_path, file_size);
                    return Ok(true);
                }
            }
            match redownload_completed(app, &client, &record).await {
                Ok(true) => Ok(true),
                _ => {
                    let msg = "SeedAudio task was interrupted and cannot be resumed (no query endpoint); please regenerate".to_string();
                    fail_resume_task(app, &record, msg)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Mark a resumed task Failed (persist + emit) and return Ok(true). Used by the
/// Completed-with-missing-file recovery path when re-download is unavailable or
/// fails (e.g. the ~2h url has expired).
fn fail_resume_task(app: &AppHandle, record: &PendingTaskRecord, msg: String) -> Result<bool, String> {
    let mut updated = record.clone();
    updated.status = PendingTaskStatus::Failed;
    updated.outcome_error = Some(msg.clone());
    let _ = write_pending_task(app, &updated);
    let _ = app.emit(
        "generation:status",
        GenerationEvent::Failed {
            task_id: record.task_id.clone(),
            error: msg,
            project_path: Some(record.project_path.clone()),
        },
    );
    Ok(true)
}

/// Re-download the audio from the persisted `outcome_video_url` to the recorded
/// `outcome_video_path`, persist Completed, and emit. Shared by the
/// Completed-with-missing-file and Pending recovery branches.
///
/// Returns `Ok(true)` if the re-download succeeded and Completed was emitted;
/// `Ok(false)` if there is no url to re-download from (caller decides the
/// failure message); `Err(e)` if the download or write failed.
async fn redownload_completed(
    app: &AppHandle,
    client: &reqwest::Client,
    record: &PendingTaskRecord,
) -> Result<bool, String> {
    let url = match record.outcome_video_url.as_ref() {
        Some(u) if !u.is_empty() => u.clone(),
        _ => return Ok(false), // no url to re-download from
    };
    eprintln!(
        "[{}] Re-downloading task {} from url",
        LOG_TAG, record.task_id
    );
    let bytes = download_url_to_bytes(client, &url).await?;
    let file_size = bytes.len() as u64;
    // Use the recorded path (carries the correct extension); reconstruct only
    // for legacy/corrupted records missing the path — the extension then follows
    // the recorded path, not a hardcoded .mp3.
    let target_path = record.outcome_video_path.clone().unwrap_or_else(|| {
        PathBuf::from(&record.project_path)
            .join("Generated")
            .join("Audio")
            .join(format!("{}.mp3", record.task_id))
            .to_string_lossy()
            .to_string()
    });
    let target_path_buf = PathBuf::from(&target_path);
    let parent = target_path_buf.parent().map(|p| p.to_path_buf());
    tokio::task::spawn_blocking(move || {
        if let Some(dir) = parent {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        std::fs::write(&target_path_buf, &bytes)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))
    .and_then(|r| r)?;

    let mut updated = record.clone();
    updated.status = PendingTaskStatus::Completed;
    updated.outcome_video_path = Some(target_path.clone());
    updated.outcome_file_size = Some(file_size);
    let _ = write_pending_task(app, &updated);
    emit_completed(app, record, &target_path, file_size);
    Ok(true)
}

/// Emit a Completed event for a resumed/recovered task (file already on disk or
/// re-downloaded). Shared by the Completed fast-path, the Pending file-exists
/// recovery, and the url re-download path.
fn emit_completed(app: &AppHandle, record: &PendingTaskRecord, file_path: &str, file_size: u64) {
    let _ = app.emit(
        "generation:status",
        GenerationEvent::Completed {
            task_id: record.task_id.clone(),
            api_task_id: record.api_task_id.clone(),
            file_path: file_path.to_string(),
            file_size,
            video_url: record.outcome_video_url.clone().unwrap_or_default(),
            last_frame_url: record.outcome_last_frame_url.clone(),
            project_path: Some(record.project_path.clone()),
        },
    );
}

/// Emit a Failed event + log helper.
fn emit_failed(
    app: &AppHandle,
    task_id: &str,
    error: &str,
    project_path: &str,
    log_mgr: &Arc<GenerationLogManager>,
) {
    LogContext::new(log_mgr, project_path)
        .error("seedaudio_failed", &format!("Generation failed: {}", error))
        .task_id(task_id)
        .data(serde_json::json!({ "error": error }))
        .log();
    let _ = app.emit(
        "generation:status",
        GenerationEvent::Failed {
            task_id: task_id.to_string(),
            error: error.to_string(),
            project_path: Some(project_path.to_string()),
        },
    );
}

/// Resolve SeedAudio API key + base URL (X-Api-Key, default openspeech host).
pub(crate) fn get_seedaudio_api_key_and_base_url(
    provider_id: &str,
    password: &str,
) -> Result<(String, String), String> {
    super::seedance_api::get_api_key_and_base_url(provider_id, password, DEFAULT_SEEDAUDIO_BASE_URL)
}

/// Build the API `references` JSON array from JS inputs.
///
/// - `speaker` → `{ "speaker": <id> }`
/// - `audio_url` → `{ "audio_url": <url> }` (TOS presigned URL, passthrough)
/// - `image_url` → `{ "image_url": <url> }` (TOS presigned URL, passthrough)
/// - `audio_file_path` → read + base64 → `{ "audio_data": <base64> }`
/// - `image_file_path` → read + base64 → `{ "image_data": <base64> }`
///
/// Returns a Vec; an empty Vec means "omit the field" (pure-text generation
/// with the default voice). The controller sends exactly one populated field
/// per entry; this resolver defensively takes the first populated field in the
/// order above. Multi-entry order is preserved (so `@音频N` maps to entry N).
async fn resolve_seedaudio_references(
    references: &[SeedAudioReferenceInput],
    project_path: &str,
) -> Result<Vec<serde_json::Value>, String> {
    if references.is_empty() {
        return Ok(Vec::new());
    }

    // Build the allowed-dir set lazily — only when a reference actually carries
    // a file path. Speaker-only references (the common path; SeedAudio has no
    // voice-listing endpoint) need no file I/O, so we skip the canonicalize
    // calls entirely. The ancestor-walk (util::build_allowed_dirs) adds each
    // reference file's nearest standard-user-dir ancestor so a reference on a
    // non-system drive (e.g. D:\Downloads\…) is accepted — `dirs::*` only
    // resolve the system-drive user dir on Windows. Each entry is canonicalized
    // so the `\\?\`-prefixed canonical file path (Windows) matches via
    // `Path::starts_with`.
    let allowed_dirs: Vec<PathBuf> = if references
        .iter()
        .any(|r| r.audio_file_path.is_some() || r.image_file_path.is_some())
    {
        let file_paths = references.iter().flat_map(|r| {
            [r.audio_file_path.as_deref(), r.image_file_path.as_deref()]
                .into_iter()
                .flatten()
        });
        build_allowed_dirs(project_path, file_paths)
    } else {
        Vec::new()
    };

    let mut out = Vec::with_capacity(references.len());
    for r in references {
        if let Some(ref speaker) = r.speaker {
            if !speaker.is_empty() {
                out.push(serde_json::json!({ "speaker": speaker }));
                continue;
            }
        }
        if let Some(ref audio_url) = r.audio_url {
            if !audio_url.is_empty() {
                out.push(serde_json::json!({ "audio_url": audio_url }));
                continue;
            }
        }
        if let Some(ref image_url) = r.image_url {
            if !image_url.is_empty() {
                out.push(serde_json::json!({ "image_url": image_url }));
                continue;
            }
        }
        if let Some(ref audio_path) = r.audio_file_path {
            let b64 = read_file_as_base64(audio_path, &allowed_dirs).await?;
            out.push(serde_json::json!({ "audio_data": b64 }));
            continue;
        }
        if let Some(ref image_path) = r.image_file_path {
            let b64 = read_file_as_base64(image_path, &allowed_dirs).await?;
            out.push(serde_json::json!({ "image_data": b64 }));
            continue;
        }
    }
    Ok(out)
}

/// Read a local file within an allowed directory and return raw base64 (no
/// `data:` prefix — SeedAudio expects raw base64 for `audio_data`/`image_data`).
async fn read_file_as_base64(
    file_path: &str,
    allowed_dirs: &[PathBuf],
) -> Result<String, String> {
    let canonical = validate_local_path(file_path)?;
    let is_allowed = allowed_dirs.iter().any(|dir| canonical.starts_with(dir));
    if !is_allowed {
        return Err(format!(
            "File must be in a user directory: {}",
            canonical.display()
        ));
    }

    let b64 = tokio::task::spawn_blocking({
        let canonical = canonical.clone();
        move || -> Result<String, String> {
            // Pre-check via metadata so a multi-GB file can't OOM before the
            // post-read size check fires.
            if let Ok(metadata) = std::fs::metadata(&canonical) {
                if metadata.len() > MAX_REFERENCE_FILE_SIZE as u64 {
                    return Err(format!(
                        "Reference file {} exceeds {}MB limit",
                        canonical.display(),
                        MAX_REFERENCE_FILE_SIZE / 1024 / 1024
                    ));
                }
            }
            let bytes = std::fs::read(&canonical).map_err(|e| format!("Failed to read file: {}", e))?;
            // Defense-in-depth: metadata size can be stale or wrong on some
            // filesystems; re-check the actual bytes read. Encoding stays on the
            // blocking thread so the CPU work doesn't block the async runtime.
            if bytes.len() > MAX_REFERENCE_FILE_SIZE {
                return Err(format!(
                    "Reference file exceeds {}MB limit",
                    MAX_REFERENCE_FILE_SIZE / 1024 / 1024
                ));
            }
            Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(b64)
}

/// POST /api/v3/tts/create and return the decoded audio bytes + the response
/// `url` (for persistence / crash-recovery re-download).
///
/// The API returns both `audio` (base64) and `url` (~2h valid). base64 is
/// decoded directly — the bytes are already in hand, so there is no extra
/// round-trip and no 2h-expiry race. The `url` is the fallback when base64 is
/// absent, and is always returned (when present) so the caller can persist it
/// to `outcome_video_url` for resume.
async fn seedaudio_create_tts_http(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: &str,
    text_prompt: &str,
    references: Vec<serde_json::Value>,
    audio_config: &serde_json::Value,
) -> Result<(Vec<u8>, Option<String>), String> {
    let mut payload = serde_json::json!({
        "model": model,
        "text_prompt": text_prompt,
        "audio_config": audio_config,
    });
    // Omit `references` entirely for pure-text generation (empty array = default voice).
    // Takes references by value (no clone) — a voice-cloning reference can carry a
    // ~66MB base64 payload, and the caller never uses it after this call.
    if !references.is_empty() {
        payload["references"] = serde_json::Value::Array(references);
    }

    let resp = client
        .post(format!("{}/api/v3/tts/create", base_url))
        .header("X-Api-Key", api_key)
        .header("Content-Type", "application/json")
        .timeout(SEEDAUDIO_REQUEST_TIMEOUT)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "SeedAudio API error {}: {}",
            status,
            truncate_body(&body)
        ));
    }

    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        format!(
            "SeedAudio response is not valid JSON: {} | body: {}",
            e,
            truncate_body(&body)
        )
    })?;

    let (audio_b64, url) = parse_seedaudio_response(&data).map_err(|e| {
        format!(
            "{} | http_status: {} | response: {}",
            e,
            status,
            truncate_body(&body)
        )
    })?;

    // body + data are no longer needed (audio_b64/url are owned clones); drop
    // them before the decode/download so peak memory doesn't hold the full
    // response alongside the decoded bytes.
    drop(body);
    drop(data);

    // base64-first: decode if present. A malformed/truncated base64 falls back
    // to the url (when present) rather than failing the task outright — the API
    // returned a usable download link, so prefer re-downloading over aborting.
    let bytes = if let Some(b64) = audio_b64 {
        match base64::engine::general_purpose::STANDARD.decode(&b64) {
            Ok(b) => b,
            Err(decode_err) => {
                if let Some(ref u) = url {
                    download_url_to_bytes(client, u).await?
                } else {
                    return Err(format!(
                        "Failed to decode base64 audio and no url fallback: {}",
                        decode_err
                    ));
                }
            }
        }
    } else if let Some(ref u) = url {
        download_url_to_bytes(client, u).await?
    } else {
        // parse_seedaudio_response errors when both are absent, so this is unreachable.
        return Err("SeedAudio response missing both audio and url".to_string());
    };
    Ok((bytes, url))
}

/// Parse a SeedAudio /api/v3/tts/create response.
///
/// `code` is the API's *error* status — it is sent only on failure, never on a
/// successful response. A successful 200 carries just `audio` (base64) and/or
/// `url` with no `code` (confirmed against the official docs and the 08:35
/// e760b3fe trace: a real MP3 `SUQzBAAAA…` body returned with HTTP 200 and no
/// `code` was wrongly rejected as "code missing"). So:
///   - `code` present and non-zero → business error (carry `message` / `msg`).
///   - `code` absent, or `code == 0` → success shape; require `audio` or `url`
///     (both absent is a "missing audio" error). `code == 0` is still tolerated
///     for servers that send it.
/// The base64 audio lives at `data.audio` (fallback: top-level `audio`); the
/// url lives at `data.url` (fallback: top-level `url`). A non-zero code is
/// matched across integer / float / stringified encodings, but a fractional
/// code like `0.5` must NOT truncate to `0` and be misjudged as success — the
/// comparison is exact (`== 0`), not `as i64 == 0`.
fn parse_seedaudio_response(
    data: &serde_json::Value,
) -> Result<(Option<String>, Option<String>), String> {
    let code_value = data.get("code");
    // `code` present and non-zero → error. `code == 0` (int 0, float 0.0, or
    // stringified "0"/"0.0") is tolerated as success; a *missing* `code` (or
    // explicit `null`) is the normal success shape (the API omits `code` on
    // success). A fractional code (e.g. 0.5) must NOT truncate to 0, so the
    // comparison is exact (== 0.0), not `as i64 == 0`.
    //
    // A *present, non-null* `code` that isn't a number (e.g. a string error
    // code like "TTSInvalidAuth", a bool, an object) is an error — a non-numeric
    // code is not a success marker, and treating it as success would discard
    // the API's real `message`/`msg` and surface a misleading "missing audio
    // field" instead (the auth/permission failure would be hidden behind a
    // confusing "no audio" error).
    let is_error = match code_value {
        None | Some(serde_json::Value::Null) => false,
        Some(v) => {
            // `as_f64` covers integer AND float JSON numbers; the string arm
            // handles stringified codes ("0", "3001"). A fractional code like
            // 0.5 must NOT truncate to 0, so the comparison is exact (== 0.0).
            let numeric = v
                .as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()));
            match numeric {
                Some(f) => f != 0.0,
                None => true, // present but not a number → error
            }
        }
    };
    if is_error {
        // `is_error` is true only when `code_value` is `Some` (the `None` /
        // `Null` arm above returns false), so `unwrap()` is safe here.
        let code_display = match code_value.unwrap() {
            serde_json::Value::String(s) => s.clone(),
            v => v.to_string(),
        };
        let msg = data
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| data.get("msg").and_then(|v| v.as_str()))
            .unwrap_or("SeedAudio generation failed");
        return Err(format!("SeedAudio error (code {}): {}", code_display, msg));
    }
    let audio_b64 = nested_str(data, "audio");
    let url = nested_str(data, "url");
    if audio_b64.is_none() && url.is_none() {
        return Err("SeedAudio response missing audio field".to_string());
    }
    Ok((audio_b64, url))
}

/// Extract a string field that may live at `data.<key>` (fallback: top-level
/// `<key>`). Returns an owned copy when present.
fn nested_str(data: &serde_json::Value, key: &str) -> Option<String> {
    data.get("data")
        .and_then(|d| d.get(key))
        .and_then(|v| v.as_str())
        .or_else(|| data.get(key).and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

/// Download bytes from a URL (reqwest GET) with a size guard. Used by the
/// base64-first url fallback (response `url`) and by resume re-download.
async fn download_url_to_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    // SSRF guard: reject non-https urls. The url comes from the API response
    // (`data.url`) or the persisted pending record (`outcome_video_url`), both
    // of which can be tampered — matches the `starts_with("https://")` check in
    // seedance_api.rs / generation_task.rs sibling download paths.
    if !url.starts_with("https://") {
        return Err(format!("Download URL must use https: {}", url));
    }

    let mut resp = client
        .get(url)
        .timeout(SEEDAUDIO_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Download failed with status {}: {}", status, body));
    }

    if let Some(len) = resp.content_length() {
        if len > MAX_DOWNLOAD_SIZE {
            return Err(format!(
                "Audio too large: {} bytes (max {} MB)",
                len,
                MAX_DOWNLOAD_SIZE / 1024 / 1024
            ));
        }
    }

    // Stream the body with a running size cap so a server that omits
    // Content-Length (or lies about it) can't force an unbounded allocation
    // before a post-read check would fire.
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Failed to read download body: {}", e))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_DOWNLOAD_SIZE as usize {
            return Err(format!(
                "Audio too large (exceeds {} MB)",
                MAX_DOWNLOAD_SIZE / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── format_to_extension ──

    #[test]
    fn format_to_extension_known_formats() {
        assert_eq!(format_to_extension("wav"), "wav");
        assert_eq!(format_to_extension("mp3"), "mp3");
        assert_eq!(format_to_extension("pcm"), "pcm");
        assert_eq!(format_to_extension("ogg_opus"), "ogg");
    }

    #[test]
    fn format_to_extension_unknown_defaults_to_mp3() {
        assert_eq!(format_to_extension("flac"), "mp3");
        assert_eq!(format_to_extension(""), "mp3");
        assert_eq!(format_to_extension("opus"), "mp3");
    }

    // ── parse_seedaudio_response ──

    #[test]
    fn parse_response_success_top_level_audio() {
        let v = serde_json::json!({ "code": 0, "audio": "SGVsbG8=" });
        let (audio, url) = parse_seedaudio_response(&v).unwrap();
        assert_eq!(audio.as_deref(), Some("SGVsbG8="));
        assert_eq!(url, None);
    }

    #[test]
    fn parse_response_success_nested_data_audio_and_url() {
        let v = serde_json::json!({ "code": 0, "data": { "audio": "AQID", "url": "https://x" } });
        let (audio, url) = parse_seedaudio_response(&v).unwrap();
        assert_eq!(audio.as_deref(), Some("AQID"));
        assert_eq!(url.as_deref(), Some("https://x"));
    }

    #[test]
    fn parse_response_success_url_only_fallback() {
        // No base64 audio, only a url → still success (url-fallback path).
        let v = serde_json::json!({ "code": 0, "data": { "url": "https://y" } });
        let (audio, url) = parse_seedaudio_response(&v).unwrap();
        assert_eq!(audio, None);
        assert_eq!(url.as_deref(), Some("https://y"));
    }

    #[test]
    fn parse_response_success_top_level_url() {
        let v = serde_json::json!({ "code": 0, "url": "https://z" });
        let (audio, url) = parse_seedaudio_response(&v).unwrap();
        assert_eq!(audio, None);
        assert_eq!(url.as_deref(), Some("https://z"));
    }

    #[test]
    fn parse_response_nonzero_code_is_err_with_message() {
        let v = serde_json::json!({ "code": 3001, "message": "invalid text_prompt" });
        let err = parse_seedaudio_response(&v).unwrap_err();
        assert!(err.contains("3001"), "{}", err);
        assert!(err.contains("invalid text_prompt"), "{}", err);
    }

    #[test]
    fn parse_response_nonzero_code_uses_msg_fallback() {
        let v = serde_json::json!({ "code": 2, "msg": "bad request" });
        let err = parse_seedaudio_response(&v).unwrap_err();
        assert!(err.contains("bad request"), "{}", err);
    }

    #[test]
    fn parse_response_missing_code_with_audio_is_success() {
        // No `code` field is the API's real success shape — `code` is the error
        // status, sent only on failure. A 200 body `{"audio": ...}` with no
        // `code` must succeed (this is the e760b3fe response that was wrongly
        // rejected as "code missing", discarding a real MP3).
        let v = serde_json::json!({ "audio": "x" });
        let (audio, url) = parse_seedaudio_response(&v).unwrap();
        assert_eq!(audio.as_deref(), Some("x"));
        assert_eq!(url, None);
    }

    #[test]
    fn parse_response_missing_code_with_url_is_success() {
        // No `code` + only `url` (no base64 audio) → still success (url fallback).
        let v = serde_json::json!({ "url": "https://only-url.example/audio.mp3" });
        let (audio, url) = parse_seedaudio_response(&v).unwrap();
        assert_eq!(audio, None);
        assert_eq!(url.as_deref(), Some("https://only-url.example/audio.mp3"));
    }

    #[test]
    fn parse_response_missing_code_and_audio_is_err() {
        // No `code` AND no `audio`/`url` → "missing audio". A missing `code` now
        // flows into the success branch (which requires a payload), so this is a
        // "missing audio" error rather than the old "code missing" error.
        let v = serde_json::json!({});
        let err = parse_seedaudio_response(&v).unwrap_err();
        assert!(err.contains("missing audio"), "{}", err);
    }

    #[test]
    fn parse_response_success_missing_audio_is_err() {
        let v = serde_json::json!({ "code": 0 });
        let err = parse_seedaudio_response(&v).unwrap_err();
        assert!(err.contains("missing audio"), "{}", err);
    }

    #[test]
    fn parse_response_float_zero_is_success() {
        // code as float 0.0 must be treated as success.
        let v = serde_json::json!({ "code": 0.0, "data": { "audio": "AQID" } });
        assert!(parse_seedaudio_response(&v).is_ok());
    }

    #[test]
    fn parse_response_string_zero_is_success() {
        // code as string "0" or "0.0" must be treated as success — a stringified
        // float must not fail to parse into a false failure.
        let v1 = serde_json::json!({ "code": "0", "data": { "audio": "AQID" } });
        assert!(parse_seedaudio_response(&v1).is_ok());
        let v2 = serde_json::json!({ "code": "0.0", "data": { "audio": "AQID" } });
        assert!(parse_seedaudio_response(&v2).is_ok());
    }

    #[test]
    fn parse_response_fractional_float_code_is_err() {
        // A non-zero fractional code (e.g. 0.5) must NOT truncate to 0 and be
        // misjudged as success.
        let v = serde_json::json!({ "code": 0.5, "message": "weird" });
        assert!(parse_seedaudio_response(&v).is_err());
    }

    #[test]
    fn parse_response_non_numeric_code_is_err_with_message() {
        // A present, non-numeric `code` (e.g. a string error code) is an error,
        // not a success shape — the API's `message` must be surfaced, not
        // discarded behind a misleading "missing audio field".
        let v = serde_json::json!({ "code": "TTSInvalidAuth", "message": "invalid api key" });
        let err = parse_seedaudio_response(&v).unwrap_err();
        assert!(err.contains("TTSInvalidAuth"), "{}", err);
        assert!(err.contains("invalid api key"), "{}", err);
    }

    #[test]
    fn parse_response_null_code_treated_as_absent() {
        // `{"code": null}` ≈ absent → success shape; with no payload →
        // "missing audio" (not a spurious error).
        let v = serde_json::json!({ "code": null });
        let err = parse_seedaudio_response(&v).unwrap_err();
        assert!(err.contains("missing audio"), "{}", err);
    }

    #[test]
    fn parse_response_bool_code_is_err() {
        // A bool `code` is non-numeric → error.
        let v = serde_json::json!({ "code": true, "message": "boom" });
        let err = parse_seedaudio_response(&v).unwrap_err();
        assert!(err.contains("boom"), "{}", err);
    }

    // ── resolve_seedaudio_references ──

    fn speaker_ref(s: &str) -> SeedAudioReferenceInput {
        SeedAudioReferenceInput {
            speaker: Some(s.to_string()),
            audio_file_path: None,
            image_file_path: None,
            audio_url: None,
            image_url: None,
        }
    }

    #[tokio::test]
    async fn resolve_references_empty_returns_empty() {
        let r = resolve_seedaudio_references(&[], "/nonexistent").await.unwrap();
        assert!(r.is_empty());
    }

    #[tokio::test]
    async fn resolve_references_speaker() {
        let refs = vec![speaker_ref("voice-123")];
        let r = resolve_seedaudio_references(&refs, "/nonexistent").await.unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], serde_json::json!({ "speaker": "voice-123" }));
    }

    #[tokio::test]
    async fn resolve_references_audio_url_passthrough() {
        // TOS path: audio_url is passed through verbatim (no base64 / file I/O).
        let refs = vec![SeedAudioReferenceInput {
            speaker: None,
            audio_file_path: None,
            image_file_path: None,
            audio_url: Some("https://tos.example.com/audio1".to_string()),
            image_url: None,
        }];
        let r = resolve_seedaudio_references(&refs, "/nonexistent").await.unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], serde_json::json!({ "audio_url": "https://tos.example.com/audio1" }));
    }

    #[tokio::test]
    async fn resolve_references_image_url_passthrough() {
        let refs = vec![SeedAudioReferenceInput {
            speaker: None,
            audio_file_path: None,
            image_file_path: None,
            audio_url: None,
            image_url: Some("https://tos.example.com/img1".to_string()),
        }];
        let r = resolve_seedaudio_references(&refs, "/nonexistent").await.unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], serde_json::json!({ "image_url": "https://tos.example.com/img1" }));
    }

    #[tokio::test]
    async fn resolve_references_multi_audio_url_preserves_order() {
        // Up to 3 audio refs in user order → @音频1 / @音频2 / @音频3 map to entries 1/2/3.
        let refs = vec![
            SeedAudioReferenceInput {
                speaker: None,
                audio_file_path: None,
                image_file_path: None,
                audio_url: Some("https://tos.example.com/a1".to_string()),
                image_url: None,
            },
            SeedAudioReferenceInput {
                speaker: None,
                audio_file_path: None,
                image_file_path: None,
                audio_url: Some("https://tos.example.com/a2".to_string()),
                image_url: None,
            },
            SeedAudioReferenceInput {
                speaker: None,
                audio_file_path: None,
                image_file_path: None,
                audio_url: Some("https://tos.example.com/a3".to_string()),
                image_url: None,
            },
        ];
        let r = resolve_seedaudio_references(&refs, "/nonexistent").await.unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0], serde_json::json!({ "audio_url": "https://tos.example.com/a1" }));
        assert_eq!(r[1], serde_json::json!({ "audio_url": "https://tos.example.com/a2" }));
        assert_eq!(r[2], serde_json::json!({ "audio_url": "https://tos.example.com/a3" }));
    }

    #[tokio::test]
    async fn resolve_references_empty_speaker_is_skipped() {
        // An entry with an empty speaker and no file → contributes nothing.
        let refs = vec![SeedAudioReferenceInput {
            speaker: Some(String::new()),
            audio_file_path: None,
            image_file_path: None,
            audio_url: None,
            image_url: None,
        }];
        let r = resolve_seedaudio_references(&refs, "/nonexistent").await.unwrap();
        assert!(r.is_empty());
    }

    fn make_project_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("seedaudio-test-{}", label));
        std::fs::create_dir_all(&dir).expect("create temp project dir");
        dir
    }

    #[tokio::test]
    async fn resolve_references_audio_file_base64() {
        let project_dir = make_project_dir("audio");
        let file_path = project_dir.join("clip.wav");
        std::fs::write(&file_path, b"\x01\x02\x03\x04").unwrap();
        let refs = vec![SeedAudioReferenceInput {
            speaker: None,
            audio_file_path: Some(file_path.to_string_lossy().to_string()),
            image_file_path: None,
            audio_url: None,
            image_url: None,
        }];
        let r = resolve_seedaudio_references(&refs, &project_dir.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(r.len(), 1);
        let expected = base64::engine::general_purpose::STANDARD.encode(b"\x01\x02\x03\x04");
        assert_eq!(r[0], serde_json::json!({ "audio_data": expected }));
        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn resolve_references_image_file_base64() {
        let project_dir = make_project_dir("image");
        let file_path = project_dir.join("face.jpg");
        std::fs::write(&file_path, b"\xAA\xBB\xCC").unwrap();
        let refs = vec![SeedAudioReferenceInput {
            speaker: None,
            audio_file_path: None,
            image_file_path: Some(file_path.to_string_lossy().to_string()),
            audio_url: None,
            image_url: None,
        }];
        let r = resolve_seedaudio_references(&refs, &project_dir.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(r.len(), 1);
        let expected = base64::engine::general_purpose::STANDARD.encode(b"\xAA\xBB\xCC");
        assert_eq!(r[0], serde_json::json!({ "image_data": expected }));
        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test]
    async fn resolve_references_rejects_invalid_path() {
        // A non-existent / non-absolute path → validate_local_path errors.
        // (Cross-platform: on Windows this is non-absolute; on Unix it fails to canonicalize.)
        let refs = vec![SeedAudioReferenceInput {
            speaker: None,
            audio_file_path: Some("/definitely/not/a/real/path/clip.wav".to_string()),
            image_file_path: None,
            audio_url: None,
            image_url: None,
        }];
        let result = resolve_seedaudio_references(&refs, "/nonexistent").await;
        assert!(result.is_err(), "expected an error for an invalid path");
    }

    // ── download_url_to_bytes ──

    #[tokio::test]
    async fn download_url_to_bytes_rejects_invalid_url() {
        // An unparseable URL → reqwest errors at send; no network needed.
        let client = reqwest::Client::new();
        let result = download_url_to_bytes(&client, "not-a-valid-url").await;
        assert!(result.is_err(), "expected an error for an invalid url");
    }
}
