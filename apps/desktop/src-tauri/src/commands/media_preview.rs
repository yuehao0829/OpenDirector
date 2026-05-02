use std::sync::Arc;

use tauri::State;

use crate::media::model::{
    PreviewDiagnostics, PreviewSessionInfo, PreviewViewport, TimelinePreviewSnapshot,
};
use crate::media::preview::PreviewSessionManager;

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_create_session(
    window_label: Option<String>,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<PreviewSessionInfo, String> {
    state.create_session(window_label).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_destroy_session(
    session_id: String,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.destroy_session(&session_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_attach_surface(
    session_id: String,
    surface_id: Option<String>,
    viewport: Option<PreviewViewport>,
    surface_sync_revision: Option<u64>,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<PreviewSessionInfo, String> {
    state
        .attach_surface(&session_id, surface_id, viewport, surface_sync_revision)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_set_viewport(
    session_id: String,
    viewport: PreviewViewport,
    surface_sync_revision: Option<u64>,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state
        .set_viewport(&session_id, viewport, surface_sync_revision)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_set_surface_presenting(
    session_id: String,
    presenting: bool,
    surface_sync_revision: Option<u64>,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state
        .set_surface_presenting(&session_id, presenting, surface_sync_revision)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_set_timeline(
    session_id: String,
    snapshot: TimelinePreviewSnapshot,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.set_timeline(&session_id, snapshot).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_play(
    session_id: String,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.play(&session_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_play_from(
    session_id: String,
    time_ms: f64,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.play_from(&session_id, time_ms).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_pause(
    session_id: String,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.pause(&session_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_seek(
    session_id: String,
    time_ms: f64,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.seek(&session_id, time_ms).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_step_frame(
    session_id: String,
    direction: i32,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.step_frame(&session_id, direction).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_set_rate(
    session_id: String,
    rate: f64,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<(), String> {
    state.set_rate(&session_id, rate).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_preview_get_diagnostics(
    session_id: String,
    state: State<'_, Arc<PreviewSessionManager>>,
) -> Result<PreviewDiagnostics, String> {
    state.get_diagnostics(&session_id).await
}
