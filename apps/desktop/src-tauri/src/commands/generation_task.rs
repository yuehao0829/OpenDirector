use super::util::MAX_DOWNLOAD_SIZE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::Hash;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use super::generation_log::{GenerationLogManager, LogContext};
use super::poll_utils::adaptive_poll_interval;
use super::seedance_api::{
    url_encode_query, CreateTaskResult, DownloadResult, SeedanceContentItem, SeedanceState,
    TaskStatusResult, UploadResult,
};

/// A local reference that needs to be uploaded (base64-encoded) before creating
/// the remote task.
#[derive(Deserialize)]
pub struct LocalReference {
    /// Index into the `content` array whose `url` field should be replaced with
    /// the resulting `file_id`.
    pub content_index: usize,
    /// Absolute path to the local file on disk.
    pub file_path: String,
}

/// Parameters passed from JS to `seedance_start_generation`.
#[derive(Deserialize)]
pub struct StartGenerationParams {
    pub task_id: String,
    pub provider_id: String,
    pub password: String,
    pub model: String,
    pub content: Vec<SeedanceContentItem>,
    pub resolution: String,
    pub ratio: String,
    pub duration: i32,
    pub generate_audio: bool,
    pub return_last_frame: Option<bool>,
    pub local_references: Vec<LocalReference>,
    pub project_path: String,
    /// Passthrough for future API params (callback_url, seed, watermark, etc.)
    pub extra_params: Option<HashMap<String, serde_json::Value>>,
    pub fragment_id: String,
}

/// Event payload emitted over `generation:status`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum GenerationEvent {
    #[serde(rename = "created")]
    Created {
        task_id: String,
        api_task_id: String,
        project_path: Option<String>,
    },
    #[serde(rename = "download_progress")]
    DownloadProgress { task_id: String },
    #[serde(rename = "completed")]
    Completed {
        task_id: String,
        api_task_id: String,
        file_path: String,
        file_size: u64,
        video_url: String,
        last_frame_url: Option<String>,
        project_path: Option<String>,
    },
    #[serde(rename = "failed")]
    Failed {
        task_id: String,
        error: String,
        project_path: Option<String>,
    },
    #[serde(rename = "cancelled")]
    Cancelled {
        task_id: String,
        project_path: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Poll coordinator
// ---------------------------------------------------------------------------

#[derive(Hash, Eq, PartialEq, Clone)]
struct CredentialGroupKey {
    api_key: String,
    base_url: String,
}

enum PollOutcome {
    Succeeded {
        video_url: String,
        last_frame_url: Option<String>,
    },
    Failed(String), // error message
    Cancelled,
}

#[allow(dead_code)]
struct RegisteredTask {
    task_id: String,     // local JS task ID
    api_task_id: String, // remote API task ID
    cred_group: CredentialGroupKey,
    /// When dropped without sending, the receiver treats it as a shutdown signal
    /// (not cancellation) and exits gracefully, leaving the pending task file for recovery.
    result_tx: oneshot::Sender<PollOutcome>,
    cancel_rx: watch::Receiver<bool>,
    registered_at: tokio::time::Instant,
    project_path: String,
}

struct GenerationHandle {
    cancel_tx: watch::Sender<bool>,
    _join_handle: JoinHandle<()>,
}

pub struct GenerationTaskManager {
    tasks: Arc<tokio::sync::Mutex<HashMap<String, GenerationHandle>>>,
    coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask>>>,
    coordinator_notify: mpsc::Sender<()>,
    _coordinator_join: tauri::async_runtime::JoinHandle<()>,
    log_manager: Arc<GenerationLogManager>,
}

impl GenerationTaskManager {
    pub fn new(app: AppHandle, client: reqwest::Client, log_manager: GenerationLogManager) -> Self {
        let (notify_tx, mut notify_rx) = mpsc::channel::<()>(32);
        let coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        let log_mgr = Arc::new(log_manager);
        let coord_tasks = coordinator_tasks.clone();
        let coord_log = log_mgr.clone();
        let coord_join = tauri::async_runtime::spawn(async move {
            coordinator_loop(app, client, coord_tasks, &mut notify_rx, coord_log).await;
        });

        Self {
            tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            coordinator_tasks,
            coordinator_notify: notify_tx,
            _coordinator_join: coord_join,
            log_manager: log_mgr,
        }
    }
}

// ---------------------------------------------------------------------------
// Pending task persistence
// ---------------------------------------------------------------------------

fn pending_tasks_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("Cannot resolve app data dir")
        .join("com.opendirector")
        .join("generation_tasks")
}

