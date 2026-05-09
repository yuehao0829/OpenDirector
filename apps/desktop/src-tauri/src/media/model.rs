use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaBackendId {
    GstreamerGes,
}

impl Default for MediaBackendId {
    fn default() -> Self {
        Self::GstreamerGes
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProcessRequest {
    pub backend: Option<MediaBackendId>,
    pub input_path: String,
    pub output_dir: String,
    pub crop_x: Option<f64>,
    pub crop_y: Option<f64>,
    pub crop_w: Option<f64>,
    pub crop_h: Option<f64>,
    pub trim_start_ms: Option<f64>,
    pub trim_end_ms: Option<f64>,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub target_aspect_ratio: Option<String>,
    pub output_format: Option<String>,
}

impl AssetProcessRequest {
    pub fn preferred_backend(&self) -> MediaBackendId {
        self.backend.clone().unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProcessResult {
    pub output_path: String,
    pub file_size: u64,
    pub backend_used: MediaBackendId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaConcatRequest {
    pub backend: Option<MediaBackendId>,
    pub input_paths: Vec<String>,
    pub output_dir: String,
    pub output_filename: String,
}

impl MediaConcatRequest {
    pub fn preferred_backend(&self) -> MediaBackendId {
        self.backend.clone().unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaConcatResult {
    pub output_path: String,
    pub file_size: u64,
    pub backend_used: MediaBackendId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum TimelineTrackType {
    Video,
    Audio,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRenderTrack {
    pub id: String,
    #[serde(rename = "type")]
    pub track_type: TimelineTrackType,
    pub muted: bool,
    pub order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRenderCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRenderClip {
    pub id: String,
    pub track_id: String,
    pub input_path: String,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub trim_start_ms: Option<f64>,
    pub mute: Option<bool>,
    pub crop: Option<TimelineRenderCrop>,
    pub transform: Option<PreviewTransform>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRenderRequest {
    pub backend: Option<MediaBackendId>,
    pub output_path: String,
    pub output_format: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub tracks: Vec<TimelineRenderTrack>,
    pub clips: Vec<TimelineRenderClip>,
}

impl TimelineRenderRequest {
    pub fn preferred_backend(&self) -> MediaBackendId {
        self.backend.clone().unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRenderResult {
    pub output_path: String,
    pub file_size: u64,
    pub backend_used: MediaBackendId,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreviewSessionState {
    Idle,
    Ready,
    Playing,
    Paused,
    Seeking,
    Ended,
    Error,
    Destroyed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTransform {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub scale_x: Option<f64>,
    pub scale_y: Option<f64>,
    pub rotation_deg: Option<f64>,
    pub opacity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewViewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePreviewTrack {
    pub id: String,
    #[serde(rename = "type")]
    pub track_type: TimelineTrackType,
    pub muted: bool,
    pub order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePreviewFragment {
    pub id: String,
    pub track_id: String,
    pub absolute_path: String,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub trim_start_ms: f64,
    pub muted: bool,
    pub volume: Option<f64>,
    pub crop: Option<TimelineRenderCrop>,
    pub transform: Option<PreviewTransform>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePreviewSnapshot {
    pub project_path: String,
    pub duration_ms: f64,
    pub fps: f64,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub tracks: Vec<TimelinePreviewTrack>,
    pub fragments: Vec<TimelinePreviewFragment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionInfo {
    pub session_id: String,
    pub window_label: String,
    pub state: PreviewSessionState,
    pub native_surface_supported: bool,
    pub native_surface_implemented: bool,
    pub native_surface_platform_status: String,
    pub native_surface_platform_reason: Option<String>,
    pub native_surface_attached: bool,
    pub timeline_attached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionPositionEvent {
    pub session_id: String,
    pub position_ms: f64,
    pub is_playing: bool,
    pub is_buffering: bool,
    pub drift_ms: f64,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionFrameTimestampEvent {
    pub session_id: String,
    pub position_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionStateEvent {
    pub session_id: String,
    pub state: PreviewSessionState,
    pub position_ms: f64,
    pub rate: f64,
    pub native_surface_attached: bool,
    pub timeline_attached: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionErrorEvent {
    pub session_id: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionMetrics {
    pub timeline_updates: u64,
    pub seek_count: u64,
    pub warm_seek_count: u64,
    pub cold_seek_count: u64,
    pub step_count: u64,
    pub play_count: u64,
    pub pause_count: u64,
    pub viewport_updates: u64,
    pub seek_burst_count: u64,
    pub max_seek_burst_count: u64,
    pub last_seek_latency_ms: f64,
    pub max_seek_latency_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionMetricsEvent {
    pub session_id: String,
    pub state: PreviewSessionState,
    pub metrics: PreviewSessionMetrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRuntimeDiagnostics {
    pub gstreamer_ready: bool,
    pub gstreamer_reason: Option<String>,
    pub runtime_root: Option<String>,
    pub ges_launch_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDiagnostics {
    pub session_id: String,
    pub window_label: String,
    pub state: PreviewSessionState,
    pub playback_backend: String,
    pub configured_video_sink_type: Option<String>,
    pub native_surface_supported: bool,
    pub native_surface_implemented: bool,
    pub native_surface_platform_status: String,
    pub native_surface_platform_reason: Option<String>,
    pub native_surface_type: Option<String>,
    pub native_surface_attached: bool,
    pub native_surface_visible: bool,
    pub native_surface_presenting: bool,
    pub native_surface_embedded_content_attached: bool,
    pub attached_surface_id: Option<String>,
    pub native_host_window_handle: Option<String>,
    pub native_surface_window_handle: Option<String>,
    pub native_surface_physical_rect: Option<PreviewSurfaceRect>,
    pub timeline_attached: bool,
    pub duration_ms: f64,
    pub position_ms: f64,
    pub rate: f64,
    pub viewport: Option<PreviewViewport>,
    pub timeline_track_count: usize,
    pub timeline_fragment_count: usize,
    pub prepared_timeline_track_count: usize,
    pub prepared_timeline_clip_count: usize,
    pub runtime: PreviewRuntimeDiagnostics,
    pub last_error: Option<String>,
    pub metrics: PreviewSessionMetrics,
}
