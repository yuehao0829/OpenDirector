//! MiniMax TTS — Phase 1 async speech synthesis.
//!
//! Mirrors `generation_task.rs` but adapted to the MiniMax async TTS API:
//! - Create `POST /v1/t2a_async_v2` -> `task_id`
//! - Poll  `GET /v1/query/t2a_async_query_v2?task_id=` -> `status` + `file_id`
//! - Download `GET /v1/files/retrieve_content?file_id=` (Bearer, binary)
//!
//! Differences from Seedance: pure Bearer auth, single-task polling (no batch API),
//! audio media type, file_id-based download. The shared orchestration skeleton
//! (coordinator loop, task manager, resume flow) lives in `async_task_runner.rs`;
//! this file provides the `MinimaxRunner` trait impl + all provider-specific
//! HTTP/parsing/download logic.

use super::async_task_runner::{
    persist_and_emit_failed, resume_task, AsyncTaskHandle, AsyncPollingTaskRunner,
    CredentialGroupKey, PollOutcome, RegisteredTask, TaskManager, TaskVerdict,
};
use super::generation_log::{GenerationLogManager, LogContext};
use super::generation_task::{
    delete_pending_task, write_pending_task, GenerationEvent, PendingTaskRecord, PendingTaskStatus,
};
use super::seedance_api::{DownloadResult, SeedanceState};
use super::util::{truncate_body, MAX_DOWNLOAD_SIZE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch};

const DEFAULT_MINIMAX_BASE_URL: &str = "https://api.minimaxi.com";

/// Parameters passed from JS to `minimax_tts_start_generation`.
#[derive(Deserialize)]
pub struct MinimaxTtsStartParams {
    pub task_id: String,
    pub provider_id: String,
    pub password: String,
    pub project_path: String,
    pub fragment_id: String,
    pub model: String,
    pub text: String,
    pub voice_id: String,
    pub speed: Option<f64>,
    pub vol: Option<f64>,
    pub pitch: Option<i32>,
    pub emotion: Option<String>,
    pub audio_format: Option<String>,
    pub sample_rate: Option<i32>,
    pub bitrate: Option<i32>,
    pub channel: Option<i32>,
    pub language_boost: Option<String>,
    // voice_modify — 声音效果器
    pub voice_modify_pitch: Option<i32>,      // [-100, 100]
    pub voice_modify_intensity: Option<i32>,  // [-100, 100]
    pub voice_modify_timbre: Option<i32>,     // [-100, 100]
    pub voice_modify_sound_effects: Option<String>,  // spacious_echo / auditorium_echo / lofi_telephone / robotic
    // pronunciation_dict — 发音词典
    pub pronunciation_tone: Option<Vec<String>>,  // ["危险/dangerous", ...]
    // 其他
    pub aigc_watermark: Option<bool>,
    pub english_normalization: Option<bool>,
}

/// Terminal-success payload for MiniMax — carries download inputs only
/// (the `file_id` of the generated audio). No credentials: `download()`
/// receives `api_key`/`base_url` as params, fixing the prior transport leak.
#[derive(Clone)]
pub struct MinimaxOutcome {
    pub file_id: i64,
}

/// MiniMax-specific hooks for the generic async polling coordinator.
pub struct MinimaxRunner;

#[async_trait::async_trait]
impl AsyncPollingTaskRunner for MinimaxRunner {
    type Outcome = MinimaxOutcome;
    type Status = MinimaxTaskStatus;

