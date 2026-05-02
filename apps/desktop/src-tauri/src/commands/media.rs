use crate::commands::metadata::MediaMetadataResult;
use crate::media::backend::{concat_media, probe_media, process_asset, render_timeline};
use crate::media::model::{
    AssetProcessRequest, AssetProcessResult, MediaConcatRequest, MediaConcatResult,
    MediaProbeRequest, TimelineRenderRequest, TimelineRenderResult,
};

#[tauri::command(rename_all = "camelCase")]
pub async fn media_process(request: AssetProcessRequest) -> Result<AssetProcessResult, String> {
    tokio::task::spawn_blocking(move || process_asset(request))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_concat(request: MediaConcatRequest) -> Result<MediaConcatResult, String> {
    tokio::task::spawn_blocking(move || concat_media(request))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_probe(request: MediaProbeRequest) -> Result<MediaMetadataResult, String> {
    tokio::task::spawn_blocking(move || probe_media(request))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn media_render_timeline(
    request: TimelineRenderRequest,
) -> Result<TimelineRenderResult, String> {
    tokio::task::spawn_blocking(move || render_timeline(request))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}
