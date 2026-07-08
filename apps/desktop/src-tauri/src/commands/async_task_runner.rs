//! Shared orchestration skeleton for async polling task runners.
//!
//! Extracted from the duplicated Seedance (`generation_task.rs`) and MiniMax
//! (`minimax_tts.rs`) coordinators. Provider-specific HTTP/parsing/download
//! logic stays in the impl files; this module owns the generic coordinator
//! loop, task manager, resume flow, and shared helpers.
//!
//! Two concrete runners exist today: `SeedanceRunner` (batch query, video
//! download) and `MinimaxRunner` (per-task query, audio download + tar
//! extraction). Both are managed as separate `TaskManager<R>` Tauri states.

use super::generation_log::{GenerationLogManager, LogContext};
use super::generation_task::{
    load_pending_task, pending_tasks_dir, write_pending_task, GenerationEvent, PendingTaskRecord,
    PendingTaskStatus,
};
use super::poll_utils::adaptive_poll_interval;
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

// ---------------------------------------------------------------------------
// Credential group key
// ---------------------------------------------------------------------------

/// Groups tasks that share the same API credentials so the coordinator can
/// poll them in a single batch / loop iteration.
#[derive(Hash, Eq, PartialEq, Clone, Debug)]
pub(crate) struct CredentialGroupKey {
    pub api_key: String,
    pub base_url: String,
}

// ---------------------------------------------------------------------------
// Task verdict + poll outcome
// ---------------------------------------------------------------------------

/// Result of classifying a single polled status.
pub enum TaskVerdict<O> {
    /// Still running — keep polling.
    Processing,
    /// Terminal success — carries download inputs only (NOT credentials).
    Succeeded(O),
    /// Terminal failure with error message.
    Failed(String),
}

/// Outcome of polling a task, sent from the coordinator to the
/// lifecycle/resume awaiter via a oneshot channel.
pub enum PollOutcome<O> {
    Succeeded(O),
    Failed(String),
    Cancelled,
}

// ---------------------------------------------------------------------------
// Handle + registered task
// ---------------------------------------------------------------------------

pub(crate) struct AsyncTaskHandle {
    pub cancel_tx: watch::Sender<bool>,
    pub _join_handle: JoinHandle<()>,
}

#[allow(dead_code)]
pub(crate) struct RegisteredTask<O> {
    pub task_id: String,
    pub api_task_id: String,
    pub cred_group: CredentialGroupKey,
    /// When dropped without sending, the receiver treats it as a shutdown
    /// signal (not cancellation) and exits gracefully, leaving the pending
    /// task file for recovery.
    pub result_tx: oneshot::Sender<PollOutcome<O>>,
    pub cancel_rx: watch::Receiver<bool>,
    pub registered_at: tokio::time::Instant,
    pub project_path: String,
}

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Provider-specific hooks for the generic async polling coordinator.
///
/// The runner owns ALL HTTP/parsing/download logic; this module owns the
/// orchestration shell (snapshot → group-by-cred → poll → classify → emit).
#[async_trait]
pub(crate) trait AsyncPollingTaskRunner: Send + Sync + 'static {
    /// Terminal-success payload — carries download inputs only (NOT creds).
    /// For Seedance: `{ video_url, last_frame_url }`. For MiniMax: `{ file_id }`.
    type Outcome: Send + Clone + 'static;
    /// Normalized per-task query result (provider-specific status struct).
    type Status: Send;

    /// Tag for `eprintln` prefixes (e.g. `"GenerationTask"`, `"MinimaxTask"`).
    fn log_tag() -> &'static str;

    /// Resolve API credentials (api_key, base_url) for a provider.
    fn credentials(provider_id: &str, password: &str) -> Result<(String, String), String>;

    /// Query a group of tasks sharing the same credentials.
    /// Returns `(api_task_id, status)` pairs. MiniMax's default impl loops
    /// `query_task` per id; Seedance overrides with `batch_query_tasks`.
    async fn query_tasks(
        client: &reqwest::Client,
        api_key: &str,
        base_url: &str,
        api_task_ids: &[String],
    ) -> Result<Vec<(String, Self::Status)>, String>;

    /// Classify a polled status. `Processing` = keep polling.
    fn classify(status: &Self::Status) -> TaskVerdict<Self::Outcome>;

    /// Human-readable status string for logging / change detection.
    fn status_display(status: &Self::Status) -> String;

    /// Attempt to recover a `Completed` task whose output file is missing.
    /// - `None`: fall through to re-poll (Seedance re-derives a fresh URL).
    /// - `Some(Ok(()))`: recovered — hook already persisted + emitted `Completed`.
    /// - `Some(Err(msg))`: unrecoverable — caller persists + emits `Failed`.
    async fn try_recover_completed_missing_file(
        app: &AppHandle,
        record: &PendingTaskRecord,
        client: &reqwest::Client,
        api_key: &str,
        base_url: &str,
    ) -> Option<Result<(), String>>;

    /// Handle a terminal poll outcome: persist + emit events. Spawns the
    /// download task if the outcome is `Succeeded`.
    fn handle_outcome(
        app: &AppHandle,
        client: &reqwest::Client,
        api_key: &str,
        base_url: &str,
        record: &PendingTaskRecord,
        outcome: PollOutcome<Self::Outcome>,
        log_mgr: &Arc<GenerationLogManager>,
    );
}