fn pending_tasks_dir_ensure(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = pending_tasks_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create pending tasks dir: {}", e))?;
    Ok(dir)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PendingTaskStatus {
    Pending,
    Completed,
    Failed,
}

impl Default for PendingTaskStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingTaskRecord {
    pub task_id: String,
    pub api_task_id: String,
    pub provider_id: String,
    #[serde(default)]
    pub fragment_id: String,
    #[serde(default)]
    pub model: String,
    pub project_path: String,
    pub registered_at_epoch_ms: i64,
    #[serde(default)]
    pub status: PendingTaskStatus,
    #[serde(default)]
    pub outcome_video_path: Option<String>,
    #[serde(default)]
    pub outcome_video_url: Option<String>,
    #[serde(default)]
    pub outcome_last_frame_url: Option<String>,
    #[serde(default)]
    pub outcome_file_size: Option<u64>,
    #[serde(default)]
    pub outcome_error: Option<String>,
}

/// Atomically write a pending task record (tmp + rename).
fn write_pending_task(app: &AppHandle, record: &PendingTaskRecord) -> Result<(), String> {
    let dir = pending_tasks_dir_ensure(app)?;
    let path = dir.join(format!("{}.json", record.task_id));
    let json = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json).map_err(|e| format!("Failed to write: {}", e))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(())
}

fn delete_pending_task(app: &AppHandle, task_id: &str) -> Result<(), String> {
    let path = pending_tasks_dir(app).join(format!("{}.json", task_id));
    match std::fs::remove_file(&path) {
        Ok(()) | Err(_) => Ok(()), // NotFound is fine — already cleaned up
    }
}

