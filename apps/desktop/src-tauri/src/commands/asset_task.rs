use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::Hash;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch};

use super::generation_log::{GenerationLogManager, LogContext};
use super::poll_utils::adaptive_poll_interval;
use super::provider_key::get_credentials_internal;
use super::seedance_api::{ark_signed_request, get_asset_detail};
use super::tos_api::{get_tos_params, tos_upload_internal};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Parameters passed from JS to `start_asset_upload`.
#[derive(Deserialize)]
pub struct StartAssetUploadParams {
    pub asset_id: String,
    pub provider_id: String,
    pub password: String,
    pub file_path: String,
    pub asset_type: String,
    pub project_path: String,
}

/// Event payload emitted over `asset:status`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum AssetEvent {
    #[serde(rename = "created")]
    Created {
        asset_id: String,
        remote_asset_id: String,
        provider_instance_id: String,
        group_id: String,
        project_path: String,
    },
    #[serde(rename = "active")]
    Active {
        asset_id: String,
        remote_asset_id: String,
        project_path: String,
    },
    #[serde(rename = "failed")]
    Failed {
        asset_id: String,
        remote_asset_id: String,
        error: String,
        project_path: String,
    },
}

// ---------------------------------------------------------------------------
// Credential grouping for batched polling
// ---------------------------------------------------------------------------

#[derive(Hash, Eq, PartialEq, Clone)]
struct AssetCredGroupKey {
    ak: String,
    sk: String,
    region: String,
}

enum AssetPollOutcome {
    Active,
    Failed(String),
    Cancelled,
}

struct RegisteredAssetTask {
    #[allow(dead_code)]
    asset_id: String,
    remote_asset_id: String,
    cred_group: AssetCredGroupKey,
    result_tx: oneshot::Sender<AssetPollOutcome>,
    cancel_rx: watch::Receiver<bool>,
    registered_at: tokio::time::Instant,
    provider_id: String,
    password: String,
    project_path: String,
    project_name: String,
}

struct AssetTaskHandle {
    cancel_tx: watch::Sender<bool>,
    #[allow(dead_code)]
    join_handle: JoinHandle<()>,
}

pub struct AssetTaskManager {
    tasks: Arc<tokio::sync::Mutex<HashMap<String, AssetTaskHandle>>>,
    coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredAssetTask>>>,
    coordinator_notify: mpsc::Sender<()>,
    _coordinator_join: JoinHandle<()>,
    log_manager: Arc<GenerationLogManager>,
}

