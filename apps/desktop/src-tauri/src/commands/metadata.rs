use serde::{Deserialize, Serialize};

use crate::media::model::MediaProbeRequest;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaMetadataResult {
    pub duration_ms: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub codec: Option<String>,
    #[serde(default)]
    pub has_audio: Option<bool>,
}

pub(crate) fn read_media_metadata(path: &str) -> Result<MediaMetadataResult, String> {
    crate::media::backend::probe_media(MediaProbeRequest {
        path: path.to_string(),
    })
}

#[tauri::command]
pub async fn get_media_metadata(path: String) -> Result<MediaMetadataResult, String> {
    tokio::task::spawn_blocking(move || read_media_metadata(&path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}