    fn log_tag() -> &'static str {
        "MinimaxTask"
    }

    fn credentials(provider_id: &str, password: &str) -> Result<(String, String), String> {
        get_minimax_api_key_and_base_url(provider_id, password)
    }

    async fn query_tasks(
        client: &reqwest::Client,
        api_key: &str,
        base_url: &str,
        api_task_ids: &[String],
    ) -> Result<Vec<(String, MinimaxTaskStatus)>, String> {
        // MiniMax has no batch query API — query each task individually.
        // Per-task errors are logged and skipped so one failing task doesn't
        // block the rest of the credential group.
        //
        // Fan out the per-task HTTP queries CONCURRENTLY with BOUNDED
        // concurrency to turn N sequential round-trips per poll cycle into
        // ceil(N/8) batches. We use the chunk-of-8 approach (rather than
        // spawning all + a semaphore) because it is simple, dependency-free,
        // and gives a hard ceiling on in-flight requests per credential
        // group, which protects against MiniMax rate-limiting. For typical
        // MiniMax usage (1-3 tasks) the chunking is a no-op.
        //
        // reqwest::Client is cheap to clone (Arc-backed), so each spawned
        // task gets its own clone; api_key/base_url/id are moved in as owned
        // values because tokio::spawn requires a 'static future.
        //
        // JoinSet yields results in COMPLETION ORDER (not submission order),
        // so each spawned task carries its own id alongside its result and we
        // re-key by that id when collecting.
        const QUERY_CONCURRENCY: usize = 8;
        let mut results = Vec::with_capacity(api_task_ids.len());

        for chunk in api_task_ids.chunks(QUERY_CONCURRENCY) {
            let mut set = tokio::task::JoinSet::new();
            for id in chunk {
                let client = client.clone();
                let api_key = api_key.to_string();
                let base_url = base_url.to_string();
                let id = id.clone();
                set.spawn(async move {
                    // Borrow `id` for the HTTP call, then move it into the result tuple —
                    // avoids a second String allocation per task per poll cycle.
                    let result = minimax_query_task_http(&client, &api_key, &base_url, &id).await;
                    (id, result)
                });
            }
            while let Some(joined) = set.join_next().await {
                // JoinError only occurs if the spawned task panicked or was
                // cancelled — neither is expected here. Treat it as a per-task
                // failure (log + skip) to preserve error-and-continue semantics.
                let (id, outcome) = match joined {
                    Ok(pair) => pair,
                    Err(e) => {
                        eprintln!("[MinimaxTask] Query task panicked: {}", e);
                        continue;
                    }
                };
                match outcome {
                    Ok(status) => results.push((id, status)),
                    Err(e) => {
                        eprintln!("[MinimaxTask] Query failed for task {}: {}", id, e);
                    }
                }
            }
        }
        Ok(results)
    }

    fn classify(status: &MinimaxTaskStatus) -> TaskVerdict<MinimaxOutcome> {
        match status.status.as_str() {
            "success" => {
                let file_id = status.file_id.unwrap_or(0);
                TaskVerdict::Succeeded(MinimaxOutcome { file_id })
            }
            "failed" => {
                let err = status
                    .error_msg
                    .clone()
                    .unwrap_or_else(|| "Generation failed".to_string());
                TaskVerdict::Failed(err)
            }
            "expired" => TaskVerdict::Failed("Task expired".to_string()),
            _ => TaskVerdict::Processing,
        }
    }

    fn status_display(status: &MinimaxTaskStatus) -> String {
        status.status.clone()
    }

    async fn try_recover_completed_missing_file(
        app: &AppHandle,
        record: &PendingTaskRecord,
        client: &reqwest::Client,
        api_key: &str,
        base_url: &str,
    ) -> Option<Result<(), String>> {
        if let Some(file_id) = record.outcome_file_id {
            eprintln!(
                "[MinimaxTask] Completed task {} has missing audio file, re-downloading via file_id {}",
                record.task_id, file_id
            );
            match minimax_download_audio(
                client,
                api_key,
                base_url,
                file_id,
                &record.project_path,
                &record.task_id,
            )
            .await
            {
                Ok(result) => {
                    let mut updated = record.clone();
                    updated.outcome_video_path = Some(result.file_path.clone());
                    updated.outcome_file_size = Some(result.file_size);
                    if let Err(e) = write_pending_task(app, &updated) {
                        eprintln!(
                            "[MinimaxTask] Failed to persist re-downloaded status: {}",
                            e
                        );
                    }
                    let _ = app.emit(
                        "generation:status",
                        GenerationEvent::Completed {
                            task_id: updated.task_id.clone(),
                            api_task_id: updated.api_task_id.clone(),
                            file_path: result.file_path,
                            file_size: result.file_size,
                            video_url: String::new(),
                            last_frame_url: None,
                            project_path: Some(updated.project_path.clone()),
                        },
                    );
                    Some(Ok(()))
                }
                Err(e) => {
                    eprintln!(
                        "[MinimaxTask] Re-download failed for task {} (file_id may have expired): {}",
                        record.task_id, e
                    );
                    Some(Err(format!(
                        "文件已过期或下载失败，请重新生成: {}",
                        e
                    )))
                }
            }
        } else {
            Some(Err(
                "Generated audio file is missing and no file_id is available to re-download"
                    .to_string(),
            ))
        }
    }

    fn handle_outcome(
        app: &AppHandle,
        client: &reqwest::Client,
        api_key: &str,
        base_url: &str,
        record: &PendingTaskRecord,
        outcome: PollOutcome<MinimaxOutcome>,
        _log_mgr: &Arc<GenerationLogManager>,
    ) {
        handle_minimax_poll_outcome(app, client, api_key, base_url, record, outcome);
    }
}

pub type MinimaxTaskManager = TaskManager<MinimaxRunner>;


// ---------------------------------------------------------------------------
// Result / voice types
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct MinimaxCreateResult {
    task_id: String,
    file_id: Option<i64>,
}

#[derive(Serialize)]
pub struct MinimaxVoice {
    pub voice_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub voice_type: Option<String>,
    pub status: Option<String>,
}