// ---------------------------------------------------------------------------
// Task manager
// ---------------------------------------------------------------------------

pub struct TaskManager<R: AsyncPollingTaskRunner> {
    pub(crate) tasks: Arc<tokio::sync::Mutex<HashMap<String, AsyncTaskHandle>>>,
    pub(crate) coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask<R::Outcome>>>>,
    pub(crate) coordinator_notify: mpsc::Sender<()>,
    _coordinator_join: tauri::async_runtime::JoinHandle<()>,
    pub(crate) log_manager: Arc<GenerationLogManager>,
}

impl<R: AsyncPollingTaskRunner> TaskManager<R> {
    pub fn new(app: AppHandle, client: reqwest::Client, log_manager: GenerationLogManager) -> Self {
        let (notify_tx, mut notify_rx) = mpsc::channel::<()>(32);
        let coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask<R::Outcome>>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        let log_mgr = Arc::new(log_manager);
        let coord_tasks = coordinator_tasks.clone();
        let coord_log = log_mgr.clone();
        let coord_join = tauri::async_runtime::spawn(async move {
            coordinator_loop::<R>(app, client, coord_tasks, &mut notify_rx, coord_log).await;
        });

        Self {
            tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            coordinator_tasks,
            coordinator_notify: notify_tx,
            _coordinator_join: coord_join,
            log_manager: log_mgr,
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
// Coordinator loop (generic)
// ---------------------------------------------------------------------------

struct TaskSnapshot {
    task_id: String,
    api_task_id: String,
    registered_at: tokio::time::Instant,
    project_path: String,
}

/// Generic coordinator loop: wait-on-empty → snapshot → cancel-detection →
/// deferred fs cleanup → group-by-cred poll → send outcomes → adaptive sleep
/// with `tokio::select!` on `notify_rx`.
async fn coordinator_loop<R: AsyncPollingTaskRunner>(
    app: AppHandle,
    client: reqwest::Client,
    tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredTask<R::Outcome>>>>,
    notify_rx: &mut mpsc::Receiver<()>,
    log_mgr: Arc<GenerationLogManager>,
) {
    // Track last known status + last log time per task_id to reduce log
    // volume: log on status change, or at most every 60 s otherwise.
    let mut last_status: HashMap<String, (String, std::time::Instant)> = HashMap::new();
    let periodic_log_interval = std::time::Duration::from_secs(60);
    let tag = R::log_tag();

    loop {
        // Wait until at least one task is registered.
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

        // Build snapshot, group by credential, collect cancelled task IDs
        // (deferred fs cleanup).
        let (cancelled_task_ids, snapshot, group_map): (
            Vec<(String, PathBuf)>,
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

            // Remove cancelled tasks — send Cancelled outcome first so the
            // lifecycle handler emits the proper event (not a shutdown
            // silent-return).
            for (id, _) in &cancelled {
                if let Some(reg) = t.remove(id) {
                    let _ = reg.result_tx.send(PollOutcome::Cancelled);
                }
            }

            (cancelled, snap, groups)
        };

        // Deferred fs cleanup — outside the lock.
        for (_, path) in &cancelled_task_ids {
            let _ = std::fs::remove_file(path);
        }

        if snapshot.is_empty() {
            continue;
        }

        eprintln!(
            "[{}Coordinator] Polling {} tasks across {} credential groups",
            tag,
            snapshot.len(),
            group_map.len()
        );

        // Log coordinator cycle using project path from snapshot.
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

        // Poll each credential group.
        let mut completed_tasks: Vec<(String, PollOutcome<R::Outcome>)> = Vec::new();
        let mut min_registered_at = tokio::time::Instant::now();

        for (cred_key, indices) in &group_map {
            let api_task_ids: Vec<String> = indices
                .iter()
                .map(|&i| snapshot[i].api_task_id.clone())
                .collect();

            match R::query_tasks(&client, &cred_key.api_key, &cred_key.base_url, &api_task_ids)
                .await
            {
                Ok(results) => {
                    for (api_task_id, status) in results {
                        // Map the returned api_task_id back to its snapshot.
                        let Some(&i) = indices
                            .iter()
                            .find(|&&i| snapshot[i].api_task_id == api_task_id)
                        else {
                            continue;
                        };
                        let snap = &snapshot[i];

                        // Track oldest task for sleep duration.
                        if snap.registered_at < min_registered_at {
                            min_registered_at = snap.registered_at;
                        }

                        let status_display = R::status_display(&status);
                        eprintln!(
                            "[{}Coordinator] Task {} (api: {}): status={}",
                            tag, snap.task_id, snap.api_task_id, status_display
                        );

                        // Log on status change, or periodically (every 60s).
                        let now = std::time::Instant::now();
                        let should_log = match last_status.get(&snap.task_id) {
                            Some((prev_key, last_log_time)) => {
                                prev_key != &status_display
                                    || now.duration_since(*last_log_time) >= periodic_log_interval
                            }
                            None => true,
                        };
                        if should_log {
                            last_status
                                .insert(snap.task_id.clone(), (status_display.clone(), now));
                            LogContext::new(&log_mgr, &snap.project_path)
                                .info(
                                    "coordinator_task_status",
                                    &format!("Task status: {}", status_display),
                                )
                                .task_id(&snap.task_id)
                                .data(serde_json::json!({
                                    "api_task_id": snap.api_task_id,
                                    "status": status_display,
                                }))
                                .log();
                        }

                        match R::classify(&status) {
                            TaskVerdict::Succeeded(outcome) => {
                                completed_tasks
                                    .push((snap.task_id.clone(), PollOutcome::Succeeded(outcome)));
                            }
                            TaskVerdict::Failed(err) => {
                                completed_tasks
                                    .push((snap.task_id.clone(), PollOutcome::Failed(err)));
                            }
                            TaskVerdict::Processing => {}
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[{}Coordinator] Query failed: {}", tag, e);
                    if let Some(first_snap) = snapshot.first() {
                        LogContext::new(&log_mgr, &first_snap.project_path)
                            .error(
                                "coordinator_query_error",
                                &format!("Query failed: {}", e),
                            )
                            .data(serde_json::json!({ "error": e }))
                            .log();
                    }
                }
            }
        }

        // Send outcomes and remove completed tasks.
        if !completed_tasks.is_empty() {
            let mut t = tasks.lock().await;
            for (task_id, outcome) in completed_tasks {
                last_status.remove(&task_id);
                if let Some(reg) = t.remove(&task_id) {
                    let _ = reg.result_tx.send(outcome);
                }
            }
        }

        // Sleep with adaptive interval, computed from snapshot (no re-lock).
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
// Shared helpers
// ---------------------------------------------------------------------------

/// Reconstruct a monotonic `registered_at` from a wall-clock epoch timestamp.
///
/// After a reboot the wall-clock delta can exceed the monotonic clock's
/// uptime, which would underflow `Instant::now() - elapsed` and panic. The
/// `checked_sub` guard clamps to `now` in that case, preserving adaptive-poll
/// behaviour without panicking.
pub(crate) fn reconstruct_registered_at(registered_at_epoch_ms: i64) -> tokio::time::Instant {
    let elapsed_ms = chrono::Utc::now().timestamp_millis() - registered_at_epoch_ms;
    let elapsed = Duration::from_millis(elapsed_ms.max(0) as u64);
    tokio::time::Instant::now()
        .checked_sub(elapsed)
        .unwrap_or_else(tokio::time::Instant::now)
}

/// Persist a failed outcome to disk, then emit the `Failed` event.
pub(crate) fn persist_and_emit_failed(
    app: &AppHandle,
    record: &PendingTaskRecord,
    error: String,
    log_tag: &str,
) {
    let mut updated = record.clone();
    updated.status = PendingTaskStatus::Failed;
    updated.outcome_error = Some(error.clone());
    if let Err(e) = write_pending_task(app, &updated) {
        eprintln!("[{}] Failed to persist failed status: {}", log_tag, e);
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

// ---------------------------------------------------------------------------
// Resume (generic)
// ---------------------------------------------------------------------------

/// Resume a pending task after app restart.
///
/// Flow: load → status fast-path → reconstruct `registered_at` via
/// `checked_sub` → register → spawn await → handle outcome.
pub(crate) async fn resume_task<R: AsyncPollingTaskRunner>(
    app: AppHandle,
    client: reqwest::Client,
    manager: &TaskManager<R>,
    task_id: String,
    password: String,
) -> Result<bool, String> {
    let record = load_pending_task(&app, &task_id)?;
    let tag = R::log_tag();

    // ── Completed fast-path: skip re-polling for already-resolved tasks ──

    if record.status == PendingTaskStatus::Completed {
        if let Some(ref file_path) = record.outcome_video_path {
            if std::path::Path::new(file_path).exists() {
                eprintln!(
                    "[{}] Re-emitting completed event for task {} (file exists)",
                    tag, record.task_id
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

        // File missing — obtain creds, try provider-specific recovery.
        let (api_key, base_url) = R::credentials(&record.provider_id, &password)?;
        match R::try_recover_completed_missing_file(&app, &record, &client, &api_key, &base_url)
            .await
        {
            None => {
                // Fall through to re-poll with these creds.
                register_and_spawn::<R>(&app, client, manager, record, api_key, base_url).await;
                return Ok(true);
            }
            Some(Ok(())) => return Ok(true),
            Some(Err(msg)) => {
                persist_and_emit_failed(&app, &record, msg, tag);
                return Ok(true);
            }
        }
    }

    if record.status == PendingTaskStatus::Failed {
        eprintln!(
            "[{}] Re-emitting failed event for task {}",
            tag, record.task_id
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

    // ── Pending — re-register with coordinator ──
    let (api_key, base_url) = R::credentials(&record.provider_id, &password)?;
    register_and_spawn::<R>(&app, client, manager, record, api_key, base_url).await;
    Ok(true)
}

/// Register a resumed task with the coordinator and spawn the awaiter task.
async fn register_and_spawn<R: AsyncPollingTaskRunner>(
    app: &AppHandle,
    client: reqwest::Client,
    manager: &TaskManager<R>,
    record: PendingTaskRecord,
    api_key: String,
    base_url: String,
) {
    let task_id = record.task_id.clone();
    let cred_group = CredentialGroupKey {
        api_key: api_key.clone(),
        base_url: base_url.clone(),
    };

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (result_tx, result_rx) = oneshot::channel();

    let registered_at = reconstruct_registered_at(record.registered_at_epoch_ms);

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

    let tasks = manager.tasks.clone();
    let log_mgr = manager.log_manager.clone();
    let app_clone = app.clone();
    let record_for_outcome = record.clone();
    let task_id_for_cleanup = task_id.clone();
    let tag = R::log_tag();

    let handle = tokio::spawn(async move {
        let outcome = match result_rx.await {
            Ok(outcome) => outcome,
            Err(_) => {
                eprintln!(
                    "[{}] result_tx dropped for resumed task {} — app shutdown, keeping pending file",
                    tag, task_id_for_cleanup
                );
                tasks.lock().await.remove(&task_id_for_cleanup);
                return;
            }
        };
        R::handle_outcome(
            &app_clone,
            &client,
            &api_key,
            &base_url,
            &record_for_outcome,
            outcome,
            &log_mgr,
        );
        tasks.lock().await.remove(&task_id_for_cleanup);
    });

    manager.tasks.lock().await.insert(
        task_id.clone(),
        AsyncTaskHandle {
            cancel_tx,
            _join_handle: handle,
        },
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconstruct_registered_at_clamps_uptime_overflow() {
        // Simulate a registered_at from 30 days ago — the wall-clock delta
        // far exceeds the monotonic clock's uptime after a reboot. Must NOT
        // panic (the checked_sub guard clamps to now).
        let thirty_days_ago_ms =
            chrono::Utc::now().timestamp_millis() - (30 * 24 * 3600 * 1000);
        let instant = reconstruct_registered_at(thirty_days_ago_ms);
        // Clamped to now (instant <= now), never in the future.
        let now = tokio::time::Instant::now();
        assert!(
            instant <= now,
            "reconstructed instant must not be in the future"
        );
    }

    #[test]
    fn reconstruct_registered_at_recent_timestamp_preserves_elapsed() {
        // 5 seconds ago — well within uptime. The reconstructed instant
        // should be ~5 seconds before now.
        let five_seconds_ago_ms = chrono::Utc::now().timestamp_millis() - 5_000;
        let instant = reconstruct_registered_at(five_seconds_ago_ms);
        let now = tokio::time::Instant::now();
        let elapsed = now.duration_since(instant);
        // Allow generous slack for test scheduling (~5s, allow 1..60s).
        assert!(
            elapsed.as_secs() >= 1,
            "elapsed should be at least ~5s, got {:?}",
            elapsed
        );
        assert!(
            elapsed.as_secs() < 60,
            "elapsed should be reasonable, got {:?}",
            elapsed
        );
    }

    #[test]
    fn reconstruct_registered_at_future_timestamp_clamps_to_zero_elapsed() {
        // A future timestamp (negative elapsed) — clamps to 0 via .max(0).
        let future_ms = chrono::Utc::now().timestamp_millis() + 60_000;
        let instant = reconstruct_registered_at(future_ms);
        let now = tokio::time::Instant::now();
        let delta = now.duration_since(instant);
        assert!(
            delta.as_millis() < 1000,
            "future timestamp should clamp to ~now, got {:?} delta",
            delta
        );
    }
}