impl AssetTaskManager {
    pub fn new(
        _app: AppHandle,
        client: reqwest::Client,
        log_manager: GenerationLogManager,
    ) -> Self {
        let (notify_tx, mut notify_rx) = mpsc::channel::<()>(32);
        let coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredAssetTask>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        let log_mgr = Arc::new(log_manager);
        let coord_tasks = coordinator_tasks.clone();
        let coord_log = log_mgr.clone();
        let coord_join = tauri::async_runtime::spawn(async move {
            asset_coordinator_loop(client, coord_tasks, &mut notify_rx, coord_log).await;
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
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_asset_upload(
    app: AppHandle,
    state: tauri::State<'_, super::seedance_api::SeedanceState>,
    manager: tauri::State<'_, AssetTaskManager>,
    params: StartAssetUploadParams,
) -> Result<(), String> {
    let asset_id = params.asset_id.clone();
    let (cancel_tx, cancel_rx) = watch::channel(false);

    let client = state.http.clone();
    let tasks = manager.tasks.clone();
    let coordinator_tasks = manager.coordinator_tasks.clone();
    let coordinator_notify = manager.coordinator_notify.clone();

    let asset_id_for_cleanup = asset_id.clone();
    let log_mgr = manager.log_manager.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_asset_upload_lifecycle(
            app.clone(),
            client,
            params,
            cancel_rx,
            coordinator_tasks,
            coordinator_notify,
            &log_mgr,
        )
        .await;
        tasks.lock().await.remove(&asset_id_for_cleanup);
    });

    manager.tasks.lock().await.insert(
        asset_id.clone(),
        AssetTaskHandle {
            cancel_tx,
            join_handle: handle,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn cancel_asset_upload(
    manager: tauri::State<'_, AssetTaskManager>,
    asset_id: String,
) -> Result<bool, String> {
    let tasks = manager.tasks.lock().await;
    if let Some(handle) = tasks.get(&asset_id) {
        let _ = handle.cancel_tx.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

// ---------------------------------------------------------------------------
// Asset upload lifecycle
// ---------------------------------------------------------------------------

async fn run_asset_upload_lifecycle(
    app: AppHandle,
    client: reqwest::Client,
    params: StartAssetUploadParams,
    cancel_rx: watch::Receiver<bool>,
    coordinator_tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredAssetTask>>>,
    coordinator_notify: mpsc::Sender<()>,
    log_mgr: &Arc<GenerationLogManager>,
) {
    let asset_id = params.asset_id.clone();
    let provider_id = params.provider_id.clone();
    let password = params.password.clone();

    // Get credentials
    let creds = match get_credentials_internal(&provider_id, &password) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[AssetTask] Failed to get credentials for {}: {}",
                asset_id, e
            );
            LogContext::new(log_mgr, &params.project_path)
                .error(
                    "asset_credentials_error",
                    &format!("Failed to get credentials: {}", e),
                )
                .data(serde_json::json!({ "error": e }))
                .log();
            return;
        }
    };

    let tos_params = match get_tos_params(&creds) {
        Ok(tc) => tc,
        Err(e) => {
            eprintln!(
                "[AssetTask] TOS not configured for provider {}: {}",
                provider_id, e
            );
            LogContext::new(log_mgr, &params.project_path)
                .error(
                    "asset_tos_config_error",
                    &format!("TOS not configured: {}", e),
                )
                .data(serde_json::json!({ "provider_id": provider_id, "error": e }))
                .log();
            return;
        }
    };

    let cred_group = AssetCredGroupKey {
        ak: tos_params.ak.clone(),
        sk: tos_params.sk.clone(),
        region: tos_params.region.clone(),
    };

    let project_name = creds
        .asset_project
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let asset_group_id = creds.asset_group_id.clone();
    eprintln!(
        "[AssetTask] Credentials loaded: project_name={}, asset_group_id={:?}, ak={}",
        project_name,
        asset_group_id,
        &creds.ak[..8.min(creds.ak.len())]
    );

    // Full upload lifecycle
    let _ = run_full_upload(
        &app,
        &client,
        &tos_params,
        &provider_id,
        &password,
        &params,
        &project_name,
        &asset_group_id,
        &cred_group,
        &coordinator_tasks,
        &coordinator_notify,
        cancel_rx,
        log_mgr,
    )
    .await;
}

async fn run_full_upload(
    app: &AppHandle,
    client: &reqwest::Client,
    tos_params: &super::tos_api::TosParams,
    provider_id: &str,
    password: &str,
    params: &StartAssetUploadParams,
    project_name: &str,
    asset_group_id: &Option<String>,
    cred_group: &AssetCredGroupKey,
    coordinator_tasks: &Arc<tokio::sync::Mutex<HashMap<String, RegisteredAssetTask>>>,
    coordinator_notify: &mpsc::Sender<()>,
    cancel_rx: watch::Receiver<bool>,
    log_mgr: &Arc<GenerationLogManager>,
) -> Option<String> {
    let asset_id = params.asset_id.clone();
    let project_path = params.project_path.clone();

    // 1. TOS upload
    let file_path = PathBuf::from(&params.file_path);
    let upload_start = std::time::Instant::now();
    let upload_result = match tos_upload_internal(tos_params, &file_path).await {
        Ok(r) => {
            let message = if r.skipped {
                "TOS upload skipped: object already exists"
            } else {
                "TOS upload complete"
            };
            let data = serde_json::json!({
                "object_key": r.object_key,
                "file_size": r.file_size,
                "content_type": r.content_type,
                "skipped": r.skipped,
            });
            let ctx = LogContext::new(log_mgr, &project_path);
            if !r.skipped {
                ctx.info("tos_upload_result", message)
                    .duration_ms(upload_start.elapsed().as_millis() as u64)
                    .data(data)
                    .log();
            } else {
                ctx.info("tos_upload_result", message).data(data).log();
            }
            r
        }
        Err(e) => {
            eprintln!("[AssetTask] TOS upload failed for {}: {}", asset_id, e);
            LogContext::new(log_mgr, &project_path)
                .error("tos_upload_failed", &format!("TOS upload failed: {}", e))
                .data(serde_json::json!({ "error": e }))
                .log();
            let _ = app.emit(
                "asset:status",
                AssetEvent::Failed {
                    asset_id: asset_id.clone(),
                    remote_asset_id: String::new(),
                    error: format!("TOS upload failed: {}", e),
                    project_path: project_path.clone(),
                },
            );
            return None;
        }
    };

    // Check cancellation
    if *cancel_rx.borrow() {
        return None;
    }

    // 2. Require asset_group_id — user must select a group in settings
    let group_id = match asset_group_id {
        Some(ref gid) if !gid.is_empty() => {
            eprintln!("[AssetTask] Using stored asset_group_id: {}", gid);
            gid.clone()
        }
        _ => {
            eprintln!("[AssetTask] No asset_group_id configured for {}", asset_id);
            let _ = app.emit(
                "asset:status",
                AssetEvent::Failed {
                    asset_id: asset_id.clone(),
                    remote_asset_id: String::new(),
                    error: "Asset Group is not configured. Select or create one in Settings.".to_string(),
                    project_path: project_path.clone(),
                },
            );
            return None;
        }
    };

    // 3. Create asset
    let create_body = serde_json::json!({
        "GroupId": group_id,
        "URL": upload_result.presigned_url,
        "AssetType": params.asset_type,
        "ProjectName": project_name,
    })
    .to_string();

    let create_resp = match ark_signed_request(
        client,
        provider_id,
        password,
        "CreateAsset",
        "POST",
        None,
        &create_body,
    )
    .await
    {
        Ok(r) => {
            let create_ms = upload_start.elapsed().as_millis() as u64;
            LogContext::new(log_mgr, &project_path)
                .info("create_asset_result", "CreateAsset API call succeeded")
                .duration_ms(create_ms)
                .data(serde_json::json!({
                    "remote_asset_id": r.get("Result").and_then(|v| v.get("Id")).and_then(|v| v.as_str()).unwrap_or(""),
                }))
                .log();
            r
        }
        Err(e) => {
            eprintln!("[AssetTask] CreateAsset failed for {}: {}", asset_id, e);
            LogContext::new(log_mgr, &project_path)
                .error("create_asset_failed", &format!("CreateAsset failed: {}", e))
                .data(serde_json::json!({ "error": e }))
                .log();
            let _ = app.emit(
                "asset:status",
                AssetEvent::Failed {
                    asset_id: asset_id.clone(),
                    remote_asset_id: String::new(),
                    error: format!("CreateAsset failed: {}", e),
                    project_path: project_path.clone(),
                },
            );
            return None;
        }
    };

    let result = create_resp.get("Result").cloned().unwrap_or_default();
    let remote_asset_id = result
        .get("Id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if remote_asset_id.is_empty() {
        let _ = app.emit(
            "asset:status",
            AssetEvent::Failed {
                asset_id: asset_id.clone(),
                remote_asset_id: String::new(),
                error: "CreateAsset returned empty ID".to_string(),
                project_path: project_path.clone(),
            },
        );
        return None;
    }

    // 4. Emit Created event (TS will persist to Assets.xml)
    let _ = app.emit(
        "asset:status",
        AssetEvent::Created {
            asset_id: asset_id.clone(),
            remote_asset_id: remote_asset_id.clone(),
            provider_instance_id: provider_id.to_string(),
            group_id: group_id.clone(),
            project_path: project_path.clone(),
        },
    );

    // 5. Register with coordinator and wait for result
    let (result_tx, result_rx) = oneshot::channel();
    {
        let registered = RegisteredAssetTask {
            asset_id: asset_id.clone(),
            remote_asset_id: remote_asset_id.clone(),
            cred_group: cred_group.clone(),
            result_tx,
            cancel_rx,
            registered_at: tokio::time::Instant::now(),
            provider_id: provider_id.to_string(),
            password: password.to_string(),
            project_path: project_path.clone(),
            project_name: project_name.to_string(),
        };
        let mut coord = coordinator_tasks.lock().await;
        coord.insert(asset_id.clone(), registered);
    }
    let _ = coordinator_notify.try_send(());

    // Wait for poll outcome
    let outcome = match result_rx.await {
        Ok(outcome) => outcome,
        Err(_) => {
            eprintln!(
                "[AssetTask] result_tx dropped for asset {} — app shutdown",
                asset_id
            );
            return None;
        }
    };

    match outcome {
        AssetPollOutcome::Active => {
            let _ = app.emit(
                "asset:status",
                AssetEvent::Active {
                    asset_id: asset_id.clone(),
                    remote_asset_id: remote_asset_id.clone(),
                    project_path,
                },
            );
        }
        AssetPollOutcome::Failed(err) => {
            let _ = app.emit(
                "asset:status",
                AssetEvent::Failed {
                    asset_id: asset_id.clone(),
                    remote_asset_id: remote_asset_id.clone(),
                    error: err,
                    project_path,
                },
            );
        }
        AssetPollOutcome::Cancelled => {
            // Silently exit
        }
    }

    Some(remote_asset_id)
}

// ---------------------------------------------------------------------------
// Coordinator loop
// ---------------------------------------------------------------------------

struct AssetTaskSnapshot {
    asset_id: String,
    remote_asset_id: String,
    #[allow(dead_code)]
    cred_group: AssetCredGroupKey,
    registered_at: tokio::time::Instant,
    provider_id: String,
    password: String,
    #[allow(dead_code)]
    project_path: String,
    project_name: String,
}

async fn asset_coordinator_loop(
    client: reqwest::Client,
    tasks: Arc<tokio::sync::Mutex<HashMap<String, RegisteredAssetTask>>>,
    notify_rx: &mut mpsc::Receiver<()>,
    log_mgr: Arc<GenerationLogManager>,
) {
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

        // Build snapshot, collect cancelled task IDs
        let (snapshot, group_map): (
            Vec<AssetTaskSnapshot>,
            HashMap<AssetCredGroupKey, Vec<usize>>,
        ) = {
            let mut t = tasks.lock().await;
            let mut cancelled = Vec::new();
            let mut snap = Vec::new();
            let mut groups: HashMap<AssetCredGroupKey, Vec<usize>> = HashMap::new();

            for key in t.keys().cloned().collect::<Vec<_>>() {
                if let Some(reg) = t.get(&key) {
                    if *reg.cancel_rx.borrow() {
                        cancelled.push(key);
                    } else {
                        let idx = snap.len();
                        snap.push(AssetTaskSnapshot {
                            asset_id: key.clone(),
                            remote_asset_id: reg.remote_asset_id.clone(),
                            cred_group: reg.cred_group.clone(),
                            registered_at: reg.registered_at,
                            provider_id: reg.provider_id.clone(),
                            password: reg.password.clone(),
                            project_path: reg.project_path.clone(),
                            project_name: reg.project_name.clone(),
                        });
                        groups.entry(reg.cred_group.clone()).or_default().push(idx);
                    }
                }
            }

            // Remove cancelled tasks and send Cancelled outcome
            for id in &cancelled {
                if let Some(reg) = t.remove(id) {
                    let _ = reg.result_tx.send(AssetPollOutcome::Cancelled);
                }
            }

            (snap, groups)
        };

        if snapshot.is_empty() {
            continue;
        }

        eprintln!(
            "[AssetCoordinator] Polling {} tasks across {} credential groups",
            snapshot.len(),
            group_map.len()
        );

        // Log coordinator cycle using first task's project_path
        if let Some(first_snap) = snapshot.first() {
            LogContext::new(&log_mgr, &first_snap.project_path)
                .info(
                    "asset_coordinator_poll",
                    &format!(
                        "Polling {} asset tasks across {} groups",
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

        // Poll each credential group (no batch API for assets — poll individually)
        let mut completed_tasks: Vec<(String, AssetPollOutcome)> = Vec::new();
        let mut min_registered_at = tokio::time::Instant::now();

        for (_, indices) in &group_map {
            for &i in indices {
                let snap = &snapshot[i];

                if snap.registered_at < min_registered_at {
                    min_registered_at = snap.registered_at;
                }

                match get_asset_detail(
                    &client,
                    &snap.provider_id,
                    &snap.password,
                    &snap.remote_asset_id,
                    &snap.project_name,
                )
                .await
                {
                    Ok(asset_item) => {
                        eprintln!(
                            "[AssetCoordinator] Asset {} (remote: {}): status={}",
                            snap.asset_id, snap.remote_asset_id, asset_item.status
                        );
                        LogContext::new(&log_mgr, &snap.project_path)
                            .info(
                                "asset_coordinator_status",
                                &format!("Asset status: {}", asset_item.status),
                            )
                            .data(serde_json::json!({
                                "asset_id": snap.asset_id,
                                "remote_asset_id": snap.remote_asset_id,
                                "status": asset_item.status,
                            }))
                            .log();

                        match asset_item.status.as_str() {
                            "Active" => {
                                completed_tasks
                                    .push((snap.asset_id.clone(), AssetPollOutcome::Active));
                            }
                            "Failed" => {
                                let err = asset_item
                                    .error_message
                                    .unwrap_or_else(|| "Asset processing failed".to_string());
                                completed_tasks
                                    .push((snap.asset_id.clone(), AssetPollOutcome::Failed(err)));
                            }
                            _ => {
                                // Still Processing — skip, will check again next cycle
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[AssetCoordinator] get_asset_detail failed for {}: {}",
                            snap.asset_id, e
                        );
                    }
                }
            }
        }

        // Send outcomes and remove completed tasks
        if !completed_tasks.is_empty() {
            let mut t = tasks.lock().await;
            for (asset_id, outcome) in completed_tasks {
                if let Some(reg) = t.remove(&asset_id) {
                    let _ = reg.result_tx.send(outcome);
                }
            }
        }

        // Sleep with adaptive interval
        let now = tokio::time::Instant::now();
        let min_elapsed = now.saturating_duration_since(min_registered_at).as_secs();
        let interval = adaptive_poll_interval(min_elapsed);

        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = notify_rx.recv() => {}
        }
    }
}