#[derive(Serialize)]
pub struct MinimaxGetVoicesResult {
    pub voices: Vec<MinimaxVoice>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn minimax_tts_start_generation(
    app: AppHandle,
    state: tauri::State<'_, SeedanceState>,
    manager: tauri::State<'_, MinimaxTaskManager>,
    params: MinimaxTtsStartParams,
) -> Result<String, String> {
    let task_id = params.task_id.clone();
    let (cancel_tx, cancel_rx) = watch::channel(false);

    let client = state.http.clone();
    let provider_id = params.provider_id.clone();
    let password = params.password.clone();
    let tasks = manager.tasks.clone();
    let coordinator_tasks = manager.coordinator_tasks.clone();
    let coordinator_notify = manager.coordinator_notify.clone();

    let task_id_for_cleanup = task_id.clone();
    let log_mgr = manager.log_manager.clone();
    let handle = tokio::spawn(async move {
        run_minimax_lifecycle(
            app.clone(),
            client,
            &provider_id,
            &password,
            params,
            cancel_rx,
            coordinator_tasks,
            coordinator_notify,
            &log_mgr,
        )
        .await;
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
pub async fn minimax_tts_cancel_generation(
    manager: tauri::State<'_, MinimaxTaskManager>,
    task_id: String,
) -> Result<bool, String> {
    Ok(manager.cancel(&task_id).await)
}

/// Fetch available voices (system / cloned / designed) from /v1/get_voice.
#[tauri::command]
pub async fn minimax_get_voices(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
) -> Result<MinimaxGetVoicesResult, String> {
    let (api_key, base_url) = get_minimax_api_key_and_base_url(&provider_id, &password)?;
    minimax_get_voices_http(&state.http, &api_key, &base_url).await
}

/// Resume a pending MiniMax TTS task after app restart.
#[tauri::command]
pub async fn minimax_tts_resume_generation(
    app: AppHandle,
    state: tauri::State<'_, SeedanceState>,
    manager: tauri::State<'_, MinimaxTaskManager>,
    task_id: String,
    password: String,
) -> Result<bool, String> {
    resume_task::<MinimaxRunner>(
        app,
        state.http.clone(),
        manager.inner(),
        task_id,
        password,
    )
    .await
}

// ---------------------------------------------------------------------------
// Per-task lifecycle
// ---------------------------------------------------------------------------

async fn run_minimax_lifecycle(
    app: AppHandle,
    client: reqwest::Client,
    provider_id: &str,
    password: &str,
    params: MinimaxTtsStartParams,
    cancel_rx: watch::Receiver<bool>,
    coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask<MinimaxOutcome>>>>,
    coordinator_notify: mpsc::Sender<()>,
    log_mgr: &Arc<GenerationLogManager>,
) {
    let task_id = params.task_id.clone();
    let project_path = params.project_path.clone();

    let (api_key, base_url) = match get_minimax_api_key_and_base_url(provider_id, password) {
        Ok(creds) => creds,
        Err(e) => {
            emit_failed(&app, &task_id, &e, &params.project_path, log_mgr);
            return;
        }
    };

    let cred_group = CredentialGroupKey {
        api_key: api_key.clone(),
        base_url: base_url.clone(),
    };

    LogContext::new(log_mgr, &project_path)
        .info("minimax_lifecycle_start", "MiniMax TTS lifecycle started")
        .task_id(&task_id)
        .data(serde_json::json!({
            "provider_id": provider_id,
            "model": params.model,
            "fragment_id": params.fragment_id,
            "voice_id": params.voice_id,
            "emotion": params.emotion,
            "audio_format": params.audio_format,
            "text_length": params.text.len(),
        }))
        .log();

    let create_start = std::time::Instant::now();
    let api_task_id = match minimax_create_task_http(&client, &api_key, &base_url, &params).await {
        Ok(r) => {
            let elapsed = create_start.elapsed().as_millis() as u64;
            LogContext::new(log_mgr, &project_path)
                .info("minimax_create_task_response", "Created MiniMax TTS task")
                .task_id(&task_id)
                .duration_ms(elapsed)
                .data(serde_json::json!({ "api_task_id": r.task_id, "file_id": r.file_id }))
                .log();
            r.task_id
        }
        Err(e) => {
            LogContext::new(log_mgr, &project_path)
                .error("minimax_create_task_error", &format!("API create task failed: {}", e))
                .task_id(&task_id)
                .data(serde_json::json!({ "error": e }))
                .log();
            emit_failed(&app, &task_id, &e, &params.project_path, log_mgr);
            return;
        }
    };

    let _ = app.emit(
        "generation:status",
        GenerationEvent::Created {
            task_id: task_id.clone(),
            api_task_id: api_task_id.clone(),
            project_path: Some(params.project_path.clone()),
        },
    );

    // Save pending task record to disk
    let pending_record = PendingTaskRecord {
        task_id: task_id.clone(),
        api_task_id: api_task_id.clone(),
        provider_id: provider_id.to_string(),
        fragment_id: params.fragment_id.clone(),
        model: params.model.clone(),
        project_path: params.project_path.clone(),
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
        eprintln!("[MinimaxTask] Failed to save pending task record: {}", e);
    }

    // Register with coordinator and wait for result
    let (result_tx, result_rx) = oneshot::channel();
    {
        let registered = RegisteredTask {
            task_id: task_id.clone(),
            api_task_id: api_task_id.clone(),
            cred_group,
            result_tx,
            cancel_rx,
            registered_at: tokio::time::Instant::now(),
            project_path: params.project_path.clone(),
        };
        let mut coord = coordinator_tasks.lock().await;
        coord.insert(task_id.clone(), registered);
    }
    let _ = coordinator_notify.try_send(());

    let outcome = match result_rx.await {
        Ok(outcome) => outcome,
        Err(_) => {
            eprintln!(
                "[MinimaxTask] result_tx dropped for task {} - app shutdown, keeping pending file",
                task_id
            );
            LogContext::new(log_mgr, &project_path)
                .warn("minimax_lifecycle_shutdown", "Lifecycle exited due to app shutdown, pending file preserved")
                .task_id(&task_id)
                .log();
            return;
        }
    };

    handle_minimax_poll_outcome(&app, &client, &api_key, &base_url, &pending_record, outcome);
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
        .error("minimax_failed", &format!("Generation failed: {}", error))
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

/// Persist outcome, then emit events. If the app crashes after persisting but
/// before emitting, the next restart can recover from the record.
///
/// `api_key`/`base_url` are passed as params (NOT carried in the outcome) —
/// this fixes the prior transport leak where creds were embedded in
/// `PollOutcome::Succeeded`.
fn handle_minimax_poll_outcome(
    app: &AppHandle,
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    record: &PendingTaskRecord,
    outcome: PollOutcome<MinimaxOutcome>,
) {
    match outcome {
        PollOutcome::Succeeded(outcome) => {
            let file_id = outcome.file_id;
            let _ = app.emit(
                "generation:status",
                GenerationEvent::DownloadProgress {
                    task_id: record.task_id.clone(),
                },
            );

            let rt = tokio::runtime::Handle::current();
            let app = app.clone();
            let client = client.clone();
            let api_key = api_key.to_string();
            let base_url = base_url.to_string();
            let project_path = record.project_path.clone();
            let mut updated_record = record.clone();
            rt.spawn(async move {
                eprintln!(
                    "[MinimaxTask] Downloading audio for task {} (file_id {})",
                    updated_record.task_id, file_id
                );
                match minimax_download_audio(
                    &client,
                    &api_key,
                    &base_url,
                    file_id,
                    &project_path,
                    &updated_record.task_id,
                )
                .await
                {
                    Ok(result) => {
                        eprintln!(
                            "[MinimaxTask] Download complete: {} ({} bytes) for task {}",
                            result.file_path, result.file_size, updated_record.task_id
                        );
                        updated_record.status = PendingTaskStatus::Completed;
                        updated_record.outcome_video_path = Some(result.file_path.clone());
                        updated_record.outcome_file_size = Some(result.file_size);
                        updated_record.outcome_file_id = Some(file_id);
                        if let Err(e) = write_pending_task(&app, &updated_record) {
                            eprintln!("[MinimaxTask] Failed to persist completed status: {}", e);
                        }
                        let _ = app.emit(
                            "generation:status",
                            GenerationEvent::Completed {
                                task_id: updated_record.task_id.clone(),
                                api_task_id: updated_record.api_task_id.clone(),
                                file_path: result.file_path,
                                file_size: result.file_size,
                                video_url: String::new(),
                                last_frame_url: None,
                                project_path: Some(updated_record.project_path.clone()),
                            },
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[MinimaxTask] Download failed for task {}: {}",
                            updated_record.task_id, e
                        );
                        persist_and_emit_failed(
                            &app,
                            &updated_record,
                            format!("Download failed: {}", e),
                            MinimaxRunner::log_tag(),
                        );
                    }
                }
            });
        }
        PollOutcome::Failed(err) => {
            persist_and_emit_failed(app, record, err, MinimaxRunner::log_tag());
        }
        PollOutcome::Cancelled => {
            let _ = delete_pending_task(app, &record.task_id);
            let _ = app.emit(
                "generation:status",
                GenerationEvent::Cancelled {
                    task_id: record.task_id.clone(),
                    project_path: Some(record.project_path.clone()),
                },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/// Get the MiniMax API key and base URL for a provider.
/// Independent default (https://api.minimaxi.com) — does NOT reuse the Ark default.
pub(crate) fn get_minimax_api_key_and_base_url(
    provider_id: &str,
    password: &str,
) -> Result<(String, String), String> {
    super::seedance_api::get_api_key_and_base_url(provider_id, password, DEFAULT_MINIMAX_BASE_URL)
}

pub(crate) struct MinimaxTaskStatus {
    status: String,
    file_id: Option<i64>,
    error_msg: Option<String>,
}

/// Extract file_id from a JSON value, trying top-level then data.file_id,
/// accepting both i64 and string forms.
fn extract_file_id(value: &serde_json::Value) -> Option<i64> {
    for v in [value.get("file_id"), value.get("data").and_then(|d| d.get("file_id"))] {
        if let Some(v) = v {
            if let Some(n) = v.as_i64() {
                return Some(n);
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<i64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// Extract task_id from a JSON value, accepting both string and number forms.
/// MiniMax returns task_id as a JSON number (e.g. 415799063728442); some proxies may
/// serialize it as a string — accept both so a numeric task_id isn't mistaken for missing.
fn extract_task_id(value: &serde_json::Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = value.as_i64() {
        return Some(n.to_string());
    }
    if let Some(n) = value.as_u64() {
        return Some(n.to_string());
    }
    None
}

/// Parse a MiniMax query response into a normalized task status.
/// - status is lowercased (processing/success/failed/expired)
/// - base_resp.status_code != 0 -> failed with status_msg
/// - file_id extracted from top-level or data.file_id (i64 or string)
fn parse_minimax_task_status(data: &serde_json::Value) -> MinimaxTaskStatus {
    let raw_status = data
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("processing")
        .to_lowercase();

    let base_resp = data.get("base_resp");
    let status_code = base_resp
        .and_then(|b| b.get("status_code"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let status_msg = base_resp
        .and_then(|b| b.get("status_msg"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if status_code != 0 {
        return MinimaxTaskStatus {
            status: "failed".to_string(),
            file_id: None,
            error_msg: status_msg.or_else(|| Some(format!("MiniMax error code {}", status_code))),
        };
    }

    let file_id = extract_file_id(data);

    let normalized = match raw_status.as_str() {
        "success" => "success",
        "failed" => "failed",
        "expired" => "expired",
        _ => "processing",
    };

    MinimaxTaskStatus {
        status: normalized.to_string(),
        file_id,
        error_msg: None,
    }
}

/// Create a MiniMax TTS task via POST /v1/t2a_async_v2.
async fn minimax_create_task_http(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    params: &MinimaxTtsStartParams,
) -> Result<MinimaxCreateResult, String> {
    let mut voice_setting = serde_json::json!({
        "voice_id": params.voice_id,
    });
    if let Some(speed) = params.speed {
        voice_setting["speed"] = serde_json::json!(speed);
    }
    if let Some(vol) = params.vol {
        voice_setting["vol"] = serde_json::json!(vol);
    }
    if let Some(pitch) = params.pitch {
        voice_setting["pitch"] = serde_json::json!(pitch);
    }
    if let Some(ref emotion) = params.emotion {
        voice_setting["emotion"] = serde_json::json!(emotion);
    }
    if let Some(en) = params.english_normalization {
        voice_setting["english_normalization"] = serde_json::json!(en);
    }

    let mut audio_setting = serde_json::json!({});
    if let Some(sample_rate) = params.sample_rate {
        audio_setting["audio_sample_rate"] = serde_json::json!(sample_rate);
    }
    if let Some(bitrate) = params.bitrate {
        audio_setting["bitrate"] = serde_json::json!(bitrate);
    }
    if let Some(ref format) = params.audio_format {
        audio_setting["format"] = serde_json::json!(format);
    }
    if let Some(channel) = params.channel {
        audio_setting["channel"] = serde_json::json!(channel);
    }

    // Build voice_modify if any of its fields are present
    let mut has_voice_modify = false;
    let mut voice_modify = serde_json::json!({});
    if let Some(vmp) = params.voice_modify_pitch {
        voice_modify["pitch"] = serde_json::json!(vmp);
        has_voice_modify = true;
    }
    if let Some(vmi) = params.voice_modify_intensity {
        voice_modify["intensity"] = serde_json::json!(vmi);
        has_voice_modify = true;
    }
    if let Some(vmt) = params.voice_modify_timbre {
        voice_modify["timbre"] = serde_json::json!(vmt);
        has_voice_modify = true;
    }
    if let Some(se) = &params.voice_modify_sound_effects {
        voice_modify["sound_effects"] = serde_json::json!(se);
        has_voice_modify = true;
    }

    let mut payload = serde_json::json!({
        "model": params.model,
        "text": params.text,
        "voice_setting": voice_setting,
        "audio_setting": audio_setting,
    });
    if let Some(ref language_boost) = params.language_boost {
        payload["language_boost"] = serde_json::json!(language_boost);
    }
    if has_voice_modify {
        payload["voice_modify"] = voice_modify;
    }
    if let Some(tone_list) = &params.pronunciation_tone {
        if !tone_list.is_empty() {
            payload["pronunciation_dict"] = serde_json::json!({ "tone": tone_list });
        }
    }
    if let Some(aw) = params.aigc_watermark {
        payload["aigc_watermark"] = serde_json::json!(aw);
    }

    let resp = client
        .post(format!("{}/v1/t2a_async_v2", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "MiniMax create API error {}: {}",
            status,
            truncate_body(&body)
        ));
    }

    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        format!(
            "MiniMax create response is not valid JSON: {} | body: {}",
            e,
            truncate_body(&body)
        )
    })?;
    parse_minimax_create_response(&data).map_err(|e| {
        format!(
            "{} | http_status: {} | response: {}",
            e,
            status,
            truncate_body(&body)
        )
    })
}

/// Parse a MiniMax t2a_async_v2 create response.
/// MiniMax returns HTTP 200 even for create-time errors (the error is in `base_resp`);
/// a non-zero `base_resp.status_code` or a missing `task_id` is treated as failure.
fn parse_minimax_create_response(data: &serde_json::Value) -> Result<MinimaxCreateResult, String> {
    let base_resp = data.get("base_resp");
    let status_code = base_resp
        .and_then(|b| b.get("status_code"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if status_code != 0 {
        let msg = base_resp
            .and_then(|b| b.get("status_msg"))
            .and_then(|v| v.as_str())
            .unwrap_or("MiniMax create error");
        return Err(format!("MiniMax create error (code {}): {}", status_code, msg));
    }

    let task_id = data
        .get("task_id")
        .and_then(extract_task_id)
        .or_else(|| {
            data.get("data")
                .and_then(|d| d.get("task_id"))
                .and_then(extract_task_id)
        })
        .unwrap_or_default();
    if task_id.is_empty() {
        return Err("MiniMax create response missing task_id".to_string());
    }

    let file_id = extract_file_id(data);
    Ok(MinimaxCreateResult { task_id, file_id })
}

/// Query a MiniMax TTS task via GET /v1/query/t2a_async_query_v2?task_id=.
async fn minimax_query_task_http(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    task_id: &str,
) -> Result<MinimaxTaskStatus, String> {
    let resp = client
        .get(format!("{}/v1/query/t2a_async_query_v2", base_url))
        .query(&[("task_id", task_id)])
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("API error {}: {}", status, body));
    }

    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(parse_minimax_task_status(&data))
}

/// Download a generated audio file via GET /v1/files/retrieve_content?file_id= (Bearer, binary).
async fn minimax_download_audio(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    file_id: i64,
    project_path: &str,
    task_id: &str,
) -> Result<DownloadResult, String> {
    let output_dir = PathBuf::from(project_path).join("Generated").join("Audio");
    // Phase 1: store locally as mp3 (MiniMax default). The chosen format still drives the API request.
    let extension = "mp3";
    let output_path = output_dir.join(format!("{}.{}", task_id, extension));

    let resp = client
        .get(format!("{}/v1/files/retrieve_content", base_url))
        .query(&[("file_id", &file_id.to_string())])
        .header("Authorization", format!("Bearer {}", api_key))
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
            return Err(format!("Audio too large: {} bytes (max {} MB)", len, MAX_DOWNLOAD_SIZE / 1024 / 1024));
        }
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Failed to read response body: {}", e))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_SIZE {
        return Err(format!("Audio too large: {} bytes (max {} MB)", bytes.len(), MAX_DOWNLOAD_SIZE / 1024 / 1024));
    }

    // MiniMax /v1/files/retrieve_content returns a *tar archive* bundling the audio
    // (content-*.mp3) alongside .extra / .titles metadata sidecars. Writing the raw
    // archive as .mp3 produces a file that GStreamer's discoverer rejects (it sees a
    // tar container, not an audio frame), so the asset ends up with no duration and
    // the GES preview pipeline cannot decode it → silent playback. Extract the audio
    // entry here; fall back to the raw bytes when the response is already a bare audio
    // file (e.g. a proxy that unwraps the archive).
    let payload = extract_audio_payload(&bytes)?;
    let file_size = payload.len() as u64;
    let output_dir_clone = output_dir.clone();
    let output_path_clone = output_path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&output_dir_clone).map_err(|e| format!("Failed to create directory: {}", e))?;
        std::fs::write(&output_path_clone, &payload).map_err(|e| format!("Failed to write file: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(DownloadResult {
        file_path: output_path.to_string_lossy().to_string(),
        file_size,
    })
}

/// Extract the audio bytes from a MiniMax download response.
///
/// MiniMax wraps the audio in a tar archive (entries: `content-*.mp3`, `*.extra`,
/// `*.titles`). When the body is a tar archive, pick the `.mp3` entry (falling back to
/// the largest non-sidecar entry if no `.mp3` is present). When the body is not a tar
/// archive (already a bare audio file, or a proxy that unwrapped it), return it as-is.
fn extract_audio_payload(bytes: &[u8]) -> Result<Vec<u8>, String> {
    // A tar archive's header has the `ustar` magic at byte offset 257. Use that to
    // cheaply decide whether to attempt archive parsing, so a bare mp3 (whose byte 257
    // is just audio data) is never misread.
    let is_tar = bytes.len() >= 265 && &bytes[257..262] == b"ustar";
    if !is_tar {
        return Ok(bytes.to_vec());
    }

    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let entries = archive
        .entries()
        .map_err(|e| format!("Failed to read MiniMax tar archive: {e}"))?;

    // Prefer an explicit .mp3 entry; otherwise pick the largest entry that isn't a
    // known metadata sidecar (.extra / .titles).
    let mut best_fallback: Option<(usize, Vec<u8>)> = None;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Failed to read tar entry: {e}"))?;
        let path = entry.path().map_err(|e| format!("Invalid tar entry path: {e}"))?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        if name.ends_with(".extra") || name.ends_with(".titles") {
            continue;
        }

        let size = entry.size() as usize;
        if size as u64 > MAX_DOWNLOAD_SIZE {
            return Err(format!(
                "Audio too large: {} bytes (max {} MB)",
                size,
                MAX_DOWNLOAD_SIZE / 1024 / 1024
            ));
        }

        if name.ends_with(".mp3") {
            let mut buf = Vec::with_capacity(size);
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read mp3 from tar: {e}"))?;
            return Ok(buf);
        }

        if best_fallback.as_ref().is_none_or(|(s, _)| size > *s) {
            let mut buf = Vec::with_capacity(size);
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read tar entry: {e}"))?;
            best_fallback = Some((size, buf));
        }
    }

    best_fallback
        .map(|(_, buf)| buf)
        .ok_or_else(|| "MiniMax tar archive contained no audio entry".to_string())
}

/// Fetch available voices via POST /v1/get_voice (body: voice_type=all).
async fn minimax_get_voices_http(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
) -> Result<MinimaxGetVoicesResult, String> {
    let payload = serde_json::json!({ "voice_type": "all" });

    let resp = client
        .post(format!("{}/v1/get_voice", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("API error {}: {}", status, body));
    }

    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    let mut voices: Vec<MinimaxVoice> = Vec::new();
    // MiniMax groups voices into system_voice / voice_clone / voice_generation.
    for (key, voice_type) in [
        ("system_voice", "system"),
        ("voice_clone", "clone"),
        ("voice_generation", "generated"),
    ] {
        if let Some(arr) = data.get(key).and_then(|v| v.as_array()) {
            for item in arr {
                let voice_id = item.get("voice_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if voice_id.is_empty() {
                    continue;
                }
                voices.push(MinimaxVoice {
                    voice_id,
                    name: item.get("voice_name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    description: item.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    voice_type: Some(voice_type.to_string()),
                    status: item.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
                });
            }
        }
    }

    Ok(MinimaxGetVoicesResult { voices })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> MinimaxTaskStatus {
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        parse_minimax_task_status(&v)
    }

    #[test]
    fn success_top_level_file_id() {
        let s = parse(r#"{"status":"Success","file_id":12345,"base_resp":{"status_code":0}}"#);
        assert_eq!(s.status, "success");
        assert_eq!(s.file_id, Some(12345));
        assert_eq!(s.error_msg, None);
    }

    #[test]
    fn success_data_file_id_string() {
        let s = parse(r#"{"status":"success","data":{"file_id":"67890"},"base_resp":{"status_code":0}}"#);
        assert_eq!(s.status, "success");
        assert_eq!(s.file_id, Some(67890));
    }

    #[test]
    fn processing_no_file_id() {
        let s = parse(r#"{"status":"Processing","base_resp":{"status_code":0}}"#);
        assert_eq!(s.status, "processing");
        assert_eq!(s.file_id, None);
    }

    #[test]
    fn failed_status() {
        let s = parse(r#"{"status":"Failed","base_resp":{"status_code":0}}"#);
        assert_eq!(s.status, "failed");
    }

    #[test]
    fn failed_base_resp_nonzero_uses_status_msg() {
        let s = parse(r#"{"status":"Processing","base_resp":{"status_code":1001,"status_msg":"invalid voice_id"}}"#);
        assert_eq!(s.status, "failed");
        assert_eq!(s.error_msg.as_deref(), Some("invalid voice_id"));
    }

    #[test]
    fn expired_lowercase() {
        let s = parse(r#"{"status":"expired","base_resp":{"status_code":0}}"#);
        assert_eq!(s.status, "expired");
    }

    #[test]
    fn case_insensitive_success() {
        let s = parse(r#"{"status":"SUCCESS","file_id":1,"base_resp":{"status_code":0}}"#);
        assert_eq!(s.status, "success");
        assert_eq!(s.file_id, Some(1));
    }

    fn parse_create(json: &str) -> Result<MinimaxCreateResult, String> {
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        parse_minimax_create_response(&v)
    }

    #[test]
    fn create_success_with_task_id() {
        let r = parse_create(r#"{"task_id":"abc","base_resp":{"status_code":0}}"#).unwrap();
        assert_eq!(r.task_id, "abc");
        assert_eq!(r.file_id, None);
    }

    #[test]
    fn create_base_resp_error_is_err() {
        let err = parse_create(r#"{"base_resp":{"status_code":1001,"status_msg":"invalid voice_id"}}"#).unwrap_err();
        assert!(err.contains("1001"), "{}", err);
        assert!(err.contains("invalid voice_id"), "{}", err);
    }

    #[test]
    fn create_missing_task_id_is_err() {
        let err = parse_create(r#"{"base_resp":{"status_code":0}}"#).unwrap_err();
        assert!(err.contains("missing task_id"), "{}", err);
    }

    #[test]
    fn create_data_nested_task_id() {
        let r = parse_create(r#"{"data":{"task_id":"xyz"},"base_resp":{"status_code":0}}"#).unwrap();
        assert_eq!(r.task_id, "xyz");
    }

    #[test]
    fn create_success_with_numeric_task_id() {
        // MiniMax returns task_id as a JSON number. Regression: parsing it as a string only
        // caused a false "missing task_id" error despite a 200 + status_code:0 response.
        let r = parse_create(
            r#"{"task_id":415799063728442,"file_id":415799063728442,"base_resp":{"status_code":0,"status_msg":"success"}}"#,
        )
        .unwrap();
        assert_eq!(r.task_id, "415799063728442");
        assert_eq!(r.file_id, Some(415799063728442));
    }

    // ── extract_audio_payload ──

    /// Build an in-memory tar archive mirroring MiniMax's /v1/files/retrieve_content
    /// output: a content-*.mp3 plus .extra / .titles sidecars under a nested directory.
    fn build_minimax_tar(mp3: &[u8], extra: &[u8], titles: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut buf);
            let prefix = "content-1915426947035309031_202607031953_415805408354728_415805408354729";
            let mut add = |name: &str, data: &[u8]| {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, name, std::io::Cursor::new(data))
                    .expect("append tar entry");
            };
            add(&format!("{prefix}.mp3"), mp3);
            add(&format!("{prefix}.extra"), extra);
            add(&format!("{prefix}.titles"), titles);
            builder.finish().expect("finalize tar");
            // Drop the borrow on `buf` before returning it.
            let _ = builder.into_inner();
        }
        buf
    }

    #[test]
    fn extract_audio_payload_unwraps_tar_and_picks_mp3() {
        let mp3 = [0xFFu8, 0xFB, 0x90, 0x00]; // mp3 frame sync + dummy data
        let archive = build_minimax_tar(&mp3, b"extra-meta", b"titles-meta");

        let payload = extract_audio_payload(&archive).expect("should extract mp3");
        assert_eq!(payload, mp3);
    }

    #[test]
    fn extract_audio_payload_passes_through_bare_audio() {
        // A real mp3 file is not a tar archive — must be returned unchanged.
        let bare = [0xFFu8, 0xFB, 0x90, 0x00, 0x01, 0x02, 0x03];
        let payload = extract_audio_payload(&bare).expect("bare audio passes through");
        assert_eq!(payload, bare);
    }

    #[test]
    fn extract_audio_payload_rejects_tar_without_audio() {
        // Only sidecar entries → no audio to extract.
        let mut buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut buf);
            let mut add = |name: &str, data: &[u8]| {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, name, std::io::Cursor::new(data))
                    .unwrap();
            };
            add("content-1.extra", b"extra-meta");
            add("content-1.titles", b"titles-meta");
            builder.finish().unwrap();
            let _ = builder.into_inner();
        }
        let err = extract_audio_payload(&buf).unwrap_err();
        assert!(err.contains("no audio entry"), "{}", err);
    }

    #[test]
    fn extract_audio_payload_falls_back_to_largest_non_sidecar() {
        // No .mp3 entry, but a .wav entry should be picked as the largest non-sidecar.
        let wav = vec![0x52u8, 0x49, 0x46, 0x46]; // "RIFF"
        let archive = {
            let mut buf = Vec::new();
            let mut builder = tar::Builder::new(&mut buf);
            let mut add = |name: &str, data: &[u8]| {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, name, std::io::Cursor::new(data))
                    .unwrap();
            };
            add("content-1.extra", b"x");
            add("content-1.titles", b"t");
            add("content-1.wav", &wav);
            builder.finish().unwrap();
            let _ = builder.into_inner();
            buf
        };
        let payload = extract_audio_payload(&archive).expect("fallback picks wav");
        assert_eq!(payload, wav);
    }
}