fn load_pending_task(app: &AppHandle, task_id: &str) -> Result<PendingTaskRecord, String> {
    let path = pending_tasks_dir(app).join(format!("{}.json", task_id));
    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read pending task: {}", e))?;
    serde_json::from_str(&json).map_err(|e| format!("Invalid pending task JSON: {}", e))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn seedance_start_generation(
    app: AppHandle,
    state: tauri::State<'_, SeedanceState>,
    manager: tauri::State<'_, GenerationTaskManager>,
    params: StartGenerationParams,
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
        run_generation_lifecycle(
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
        GenerationHandle {
            cancel_tx,
            _join_handle: handle,
        },
    );

    Ok(task_id)
}

#[tauri::command]
pub async fn seedance_cancel_generation(
    manager: tauri::State<'_, GenerationTaskManager>,
    task_id: String,
) -> Result<bool, String> {
    let tasks = manager.tasks.lock().await;
    if let Some(handle) = tasks.get(&task_id) {
        let _ = handle.cancel_tx.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn seedance_list_pending_tasks(app: AppHandle) -> Result<Vec<PendingTaskRecord>, String> {
    let dir = pending_tasks_dir(&app);
    let mut records = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(records), // Directory doesn't exist yet — no pending tasks
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(json) = std::fs::read_to_string(&path) {
                if let Ok(record) = serde_json::from_str::<PendingTaskRecord>(&json) {
                    records.push(record);
                }
            }
        }
    }
    Ok(records)
}

#[tauri::command]
pub async fn seedance_resume_generation(
    app: AppHandle,
    state: tauri::State<'_, SeedanceState>,
    manager: tauri::State<'_, GenerationTaskManager>,
    task_id: String,
    password: String,
) -> Result<bool, String> {
    let record = load_pending_task(&app, &task_id)?;

    // ── Status fast-path: skip re-polling for already-resolved tasks ──

    if record.status == PendingTaskStatus::Completed {
        if let Some(ref video_path) = record.outcome_video_path {
            if std::path::Path::new(video_path).exists() {
                eprintln!(
                    "[GenerationTask] Re-emitting completed event for task {} (video exists)",
                    record.task_id
                );
                let _ = app.emit(
                    "generation:status",
                    GenerationEvent::Completed {
                        task_id: record.task_id.clone(),
                        api_task_id: record.api_task_id.clone(),
                        file_path: record.outcome_video_path.clone().unwrap_or_default(),
                        file_size: record.outcome_file_size.unwrap_or(0),
                        video_url: record.outcome_video_url.clone().unwrap_or_default(),
                        last_frame_url: record.outcome_last_frame_url.clone(),
                        project_path: Some(record.project_path.clone()),
                    },
                );
                return Ok(true);
            }
        }
        eprintln!(
            "[GenerationTask] Completed task {} has missing video file, re-downloading",
            record.task_id
        );
    }

    if record.status == PendingTaskStatus::Failed {
        eprintln!(
            "[GenerationTask] Re-emitting failed event for task {}",
            record.task_id
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
        return Ok(true);
    }

    let (api_key, base_url) =
        super::seedance_api::get_ark_api_key_and_base_url(&record.provider_id, &password)?;

    let cred_group = CredentialGroupKey { api_key, base_url };

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (result_tx, result_rx) = oneshot::channel();

    // Compute registered_at from the original epoch to preserve adaptive
    // poll interval behaviour (a task that already ran 5 min should use
    // the 20 s interval, not start over from 10 s).
    let registered_at: tokio::time::Instant = {
        let elapsed_ms = chrono::Utc::now().timestamp_millis() - record.registered_at_epoch_ms;
        let elapsed = Duration::from_millis(elapsed_ms.max(0) as u64);
        tokio::time::Instant::now() - elapsed
    };

    let registered = RegisteredTask {
        task_id: task_id.clone(),
        api_task_id: record.api_task_id.clone(),
        cred_group,
        result_tx,
        cancel_rx,
        registered_at,
        project_path: record.project_path.clone(),
    };

    {
        let mut coord = manager.coordinator_tasks.lock().await;
        coord.insert(task_id.clone(), registered);
    }
    let _ = manager.coordinator_notify.try_send(());

    let client = state.http.clone();
    let tasks = manager.tasks.clone();
    let log_mgr = manager.log_manager.clone();
    let app_clone = app.clone();
    let record_for_outcome = record.clone();
    let task_id_for_cleanup = task_id.clone();

    let handle = tokio::spawn(async move {
        let outcome = match result_rx.await {
            Ok(outcome) => outcome,
            Err(_) => {
                eprintln!(
                    "[GenerationTask] result_tx dropped for resumed task {} — app shutdown, keeping pending file",
                    task_id_for_cleanup
                );
                tasks.lock().await.remove(&task_id_for_cleanup);
                return;
            }
        };

        handle_poll_outcome(&app_clone, &client, &record_for_outcome, outcome, &log_mgr);
        tasks.lock().await.remove(&task_id_for_cleanup);
    });

    manager.tasks.lock().await.insert(
        task_id.clone(),
        GenerationHandle {
            cancel_tx,
            _join_handle: handle,
        },
    );

    Ok(true)
}

/// Called by the frontend after it has fully processed a completed/failed event.
/// Deletes the persisted task record since the frontend no longer needs recovery.
#[tauri::command]
pub async fn seedance_acknowledge_task(app: AppHandle, task_id: String) -> Result<(), String> {
    delete_pending_task(&app, &task_id)
}

/// Batch query task statuses from the ARK API.
#[tauri::command]
pub async fn seedance_batch_query_tasks(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    task_ids: Vec<String>,
) -> Result<Vec<TaskStatusResult>, String> {
    let (api_key, base_url) =
        super::seedance_api::get_ark_api_key_and_base_url(&provider_id, &password)?;

    let cred_key = CredentialGroupKey { api_key, base_url };

    batch_query_tasks(&state.http, &cred_key, &task_ids).await
}

// ---------------------------------------------------------------------------
// Per-task lifecycle
// ---------------------------------------------------------------------------

async fn run_generation_lifecycle(
    app: AppHandle,
    client: reqwest::Client,
    provider_id: &str,
    password: &str,
    params: StartGenerationParams,
    cancel_rx: watch::Receiver<bool>,
    coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask>>>,
    coordinator_notify: mpsc::Sender<()>,
    log_mgr: &Arc<GenerationLogManager>,
) {
    let task_id = params.task_id.clone();
    let project_path = params.project_path.clone();

    let (api_key, base_url) =
        match super::seedance_api::get_ark_api_key_and_base_url(provider_id, password) {
            Ok(creds) => creds,
            Err(e) => {
                LogContext::new(log_mgr, &project_path)
                    .error(
                        "credentials_error",
                        &format!("Failed to get credentials: {}", e),
                    )
                    .task_id(&task_id)
                    .data(serde_json::json!({ "error": e }))
                    .log();
                let _ = app.emit(
                    "generation:status",
                    GenerationEvent::Failed {
                        task_id: task_id.clone(),
                        error: e.clone(),
                        project_path: Some(params.project_path.clone()),
                    },
                );
                return;
            }
        };

    let cred_group = CredentialGroupKey {
        api_key: api_key.clone(),
        base_url: base_url.clone(),
    };

    // Resolve local references (upload → base64 file_id)
    let mut content = params.content.clone();
    if let Err(e) =
        resolve_local_references(&mut content, &params.local_references, &params.project_path).await
    {
        LogContext::new(log_mgr, &project_path)
            .error(
                "reference_resolve_error",
                &format!("Failed to resolve local references: {}", e),
            )
            .task_id(&task_id)
            .data(serde_json::json!({ "error": e }))
            .log();
        let _ = app.emit(
            "generation:status",
            GenerationEvent::Failed {
                task_id: task_id.clone(),
                error: e,
                project_path: Some(params.project_path.clone()),
            },
        );
        return;
    }

    // Build content detail after resolution (reflects what was actually sent)
    let content_detail: Vec<serde_json::Value> = content
        .iter()
        .map(|c| {
            let mut item = serde_json::json!({
                "type": c.item_type,
            });
            if let Some(role) = &c.role {
                item["role"] = serde_json::json!(role);
            }
            if let Some(text) = &c.text {
                item["text"] = serde_json::json!(text);
            }
            if let Some(url_field) = c.url_field() {
                item["url"] = serde_json::json!(sanitize_url(&url_field.url));
            }
            item
        })
        .collect();

    LogContext::new(log_mgr, &project_path)
        .info("lifecycle_start", "Generation lifecycle started")
        .task_id(&task_id)
        .data(serde_json::json!({
            "provider_id": provider_id,
            "model": params.model,
            "fragment_id": params.fragment_id,
            "resolution": params.resolution,
            "ratio": params.ratio,
            "duration": params.duration,
            "generate_audio": params.generate_audio,
            "return_last_frame": params.return_last_frame,
            "content": content_detail,
        }))
        .log();

    // Create remote task
    let create_start = std::time::Instant::now();
    let api_task_id = match create_task_http(
        &client,
        &api_key,
        &base_url,
        params.model.clone(),
        content,
        params.resolution.clone(),
        params.ratio.clone(),
        params.duration,
        params.generate_audio,
        params.return_last_frame,
        &params.extra_params,
    )
    .await
    {
        Ok(r) => {
            let elapsed = create_start.elapsed().as_millis() as u64;
            LogContext::new(log_mgr, &project_path)
                .info("api_create_task_response", "Created Seedance API task")
                .task_id(&task_id)
                .duration_ms(elapsed)
                .data(serde_json::json!({
                    "api_task_id": r.task_id,
                    "status": r.status,
                    "created_at": r.created_at,
                }))
                .log();
            r.task_id
        }
        Err(e) => {
            LogContext::new(log_mgr, &project_path)
                .error(
                    "api_create_task_error",
                    &format!("API create task failed: {}", e),
                )
                .task_id(&task_id)
                .data(serde_json::json!({ "error": e }))
                .log();
            let _ = app.emit(
                "generation:status",
                GenerationEvent::Failed {
                    task_id: task_id.clone(),
                    error: e,
                    project_path: Some(params.project_path.clone()),
                },
            );
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
    };
    if let Err(e) = write_pending_task(&app, &pending_record) {
        eprintln!("[GenerationTask] Failed to save pending task record: {}", e);
    }

    LogContext::new(log_mgr, &project_path)
        .info("pending_task_saved", "Pending task record saved")
        .task_id(&task_id)
        .data(serde_json::json!({ "api_task_id": api_task_id }))
        .log();

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

    // result_rx returns Err when result_tx is dropped without sending (app shutdown).
    // The server task is still running — exit gracefully so the pending task file
    // remains on disk for restoreProjectGenerations to pick up on next launch.
    let outcome = match result_rx.await {
        Ok(outcome) => outcome,
        Err(_) => {
            eprintln!(
                "[GenerationTask] result_tx dropped for task {} — app shutdown, keeping pending file",
                task_id
            );
            LogContext::new(log_mgr, &project_path)
                .warn(
                    "lifecycle_shutdown",
                    "Lifecycle exited due to app shutdown, pending file preserved",
                )
                .task_id(&task_id)
                .log();
            return;
        }
    };

    handle_poll_outcome(&app, &client, &pending_record, outcome, log_mgr);
}

/// Persist a failed outcome to disk, then emit the Failed event.
fn persist_and_emit_failed(app: &AppHandle, record: &PendingTaskRecord, error: String) {
    let mut updated = record.clone();
    updated.status = PendingTaskStatus::Failed;
    updated.outcome_error = Some(error.clone());
    if let Err(e) = write_pending_task(app, &updated) {
        eprintln!("[GenerationTask] Failed to persist failed status: {}", e);
    }
    let _ = app.emit(
        "generation:status",
        GenerationEvent::Failed {
            task_id: record.task_id.clone(),
            error,
            project_path: Some(record.project_path.clone()),
        },
    );
}

/// Persist outcome, then emit events. If the app crashes after persisting but
/// before emitting, the next restart can recover from the record.
fn handle_poll_outcome(
    app: &AppHandle,
    client: &reqwest::Client,
    record: &PendingTaskRecord,
    outcome: PollOutcome,
    log_mgr: &Arc<GenerationLogManager>,
) {
    match outcome {
        PollOutcome::Succeeded {
            video_url,
            last_frame_url,
        } => {
            let _ = app.emit(
                "generation:status",
                GenerationEvent::DownloadProgress {
                    task_id: record.task_id.clone(),
                },
            );

            LogContext::new(log_mgr, &record.project_path)
                .info("download_start", "Starting video download")
                .task_id(&record.task_id)
                .log();

            let rt = tokio::runtime::Handle::current();
            let app = app.clone();
            let client = client.clone();
            let mut updated_record = record.clone();
            let project_path = record.project_path.clone();
            let log_mgr = log_mgr.clone();
            rt.spawn(async move {
                let download_start = std::time::Instant::now();
                eprintln!(
                    "[GenerationTask] Downloading video for task {} to project {}",
                    updated_record.task_id, project_path
                );
                match download_video_http(
                    &client,
                    &video_url,
                    &project_path,
                    &updated_record.task_id,
                )
                .await
                {
                    Ok(result) => {
                        let download_ms = download_start.elapsed().as_millis() as u64;
                        eprintln!(
                            "[GenerationTask] Download complete: {} ({} bytes) for task {}",
                            result.file_path, result.file_size, updated_record.task_id
                        );
                        LogContext::new(&log_mgr, &project_path)
                            .info("download_success", "Video download complete")
                            .task_id(&updated_record.task_id)
                            .duration_ms(download_ms)
                            .data(serde_json::json!({
                                "file_path": result.file_path,
                                "file_size": result.file_size,
                            }))
                            .log();
                        updated_record.status = PendingTaskStatus::Completed;
                        updated_record.outcome_video_path = Some(result.file_path.clone());
                        updated_record.outcome_video_url = Some(video_url.clone());
                        updated_record.outcome_last_frame_url = last_frame_url.clone();
                        updated_record.outcome_file_size = Some(result.file_size);
                        if let Err(e) = write_pending_task(&app, &updated_record) {
                            eprintln!("[GenerationTask] Failed to persist completed status: {}", e);
                        }
                        let _ = app.emit(
                            "generation:status",
                            GenerationEvent::Completed {
                                task_id: updated_record.task_id.clone(),
                                api_task_id: updated_record.api_task_id.clone(),
                                file_path: result.file_path,
                                file_size: result.file_size,
                                video_url,
                                last_frame_url,
                                project_path: Some(updated_record.project_path.clone()),
                            },
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[GenerationTask] Download failed for task {}: {}",
                            updated_record.task_id, e
                        );
                        LogContext::new(&log_mgr, &project_path)
                            .error("download_failed", &format!("Download failed: {}", e))
                            .task_id(&updated_record.task_id)
                            .data(serde_json::json!({ "error": e }))
                            .log();
                        persist_and_emit_failed(
                            &app,
                            &updated_record,
                            format!("Download failed: {}", e),
                        );
                    }
                }
            });
        }
        PollOutcome::Failed(err) => {
            LogContext::new(log_mgr, &record.project_path)
                .error("poll_failed", &format!("Generation failed: {}", err))
                .task_id(&record.task_id)
                .data(serde_json::json!({ "error": err }))
                .log();
            persist_and_emit_failed(app, record, err);
        }
        PollOutcome::Cancelled => {
            LogContext::new(log_mgr, &record.project_path)
                .info("poll_cancelled", "Generation cancelled")
                .task_id(&record.task_id)
                .log();
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
// Coordinator loop
// ---------------------------------------------------------------------------

struct TaskSnapshot {
    task_id: String,
    api_task_id: String,
    registered_at: tokio::time::Instant,
    project_path: String,
}

async fn coordinator_loop(
    app: AppHandle,
    client: reqwest::Client,
    tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask>>>,
    notify_rx: &mut mpsc::Receiver<()>,
    log_mgr: Arc<GenerationLogManager>,
) {
    // Track last known status + last log time per task_id
    // to reduce log volume: log on status change, or at most every 60s otherwise
    let mut last_status: HashMap<String, (String, std::time::Instant)> = HashMap::new();
    let periodic_log_interval = std::time::Duration::from_secs(60);

    loop {
        // Wait until at least one task is registered
        {
            let t = tasks.lock().await;
            if t.is_empty() {
                drop(t);
                match notify_rx.recv().await {
                    Some(()) => {}
                    None => return,
                }
            }
        }

        // Build snapshot, collect cancelled task IDs (deferred fs cleanup)
        let (cancelled_task_ids, snapshot, group_map): (
            Vec<(String, PathBuf)>, // (task_id, pending_file_path)
            Vec<TaskSnapshot>,
            HashMap<CredentialGroupKey, Vec<usize>>,
        ) = {
            let mut t = tasks.lock().await;
            let mut cancelled = Vec::new();
            let mut snap = Vec::new();
            let mut groups: HashMap<CredentialGroupKey, Vec<usize>> = HashMap::new();

            let keys: Vec<String> = t.keys().cloned().collect();
            for key in &keys {
                if let Some(reg) = t.get(key) {
                    if *reg.cancel_rx.borrow() {
                        let path = pending_tasks_dir(&app).join(format!("{}.json", key));
                        cancelled.push((key.clone(), path));
                    } else {
                        let idx = snap.len();
                        snap.push(TaskSnapshot {
                            task_id: key.clone(),
                            api_task_id: reg.api_task_id.clone(),
                            registered_at: reg.registered_at,
                            project_path: reg.project_path.clone(),
                        });
                        groups.entry(reg.cred_group.clone()).or_default().push(idx);
                    }
                }
            }

            // Remove cancelled tasks from the map — send Cancelled outcome first so
            // the lifecycle handler emits the proper event (not a shutdown silent-return).
            for (id, _) in &cancelled {
                if let Some(reg) = t.remove(id) {
                    let _ = reg.result_tx.send(PollOutcome::Cancelled);
                }
            }

            (cancelled, snap, groups)
        };

        // Deferred fs cleanup — outside the lock
        for (_, path) in &cancelled_task_ids {
            let _ = std::fs::remove_file(path);
        }

        if snapshot.is_empty() {
            continue;
        }

        eprintln!(
            "[Coordinator] Polling {} tasks across {} credential groups",
            snapshot.len(),
            group_map.len()
        );

        // Log coordinator cycle using project path from snapshot (no extra lock needed)
        if let Some(first_snap) = snapshot.first() {
            LogContext::new(&log_mgr, &first_snap.project_path)
                .info(
                    "coordinator_poll_cycle",
                    &format!(
                        "Polling {} tasks across {} groups",
                        snapshot.len(),
                        group_map.len()
                    ),
                )
                .data(serde_json::json!({
                    "task_count": snapshot.len(),
                    "group_count": group_map.len(),
                }))
                .log();
        }

        // Poll each credential group
        let mut completed_tasks: Vec<(String, PollOutcome)> = Vec::new();
        let mut min_registered_at = tokio::time::Instant::now();

        for (cred_key, indices) in &group_map {
            let cred_key = cred_key.clone();
            let api_task_ids: Vec<String> = indices
                .iter()
                .map(|&i| snapshot[i].api_task_id.clone())
                .collect();

            match batch_query_tasks(&client, &cred_key, &api_task_ids).await {
                Ok(statuses) => {
                    for (i, status) in statuses.into_iter().enumerate() {
                        let snap = &snapshot[*indices.get(i).unwrap_or(&0)];

                        // Track oldest task for sleep duration
                        if snap.registered_at < min_registered_at {
                            min_registered_at = snap.registered_at;
                        }

                        eprintln!(
                            "[Coordinator] Task {} (api: {}): status={}",
                            snap.task_id, snap.api_task_id, status.status
                        );

                        // Log on status change, or periodically (every 60s) to avoid high log volume
                        let status_key = status.status.clone();
                        let now = std::time::Instant::now();
                        let should_log = match last_status.get(&snap.task_id) {
                            Some((prev_key, last_log_time)) => {
                                prev_key != &status_key
                                    || now.duration_since(*last_log_time) >= periodic_log_interval
                            }
                            None => true,
                        };
                        if should_log {
                            last_status.insert(snap.task_id.clone(), (status_key, now));
                            LogContext::new(&log_mgr, &snap.project_path)
                                .info(
                                    "coordinator_task_status",
                                    &format!("Task status: {}", status.status),
                                )
                                .task_id(&snap.task_id)
                                .data(serde_json::json!({
                                    "api_task_id": snap.api_task_id,
                                    "status": status.status,
                                }))
                                .log();
                        }

                        match status.status.as_str() {
                            "succeeded" => {
                                let url = status.result_url.unwrap_or_default();
                                let last_frame = status.last_frame_url.clone();
                                completed_tasks.push((
                                    snap.task_id.clone(),
                                    PollOutcome::Succeeded {
                                        video_url: url,
                                        last_frame_url: last_frame,
                                    },
                                ));
                            }
                            "failed" => {
                                let err = status
                                    .error
                                    .map(|e| serde_json::to_string(&e).unwrap_or_default())
                                    .unwrap_or_else(|| "Generation failed".to_string());
                                completed_tasks
                                    .push((snap.task_id.clone(), PollOutcome::Failed(err)));
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[Coordinator] Batch query failed: {}", e);
                    if let Some(first_snap) = snapshot.first() {
                        LogContext::new(&log_mgr, &first_snap.project_path)
                            .error(
                                "coordinator_batch_query_error",
                                &format!("Batch query failed: {}", e),
                            )
                            .data(serde_json::json!({ "error": e }))
                            .log();
                    }
                }
            }
        }

        // Send outcomes and remove completed tasks
        if !completed_tasks.is_empty() {
            let mut t = tasks.lock().await;
            for (task_id, outcome) in completed_tasks {
                last_status.remove(&task_id);
                if let Some(reg) = t.remove(&task_id) {
                    let _ = reg.result_tx.send(outcome);
                }
            }
        }

        // Sleep with adaptive interval, computed from snapshot (no re-lock needed)
        let now = tokio::time::Instant::now();
        let min_elapsed = now.saturating_duration_since(min_registered_at).as_secs();
        let interval = adaptive_poll_interval(min_elapsed);
        let sleep_duration = std::cmp::max(
            Duration::from_secs(5),
            std::cmp::min(interval, Duration::from_secs(60)),
        );

        tokio::select! {
            _ = tokio::time::sleep(sleep_duration) => {}
            _ = notify_rx.recv() => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Batch query API
// ---------------------------------------------------------------------------

async fn batch_query_tasks(
    client: &reqwest::Client,
    cred_key: &CredentialGroupKey,
    api_task_ids: &[String],
) -> Result<Vec<TaskStatusResult>, String> {
    if api_task_ids.is_empty() {
        return Ok(Vec::new());
    }

    if api_task_ids.len() == 1 {
        let status = get_task_status_http(
            client,
            &cred_key.api_key,
            &cred_key.base_url,
            &api_task_ids[0],
        )
        .await?;
        return Ok(vec![status]);
    }

    let mut url = format!("{}/api/v3/contents/generations/tasks", cred_key.base_url);
    let query: String = api_task_ids
        .iter()
        .map(|id| format!("filter.task_ids={}", url_encode_query(id)))
        .collect::<Vec<_>>()
        .join("&");
    url = format!("{}?{}", url, query);

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cred_key.api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Batch query request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Batch query API error {}: {}", status, body));
    }

    let data: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid JSON: {}", e))?;

    let items = data.get("items").and_then(|v| v.as_array());

    if let Some(items) = items {
        if items.len() != api_task_ids.len() {
            eprintln!(
                "[Coordinator] Batch query: requested {} tasks but got {} items",
                api_task_ids.len(),
                items.len(),
            );
            // Log mismatch — use empty project_path since we don't have context here
            // The coordinator loop logs at a higher level with project context
        }
    }

    let mut results_map: HashMap<String, TaskStatusResult> = HashMap::new();
    if let Some(items) = items {
        for item in items {
            let item_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let parsed = super::seedance_api::parse_single_task_status_from_value(item, &item_id);
            results_map.insert(item_id, parsed);
        }
    }

    let results: Vec<TaskStatusResult> = api_task_ids
        .iter()
        .map(|id| {
            results_map
                .get(id)
                .cloned()
                .unwrap_or_else(|| TaskStatusResult {
                    task_id: id.clone(),
                    status: "unknown".to_string(),
                    result_url: None,
                    last_frame_url: None,
                    error: None,
                })
        })
        .collect();

    Ok(results)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/// Sanitize URL for logging: replace base64 data URLs with a length marker,
/// preserve all other URLs (presigned, asset://, https://, etc.) intact.
fn sanitize_url(url: &str) -> String {
    if url.starts_with("data:") {
        let len = url.len();
        // Extract the MIME type part before the base64 payload
        let mime_end = url.find(";base64,").unwrap_or(0);
        let mime = if mime_end > 5 {
            &url[5..mime_end]
        } else {
            "unknown"
        };
        format!("<<base64 mime={} len={}>>", mime, len)
    } else {
        url.to_string()
    }
}

async fn resolve_local_references(
    content: &mut Vec<SeedanceContentItem>,
    local_refs: &[LocalReference],
    project_path: &str,
) -> Result<(), String> {
    // Build allowed_dirs once — canonicalize project_path a single time
    let project_canonical = std::path::Path::new(project_path).canonicalize().ok();
    let allowed_dirs: [Option<PathBuf>; 6] = [
        dirs::data_dir(),
        dirs::home_dir(),
        dirs::desktop_dir(),
        dirs::download_dir(),
        Some(std::env::temp_dir()),
        project_canonical,
    ];

    for local_ref in local_refs {
        if local_ref.content_index >= content.len() {
            return Err(format!(
                "local_references content_index {} out of bounds (content length: {})",
                local_ref.content_index,
                content.len()
            ));
        }

        let upload = upload_file_to_base64(&local_ref.file_path, &allowed_dirs).await?;

        let item = &mut content[local_ref.content_index];
        if let Some(url_field) = item.url_field_mut() {
            url_field.url = upload.file_id;
        } else {
            return Err(format!(
                "Cannot resolve reference for content type '{}'",
                item.item_type
            ));
        }
    }
    Ok(())
}

/// Create a generation task via the ARK API.
async fn create_task_http(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: String,
    content: Vec<SeedanceContentItem>,
    resolution: String,
    ratio: String,
    duration: i32,
    generate_audio: bool,
    return_last_frame: Option<bool>,
    extra_params: &Option<HashMap<String, serde_json::Value>>,
) -> Result<CreateTaskResult, String> {
    let mut payload = serde_json::json!({
        "model": model,
        "content": content,
        "resolution": resolution,
        "ratio": ratio,
        "duration": duration,
        "generate_audio": generate_audio,
        "execution_expires_after": 14400
    });

    if let Some(v) = return_last_frame {
        payload["return_last_frame"] = serde_json::json!(v);
    }

    // Merge extra_params into the payload (user-facing passthrough for callback_url, seed, watermark, etc.)
    if let Some(ep) = extra_params {
        if let Some(obj) = payload.as_object_mut() {
            for (k, v) in ep {
                obj.insert(k.clone(), v.clone());
            }
        }
    }

    let resp = client
        .post(format!("{}/api/v3/contents/generations/tasks", base_url))
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
    Ok(CreateTaskResult {
        task_id: data
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        status: data
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        created_at: data
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Get task status from the ARK API.
async fn get_task_status_http(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    task_id: &str,
) -> Result<TaskStatusResult, String> {
    let resp = client
        .get(format!(
            "{}/api/v3/contents/generations/tasks/{}",
            base_url, task_id
        ))
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

    super::seedance_api::parse_task_status_response(&body, task_id)
}

/// Download a generation result video to the project directory.
async fn download_video_http(
    client: &reqwest::Client,
    url: &str,
    project_path: &str,
    generation_id: &str,
) -> Result<DownloadResult, String> {
    if !url.starts_with("https://") {
        return Err(format!("Only HTTPS URLs are allowed: {}", url));
    }

    let output_dir = PathBuf::from(project_path).join("Generated").join("Video");
    let output_path = output_dir.join(format!("{}.mp4", generation_id));

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Download failed with status {}", status));
    }

    if let Some(len) = response.content_length() {
        if len > MAX_DOWNLOAD_SIZE {
            return Err(format!(
                "Video too large: {} bytes (max {} MB)",
                len,
                MAX_DOWNLOAD_SIZE / 1024 / 1024
            ));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if bytes.len() as u64 > MAX_DOWNLOAD_SIZE {
        return Err(format!(
            "Video too large: {} bytes (max {} MB)",
            bytes.len(),
            MAX_DOWNLOAD_SIZE / 1024 / 1024
        ));
    }

    let file_size = bytes.len() as u64;
    let output_dir_clone = output_dir.clone();
    let output_path_clone = output_path.clone();

    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&output_dir_clone)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
        std::fs::write(&output_path_clone, &bytes)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(DownloadResult {
        file_path: output_path.to_string_lossy().to_string(),
        file_size,
    })
}

/// Read a local file, base64-encode it, and return a SHA-256 file_id.
async fn upload_file_to_base64(
    file_path: &str,
    allowed_dirs: &[Option<PathBuf>; 6],
) -> Result<UploadResult, String> {
    let canonical = super::util::validate_local_path(file_path)?;

    let is_allowed = allowed_dirs
        .iter()
        .filter_map(|d| d.as_ref())
        .any(|dir| canonical.starts_with(dir));
    if !is_allowed {
        return Err(format!(
            "File must be in a user directory: {}",
            canonical.display()
        ));
    }

    let bytes = tokio::task::spawn_blocking({
        let canonical = canonical.clone();
        move || std::fs::read(&canonical)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("Failed to read file: {}", e))?;

    if bytes.len() > 50 * 1024 * 1024 {
        return Err("File size exceeds 50MB limit".to_string());
    }

    let file_id = super::seedance_api::sha256_hex(&bytes);
    let content_type = super::seedance_api::infer_content_type(file_path);

    use base64::Engine;
    let base64_str = format!(
        "data:{};base64,{}",
        content_type,
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );

    let filename = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(UploadResult {
        file_id,
        base64: base64_str,
        filename,
    })
}
