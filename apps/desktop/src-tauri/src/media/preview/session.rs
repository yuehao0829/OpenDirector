use std::time::Instant;

use tauri::{AppHandle, Emitter};

use crate::media::ges::preview_timeline_builder::{build_preview_timeline, GesPreviewTimeline};
use crate::media::model::{
    PreviewDiagnostics, PreviewRuntimeDiagnostics, PreviewSessionErrorEvent, PreviewSessionInfo,
    PreviewSessionPositionEvent, PreviewSessionState, PreviewSessionStateEvent, PreviewViewport,
    TimelinePreviewSnapshot,
};
use crate::media::runtime::initialize;

use super::diagnostics::{SeekKind, SessionMetrics};
use super::player::{configured_video_sink_type, GstreamerPreviewPlayer};
use super::sink::{native_surface_platform_status, native_surface_type, NativePreviewSurface};
use super::transport::{clamp_position, normalize_rate};
use super::viewport::normalize_viewport;

const POSITION_EVENT: &str = "media-preview://position";
const STATE_EVENT: &str = "media-preview://state";
const ERROR_EVENT: &str = "media-preview://error";
const METRICS_EVENT: &str = "media-preview://metrics";
const CONSECUTIVE_SEEK_WINDOW_MS: f64 = 200.0;
const EMPTY_TIMELINE_VIRTUAL_DURATION_MS: f64 = 60_000.0;

#[derive(Clone, Copy, Debug)]
struct PreviewPlayerResumeState {
    position_ms: f64,
    rate: f64,
    playing: bool,
}

#[derive(Debug)]
pub struct PreviewSession {
    pub session_id: String,
    pub window_label: String,
    pub state: PreviewSessionState,
    pub native_surface_supported: bool,
    pub surface_presenting: bool,
    pub surface_sync_revision: u64,
    pub attached_surface_id: Option<String>,
    pub native_surface: Option<NativePreviewSurface>,
    pub timeline: Option<TimelinePreviewSnapshot>,
    pub prepared_timeline: Option<GesPreviewTimeline>,
    pub viewport: Option<PreviewViewport>,
    pub position_ms: f64,
    pub rate: f64,
    pub last_error: Option<String>,
    pub metrics: SessionMetrics,
    pub preview_player: Option<GstreamerPreviewPlayer>,
    last_seek_completed_at: Option<Instant>,
    virtual_play_started_at: Option<Instant>,
    virtual_play_base_position_ms: f64,
}

impl PreviewSession {
    pub fn new(session_id: String, window_label: String, native_surface_supported: bool) -> Self {
        Self {
            session_id,
            window_label,
            state: PreviewSessionState::Idle,
            native_surface_supported,
            surface_presenting: false,
            surface_sync_revision: 0,
            attached_surface_id: None,
            native_surface: None,
            timeline: None,
            prepared_timeline: None,
            viewport: None,
            position_ms: 0.0,
            rate: 1.0,
            last_error: None,
            metrics: SessionMetrics::default(),
            preview_player: None,
            last_seek_completed_at: None,
            virtual_play_started_at: None,
            virtual_play_base_position_ms: 0.0,
        }
    }

    pub fn info(&self) -> PreviewSessionInfo {
        PreviewSessionInfo {
            session_id: self.session_id.clone(),
            window_label: self.window_label.clone(),
            state: self.state,
            native_surface_supported: self.native_surface_supported,
            native_surface_implemented: native_surface_platform_status().implemented,
            native_surface_platform_status: native_surface_platform_status().status.to_string(),
            native_surface_platform_reason: native_surface_platform_status()
                .reason
                .map(str::to_string),
            native_surface_attached: self.native_surface_attached(),
            timeline_attached: self.timeline.is_some(),
        }
    }

    pub fn diagnostics(&self) -> PreviewDiagnostics {
        let (timeline_track_count, timeline_fragment_count, duration_ms) = self
            .timeline
            .as_ref()
            .map(|timeline| {
                (
                    timeline.tracks.len(),
                    timeline.fragments.len(),
                    timeline.duration_ms,
                )
            })
            .unwrap_or((0, 0, 0.0));
        let (prepared_timeline_track_count, prepared_timeline_clip_count) = self
            .prepared_timeline
            .as_ref()
            .map(|timeline| (timeline.tracks.len(), timeline.clips.len()))
            .unwrap_or((0, 0));
        let runtime = initialize();
        let runtime_root = runtime
            .gstreamer
            .bootstrap
            .runtime_root
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        let ges_launch_path = runtime
            .gstreamer
            .bootstrap
            .ges_launch_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        let gstreamer_ready = runtime.gstreamer.is_preview_ready();

        let platform_status = native_surface_platform_status();

        PreviewDiagnostics {
            session_id: self.session_id.clone(),
            window_label: self.window_label.clone(),
            state: self.state,
            playback_backend: "in-process-ges-pipeline".to_string(),
            configured_video_sink_type: configured_video_sink_type().map(str::to_string),
            native_surface_supported: self.native_surface_supported,
            native_surface_implemented: platform_status.implemented,
            native_surface_platform_status: platform_status.status.to_string(),
            native_surface_platform_reason: platform_status.reason.map(str::to_string),
            native_surface_type: native_surface_type().map(str::to_string),
            native_surface_attached: self.native_surface_attached(),
            native_surface_visible: self
                .native_surface
                .as_ref()
                .map(|surface| surface.is_visible())
                .unwrap_or(false),
            native_surface_presenting: self
                .native_surface
                .as_ref()
                .map(|surface| surface.is_presenting())
                .unwrap_or(false),
            native_surface_embedded_content_attached: self
                .native_surface
                .as_ref()
                .map(|surface| surface.is_embedded_content_attached())
                .unwrap_or(false),
            attached_surface_id: self.attached_surface_id.clone(),
            native_host_window_handle: self
                .native_surface
                .as_ref()
                .and_then(|surface| surface.host_window_handle_repr()),
            native_surface_window_handle: self
                .native_surface
                .as_ref()
                .and_then(|surface| surface.surface_window_handle_repr()),
            native_surface_physical_rect: self
                .native_surface
                .as_ref()
                .and_then(|surface| surface.physical_rect()),
            timeline_attached: self.timeline.is_some(),
            duration_ms,
            position_ms: self.position_ms,
            rate: self.rate,
            viewport: self.viewport.clone(),
            timeline_track_count,
            timeline_fragment_count,
            prepared_timeline_track_count,
            prepared_timeline_clip_count,
            runtime: PreviewRuntimeDiagnostics {
                gstreamer_ready,
                gstreamer_reason: if gstreamer_ready {
                    None
                } else {
                    Some(runtime.gstreamer.preview_reason())
                },
                runtime_root,
                ges_launch_path,
            },
            last_error: self.last_error.clone(),
            metrics: self.metrics.as_model(),
        }
    }

    pub fn native_surface_attached(&self) -> bool {
        self.native_surface_supported && self.native_surface.is_some()
    }

    pub fn attach_surface(
        &mut self,
        app: &AppHandle,
        surface_id: Option<String>,
        viewport: Option<PreviewViewport>,
        surface_sync_revision: Option<u64>,
    ) -> Result<(), String> {
        let Some(desired_surface_presenting) =
            self.prepare_surface_attach(viewport, surface_sync_revision)?
        else {
            return Ok(());
        };

        let surface_id = surface_id.filter(|value| !value.trim().is_empty());

        if surface_id.is_none() {
            self.attached_surface_id = None;
            return self.detach_native_surface();
        }

        if !self.native_surface_supported {
            let message = "Native preview surface is not supported on this platform".to_string();
            self.set_error(message.clone(), None);
            return Err(message);
        }

        let surface_id = surface_id.expect("surface_id checked above");
        let should_reuse_existing = self.attached_surface_id.as_deref()
            == Some(surface_id.as_str())
            && self.native_surface.is_some();
        if should_reuse_existing {
            return self.apply_surface_presenting_update(desired_surface_presenting);
        }

        if let Some(surface) = self.native_surface.as_mut() {
            if let Err(error) = surface.set_presenting(false) {
                return Err(self
                    .fail_operation("Failed to hide the existing native preview surface", error));
            }
        }

        self.attached_surface_id = None;
        if let Err(error) = self.detach_native_surface() {
            return Err(
                self.fail_operation("Failed to detach existing native preview surface", error)
            );
        }

        let mut native_surface =
            match NativePreviewSurface::attach(app, &self.window_label, &surface_id) {
                Ok(surface) => surface,
                Err(error) => {
                    return Err(
                        self.fail_operation("Failed to attach native preview surface", error)
                    );
                }
            };
        if let Some(viewport) = self.viewport.as_ref() {
            if let Err(error) = native_surface.set_viewport(viewport) {
                return Err(self.fail_operation("Failed to apply native preview viewport", error));
            }
        }

        let surface_window_handle = native_surface.surface_window_handle_value();
        let bind_result = if self.preview_player.is_some() {
            let preview_player = self
                .preview_player
                .as_mut()
                .expect("preview_player existence checked above");
            preview_player.bind_surface_handle(surface_window_handle)
        } else {
            Ok(())
        };
        if let Err(error) = bind_result {
            let _ = native_surface.detach();
            return Err(self.fail_operation(
                "Failed to bind native preview surface to preview sink",
                error,
            ));
        }

        if self.preview_player.is_some() {
            if let Err(error) =
                native_surface.set_embedded_content_attached(surface_window_handle.is_some())
            {
                let _ = native_surface.detach();
                return Err(self.fail_operation(
                    "Failed to mark native preview surface as ready for embedded content",
                    error,
                ));
            }
        } else {
            if let Err(error) = native_surface.set_embedded_content_attached(false) {
                let _ = native_surface.detach();
                return Err(self.fail_operation(
                    "Failed to reset native preview surface embedded-content state",
                    error,
                ));
            }
        }

        if let Err(error) = native_surface.set_presenting(desired_surface_presenting) {
            return Err(self.fail_operation("Failed to present native preview surface", error));
        }

        self.attached_surface_id = Some(surface_id);
        self.native_surface = Some(native_surface);
        self.last_error = None;
        Ok(())
    }

    fn prepare_surface_attach(
        &mut self,
        viewport: Option<PreviewViewport>,
        surface_sync_revision: Option<u64>,
    ) -> Result<Option<bool>, String> {
        if !self.begin_surface_sync(surface_sync_revision) {
            return Ok(None);
        }

        if let Some(viewport) = viewport {
            self.apply_viewport_update(viewport)?;
        }

        Ok(Some(self.surface_presenting))
    }

    pub fn set_viewport(
        &mut self,
        viewport: PreviewViewport,
        surface_sync_revision: Option<u64>,
    ) -> Result<(), String> {
        if !self.begin_surface_sync(surface_sync_revision) {
            return Ok(());
        }

        self.apply_viewport_update(viewport)
    }

    pub fn set_surface_presenting(
        &mut self,
        presenting: bool,
        surface_sync_revision: Option<u64>,
    ) -> Result<(), String> {
        if !self.begin_surface_sync(surface_sync_revision) {
            return Ok(());
        }

        self.apply_surface_presenting_update(presenting)
    }

    fn apply_viewport_update(&mut self, viewport: PreviewViewport) -> Result<(), String> {
        let viewport = normalize_viewport(viewport);
        let result = if let Some(surface) = self.native_surface.as_mut() {
            surface.set_viewport(&viewport)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            return Err(self.fail_operation("Failed to update native preview viewport", error));
        }
        self.viewport = Some(viewport);
        self.metrics.viewport_updates += 1;
        self.last_error = None;
        Ok(())
    }

    fn apply_surface_presenting_update(&mut self, presenting: bool) -> Result<(), String> {
        self.surface_presenting = presenting;
        let result = if let Some(surface) = self.native_surface.as_mut() {
            surface.set_presenting(presenting)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            return Err(
                self.fail_operation("Failed to update native preview surface visibility", error)
            );
        }
        self.last_error = None;
        Ok(())
    }

    fn begin_surface_sync(&mut self, surface_sync_revision: Option<u64>) -> bool {
        match surface_sync_revision {
            Some(revision) if revision < self.surface_sync_revision => false,
            Some(revision) => {
                self.surface_sync_revision = revision;
                true
            }
            None => true,
        }
    }

    pub fn set_timeline(&mut self, timeline: TimelinePreviewSnapshot) -> Result<(), String> {
        let was_playing = matches!(self.state, PreviewSessionState::Playing);
        self.sync_playback_position();
        let previous_state = self.state;
        let previous_position_ms = self.position_ms;
        let previous_virtual_play_started_at = self.virtual_play_started_at;
        let previous_virtual_play_base_position_ms = self.virtual_play_base_position_ms;
        let existing_preview_resume_state =
            self.preview_player
                .as_ref()
                .map(|_| PreviewPlayerResumeState {
                    position_ms: self.position_ms,
                    rate: self.rate,
                    playing: was_playing,
                });

        let prepared_timeline = match build_preview_timeline(&timeline) {
            Ok(prepared_timeline) => prepared_timeline,
            Err(error) => {
                let message = format!("Failed to build preview timeline: {error}");
                self.set_error(message.clone(), Some(error));
                return Err(message);
            }
        };

        let next_duration_ms =
            playback_duration_ms(&timeline, prepared_timeline.clips.is_empty(), None);

        self.stop_virtual_playback();
        self.position_ms = clamp_position(self.position_ms, next_duration_ms);

        if prepared_timeline.clips.is_empty() {
            if let Err(error) = self.replace_preview_player(None) {
                return Err(self
                    .fail_operation("Failed to reset preview backend for empty timeline", error));
            }
        } else {
            let preview_player = match GstreamerPreviewPlayer::new_pending(&prepared_timeline) {
                Ok(player) => player,
                Err(error) => {
                    return Err(self.fail_operation("Failed to initialize preview backend", error));
                }
            };
            if let Err(error) = self
                .replace_preview_player_with_pending(preview_player, existing_preview_resume_state)
            {
                self.position_ms = previous_position_ms;
                self.virtual_play_started_at = previous_virtual_play_started_at;
                self.virtual_play_base_position_ms = previous_virtual_play_base_position_ms;
                let message = self.fail_operation(
                    "Failed to bind preview backend to native preview surface",
                    error,
                );
                if self.preview_player.is_some() || self.virtual_play_started_at.is_some() {
                    self.state = previous_state;
                }
                return Err(message);
            }
        }

        if was_playing && self.position_ms >= next_duration_ms {
            if let Some(preview_player) = self.preview_player.as_mut() {
                let seek_position_ms = preview_player.clamp_seek_position_ms(next_duration_ms);
                let seek_result = if next_duration_ms > 0.0 {
                    preview_player.seek_paused(seek_position_ms)
                } else {
                    preview_player.pause()
                };
                if let Err(error) = seek_result {
                    return Err(self.fail_operation(
                        "Failed to position preview backend at the updated timeline end",
                        error,
                    ));
                }
            }
            self.position_ms = next_duration_ms;
            self.stop_virtual_playback();
            self.state = PreviewSessionState::Ended;
        } else if was_playing {
            if let Some(preview_player) = self.preview_player.as_mut() {
                if let Err(error) = preview_player.play(self.position_ms, self.rate) {
                    return Err(self.fail_operation(
                        "Failed to resume preview backend after timeline update",
                        error,
                    ));
                }
            } else {
                self.start_virtual_playback();
            }
            self.state = PreviewSessionState::Playing;
        } else {
            if self.position_ms > 0.0 && self.preview_player.is_some() {
                if let Err(error) = self.seek_paused_to_position(self.position_ms) {
                    return Err(self.fail_operation(
                        "Failed to preroll preview backend at the current timeline position",
                        error,
                    ));
                }
            }
            self.state = PreviewSessionState::Ready;
        }

        self.timeline = Some(timeline);
        self.prepared_timeline = Some(prepared_timeline);
        self.metrics.timeline_updates += 1;
        self.last_error = None;
        Ok(())
    }

    pub fn play(&mut self) -> Result<(), String> {
        if self.timeline.is_none() {
            self.set_error("Cannot play before timeline is attached", None);
            return Err("Cannot play before timeline is attached".to_string());
        }

        let duration_ms = self.effective_duration_ms();
        if self.position_ms >= duration_ms {
            self.position_ms = duration_ms;
            self.state = PreviewSessionState::Ended;
            return Ok(());
        }

        if let Some(preview_player) = self.preview_player.as_mut() {
            if let Err(error) = preview_player.play(self.position_ms, self.rate) {
                return Err(self.fail_operation("Failed to start preview playback", error));
            }
        } else {
            self.start_virtual_playback();
        }
        self.state = PreviewSessionState::Playing;
        self.last_error = None;
        self.metrics.play_count += 1;
        Ok(())
    }

    pub fn play_from(&mut self, time_ms: f64) -> Result<(), String> {
        if self.timeline.is_none() {
            self.set_error("Cannot play before timeline is attached", None);
            return Err("Cannot play before timeline is attached".to_string());
        }

        self.sync_playback_position();
        let duration_ms = self.effective_duration_ms();
        self.position_ms = clamp_position(time_ms, duration_ms);

        if self.position_ms >= duration_ms {
            self.seek_to_session_end()?;
            self.last_error = None;
            return Ok(());
        }

        if let Some(preview_player) = self.preview_player.as_mut() {
            let play_position_ms = preview_player.clamp_seek_position_ms(self.position_ms);
            preview_player
                .play(play_position_ms, self.rate)
                .map_err(|error| self.fail_operation("Failed to start preview playback", error))?;
            self.position_ms = play_position_ms;
        } else {
            self.start_virtual_playback();
        }

        self.state = PreviewSessionState::Playing;
        self.last_error = None;
        self.metrics.play_count += 1;
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), String> {
        self.sync_playback_position();
        let pause_result = if let Some(preview_player) = self.preview_player.as_mut() {
            preview_player.pause()
        } else {
            Ok(())
        };
        if let Err(error) = pause_result {
            return Err(self.fail_operation("Failed to pause preview playback", error));
        }
        self.sync_playback_position();
        self.stop_virtual_playback();
        self.state = PreviewSessionState::Paused;
        self.metrics.pause_count += 1;
        self.last_error = None;
        Ok(())
    }

    pub fn seek(&mut self, time_ms: f64) -> Result<(), String> {
        let previous_position_ms = self.position_ms;
        let seek_kind = self.classify_seek(previous_position_ms, time_ms);
        let seek_burst_count = self.next_seek_burst_count();
        let started_at = Instant::now();
        let was_playing = matches!(self.state, PreviewSessionState::Playing);
        self.sync_playback_position();
        let duration_ms = self.effective_duration_ms();
        self.state = PreviewSessionState::Seeking;
        self.position_ms = clamp_position(time_ms, duration_ms);

        if self.preview_player.is_none() {
            if was_playing && self.position_ms < duration_ms {
                self.start_virtual_playback();
                self.state = PreviewSessionState::Playing;
            } else if self.position_ms >= duration_ms {
                self.stop_virtual_playback();
                self.state = PreviewSessionState::Ended;
            } else {
                self.stop_virtual_playback();
                self.state = PreviewSessionState::Paused;
            }
            self.complete_seek_metrics(seek_kind, seek_burst_count, started_at);
            self.last_error = None;
            return Ok(());
        }

        if self.position_ms >= duration_ms {
            if let Err(error) = self.seek_to_session_end() {
                return Err(self
                    .fail_operation("Failed to seek preview playback to the session end", error));
            }
            self.complete_seek_metrics(seek_kind, seek_burst_count, started_at);
            return Ok(());
        }

        let seek_position_ms = self
            .preview_player
            .as_ref()
            .map(|preview_player| preview_player.clamp_seek_position_ms(self.position_ms))
            .unwrap_or(self.position_ms);
        self.position_ms = seek_position_ms;

        let seek_result = if was_playing {
            self.preview_player
                .as_mut()
                .expect("preview_player existence checked above")
                .play(seek_position_ms, self.rate)
        } else {
            self.preview_player
                .as_mut()
                .expect("preview_player existence checked above")
                .seek_paused(seek_position_ms)
        };
        if let Err(error) = seek_result {
            let operation = if was_playing {
                "Failed to resume preview playback after seek"
            } else {
                "Failed to seek paused preview playback"
            };
            return Err(self.fail_operation(operation, error));
        }

        if was_playing {
            self.state = PreviewSessionState::Playing;
        } else {
            self.state = PreviewSessionState::Paused;
        }

        self.complete_seek_metrics(seek_kind, seek_burst_count, started_at);
        self.last_error = None;
        Ok(())
    }

    pub fn step_frame(&mut self, direction: i32) -> Result<(), String> {
        self.stop_virtual_playback();
        let duration_ms = self.effective_duration_ms();
        let frame_duration_ms = match self.timeline.as_ref() {
            Some(timeline) if timeline.fps > 0.0 => 1000.0 / timeline.fps,
            _ => 1000.0 / 30.0,
        };
        self.position_ms = clamp_position(
            self.position_ms + frame_duration_ms * if direction >= 0 { 1.0 } else { -1.0 },
            duration_ms,
        );

        if self.position_ms >= duration_ms {
            if let Err(error) = self.seek_to_session_end() {
                return Err(self
                    .fail_operation("Failed to step preview playback to the session end", error));
            }
            self.metrics.step_count += 1;
            return Ok(());
        }

        if let Err(error) = self.seek_paused_to_position(self.position_ms) {
            return Err(self.fail_operation("Failed to step paused preview playback", error));
        }
        self.metrics.step_count += 1;
        self.last_error = None;
        Ok(())
    }

    pub fn set_rate(&mut self, rate: f64) -> Result<(), String> {
        self.sync_playback_position();
        self.rate = normalize_rate(rate);
        if matches!(self.state, PreviewSessionState::Playing) {
            if let Some(preview_player) = self.preview_player.as_mut() {
                if let Err(error) = preview_player.play(self.position_ms, self.rate) {
                    return Err(
                        self.fail_operation("Failed to update preview playback rate", error)
                    );
                }
            } else {
                self.start_virtual_playback();
            }
        }
        self.last_error = None;
        Ok(())
    }

    pub fn destroy(&mut self) -> Result<(), String> {
        self.stop_virtual_playback();
        if let Err(error) = self.replace_preview_player(None) {
            return Err(self.fail_operation("Failed to shut down preview backend", error));
        }
        if let Err(error) = self.detach_native_surface() {
            return Err(self.fail_operation(
                "Failed to detach native preview surface during destroy",
                error,
            ));
        }
        self.state = PreviewSessionState::Destroyed;
        self.prepared_timeline = None;
        self.last_error = None;
        Ok(())
    }

    pub fn set_error(&mut self, message: impl Into<String>, details: Option<String>) {
        let message = message.into();
        self.last_error = Some(message.clone());
        self.state = PreviewSessionState::Error;
        let _ = details;
    }

    pub fn emit_state(&self, app: &AppHandle, message: Option<String>) -> Result<(), String> {
        app.emit(
            STATE_EVENT,
            PreviewSessionStateEvent {
                session_id: self.session_id.clone(),
                state: self.state,
                position_ms: self.position_ms,
                rate: self.rate,
                native_surface_attached: self.native_surface_attached(),
                timeline_attached: self.timeline.is_some(),
                message,
            },
        )
        .map_err(|error| error.to_string())
    }

    pub fn emit_position(&self, app: &AppHandle) -> Result<(), String> {
        app.emit(
            POSITION_EVENT,
            PreviewSessionPositionEvent {
                session_id: self.session_id.clone(),
                position_ms: self.position_ms,
                is_playing: matches!(self.state, PreviewSessionState::Playing),
                is_buffering: false,
                drift_ms: 0.0,
                rate: self.rate,
            },
        )
        .map_err(|error| error.to_string())
    }

    pub fn emit_metrics(&self, app: &AppHandle) -> Result<(), String> {
        app.emit(
            METRICS_EVENT,
            self.metrics
                .as_event(self.session_id.clone(), self.state),
        )
        .map_err(|error| error.to_string())
    }

    pub fn emit_error(
        &self,
        app: &AppHandle,
        message: impl Into<String>,
        details: Option<String>,
    ) -> Result<(), String> {
        app.emit(
            ERROR_EVENT,
            PreviewSessionErrorEvent {
                session_id: self.session_id.clone(),
                message: message.into(),
                details,
            },
        )
        .map_err(|error| error.to_string())
    }

    fn duration_ms(&self) -> f64 {
        self.timeline
            .as_ref()
            .map(|timeline| timeline.duration_ms)
            .unwrap_or(0.0)
    }

    fn playback_duration_ms(&self) -> f64 {
        self.timeline
            .as_ref()
            .map(|timeline| {
                playback_duration_ms(
                    timeline,
                    self.prepared_timeline
                        .as_ref()
                        .map(|prepared_timeline| prepared_timeline.clips.is_empty())
                        .unwrap_or(false),
                    None,
                )
            })
            .unwrap_or(0.0)
    }

    fn effective_duration_ms(&self) -> f64 {
        self.timeline
            .as_ref()
            .map(|timeline| {
                playback_duration_ms(
                    timeline,
                    self.prepared_timeline
                        .as_ref()
                        .map(|prepared_timeline| prepared_timeline.clips.is_empty())
                        .unwrap_or(false),
                    self.preview_player
                        .as_ref()
                        .map(GstreamerPreviewPlayer::duration_ms),
                )
            })
            .unwrap_or(0.0)
    }

    fn seek_to_session_end(&mut self) -> Result<(), String> {
        let duration_ms = self.effective_duration_ms();
        let operation_result = if let Some(preview_player) = self.preview_player.as_mut() {
            let seek_position_ms = preview_player.clamp_seek_position_ms(duration_ms);
            if duration_ms > 0.0 {
                preview_player.seek_paused(seek_position_ms)
            } else {
                preview_player.pause()
            }
        } else {
            Ok(())
        };

        if let Err(error) = operation_result {
            let operation = if duration_ms > 0.0 {
                "Failed to seek preview backend to the last frame"
            } else {
                "Failed to pause preview backend at empty-session end"
            };
            return Err(self.fail_operation(operation, error));
        }

        self.position_ms = duration_ms;
        self.state = PreviewSessionState::Ended;
        Ok(())
    }

    fn seek_paused_to_position(&mut self, position_ms: f64) -> Result<(), String> {
        let seek_position_ms = self
            .preview_player
            .as_ref()
            .map(|preview_player| preview_player.clamp_seek_position_ms(position_ms))
            .unwrap_or(position_ms);

        let seek_result = if let Some(preview_player) = self.preview_player.as_mut() {
            preview_player.seek_paused(seek_position_ms)
        } else {
            Ok(())
        };
        if let Err(error) = seek_result {
            return Err(self.fail_operation("Failed to seek paused preview backend", error));
        }

        self.position_ms = seek_position_ms;
        self.state = PreviewSessionState::Paused;
        Ok(())
    }

    fn classify_seek(&self, previous_position_ms: f64, target_position_ms: f64) -> SeekKind {
        let Some(prepared_timeline) = self.prepared_timeline.as_ref() else {
            return SeekKind::Cold;
        };

        let previous_clip_id = clip_covering_position(prepared_timeline, previous_position_ms);
        let target_clip_id = clip_covering_position(prepared_timeline, target_position_ms);
        if previous_clip_id.is_some() && previous_clip_id == target_clip_id {
            SeekKind::Warm
        } else {
            SeekKind::Cold
        }
    }

    fn next_seek_burst_count(&self) -> u64 {
        let Some(last_seek_completed_at) = self.last_seek_completed_at else {
            return 1;
        };

        let elapsed_ms = last_seek_completed_at.elapsed().as_secs_f64() * 1000.0;
        if elapsed_ms <= CONSECUTIVE_SEEK_WINDOW_MS {
            self.metrics.seek_burst_count.saturating_add(1)
        } else {
            1
        }
    }

    fn complete_seek_metrics(
        &mut self,
        seek_kind: SeekKind,
        seek_burst_count: u64,
        started_at: Instant,
    ) {
        let latency_ms = started_at.elapsed().as_secs_f64() * 1000.0;
        self.metrics
            .record_seek(seek_kind, latency_ms, seek_burst_count);
        self.last_seek_completed_at = Some(Instant::now());
    }

    pub fn tick(&mut self) -> Result<SessionTick, String> {
        let mut tick = SessionTick::default();
        let previous_position_ms = self.position_ms;
        let previous_state = self.state;

        if let Some(preview_player) = self.preview_player.as_mut() {
            let poll = preview_player.poll()?;
            if let Some(error) = poll.last_error {
                self.set_error(error, None);
                tick.error_emitted = true;
            } else if poll.reached_eos {
                self.position_ms = self.duration_ms();
                self.state = PreviewSessionState::Ended;
            }
        }

        self.sync_playback_position();

        if self.position_ms != previous_position_ms {
            tick.position_changed = true;
        }
        if self.state != previous_state {
            tick.state_changed = true;
            tick.position_changed = true;
        }

        Ok(tick)
    }

    fn replace_preview_player(
        &mut self,
        mut preview_player: Option<GstreamerPreviewPlayer>,
    ) -> Result<(), String> {
        let shutdown_result = if let Some(existing) = self.preview_player.as_mut() {
            existing.shutdown()
        } else {
            Ok(())
        };
        if let Err(error) = shutdown_result {
            return Err(
                self.fail_operation("Failed to shut down the existing preview backend", error)
            );
        }
        self.preview_player = None;

        let reset_surface_result = if let Some(surface) = self.native_surface.as_mut() {
            surface.set_embedded_content_attached(false)
        } else {
            Ok(())
        };
        if let Err(error) = reset_surface_result {
            return Err(self.fail_operation(
                "Failed to reset native preview surface embedded-content state",
                error,
            ));
        }

        if let Some(preview_player) = preview_player.as_mut() {
            let surface_window_handle = self.surface_window_handle();
            if let Err(error) = preview_player.bind_surface_handle(surface_window_handle) {
                let _ = preview_player.shutdown();
                return Err(self.fail_operation(
                    "Failed to bind preview backend to native preview surface",
                    error,
                ));
            }
            let attach_surface_result = if let Some(surface) = self.native_surface.as_mut() {
                surface.set_embedded_content_attached(surface_window_handle.is_some())
            } else {
                Ok(())
            };
            if let Err(error) = attach_surface_result {
                return Err(self.fail_operation(
                    "Failed to mark native preview surface as ready for embedded content",
                    error,
                ));
            }
        }

        self.preview_player = preview_player;
        Ok(())
    }

    fn replace_preview_player_with_pending(
        &mut self,
        mut preview_player: GstreamerPreviewPlayer,
        existing_resume_state: Option<PreviewPlayerResumeState>,
    ) -> Result<(), String> {
        let surface_window_handle = self.surface_window_handle();

        if let Some(surface) = self.native_surface.as_mut() {
            if let Err(error) = surface.set_embedded_content_attached(false) {
                let _ = preview_player.shutdown();
                return Err(error);
            }
        }

        let mut existing = self.preview_player.take();

        if let Some(existing_player) = existing.as_mut() {
            if let Err(error) = existing_player.bind_surface_handle(None) {
                self.preview_player = existing;
                if let Some(surface) = self.native_surface.as_mut() {
                    let _ = surface.set_embedded_content_attached(surface_window_handle.is_some());
                }
                return Err(error);
            }
        }

        if let Err(error) = preview_player.bind_surface_and_preroll(surface_window_handle) {
            let _ = preview_player.shutdown();
            return self.abort_pending_replacement(
                existing,
                existing_resume_state,
                error,
            );
        }

        if let Some(existing_player) = existing.as_mut() {
            if let Err(error) = existing_player.shutdown() {
                let _ = preview_player.shutdown();
                return self.abort_pending_replacement(
                    existing,
                    existing_resume_state,
                    error,
                );
            }
        }

        if let Some(surface) = self.native_surface.as_mut() {
            if let Err(error) =
                surface.set_embedded_content_attached(surface_window_handle.is_some())
            {
                let _ = preview_player.shutdown();
                return self.abort_pending_replacement(
                    existing,
                    existing_resume_state,
                    error,
                );
            }
        }

        self.preview_player = Some(preview_player);
        Ok(())
    }

    fn abort_pending_replacement(
        &mut self,
        existing: Option<GstreamerPreviewPlayer>,
        existing_resume_state: Option<PreviewPlayerResumeState>,
        error: String,
    ) -> Result<(), String> {
        if let Err(restore_error) =
            self.restore_existing_preview_player(existing, existing_resume_state)
        {
            return Err(format!(
                "{error}; additionally failed to restore existing preview backend: {restore_error}"
            ));
        }
        Err(error)
    }

    fn restore_existing_preview_player(
        &mut self,
        existing: Option<GstreamerPreviewPlayer>,
        resume_state: Option<PreviewPlayerResumeState>,
    ) -> Result<(), String> {
        let Some(mut existing_player) = existing else {
            return Ok(());
        };

        let surface_window_handle = self.surface_window_handle();
        if let Err(error) = existing_player.bind_surface_handle(surface_window_handle) {
            let _ = existing_player.shutdown();
            return Err(error);
        }
        if let Some(resume_state) = resume_state {
            let resume_result = if resume_state.playing {
                existing_player.play(resume_state.position_ms, resume_state.rate)
            } else if resume_state.position_ms > 0.0 {
                existing_player.seek_paused(resume_state.position_ms)
            } else {
                existing_player.pause()
            };
            if let Err(error) = resume_result {
                let _ = existing_player.shutdown();
                return Err(error);
            }
        }

        if let Some(surface) = self.native_surface.as_mut() {
            let attach_result =
                surface.set_embedded_content_attached(surface_window_handle.is_some());
            self.preview_player = Some(existing_player);
            attach_result?;
        } else {
            self.preview_player = Some(existing_player);
        }

        Ok(())
    }

    fn detach_native_surface(&mut self) -> Result<(), String> {
        let unbind_result = if let Some(preview_player) = self.preview_player.as_mut() {
            preview_player.bind_surface_handle(None)
        } else {
            Ok(())
        };
        if let Err(error) = unbind_result {
            return Err(self.fail_operation(
                "Failed to detach preview backend from the native surface",
                error,
            ));
        }
        if let Some(mut surface) = self.native_surface.take() {
            let detach_result = surface.detach();
            if let Err(error) = detach_result {
                return Err(self.fail_operation("Failed to detach native preview surface", error));
            }
        }
        Ok(())
    }

    fn sync_playback_position(&mut self) {
        if let Some(preview_player) = self.preview_player.as_ref() {
            self.position_ms = clamp_position(
                preview_player.query_position_ms(),
                preview_player.duration_ms(),
            );
            return;
        }

        if matches!(self.state, PreviewSessionState::Playing) {
            let duration_ms = self.playback_duration_ms();
            let next_position_ms = self
                .virtual_play_started_at
                .map(|started_at| {
                    self.virtual_play_base_position_ms
                        + started_at.elapsed().as_secs_f64() * 1000.0 * self.rate
                })
                .unwrap_or(self.position_ms);
            self.position_ms = clamp_position(next_position_ms, duration_ms);
            if self.position_ms >= duration_ms {
                self.stop_virtual_playback();
                self.state = PreviewSessionState::Ended;
            }
        }
    }

    fn start_virtual_playback(&mut self) {
        self.virtual_play_base_position_ms = self.position_ms;
        self.virtual_play_started_at = Some(Instant::now());
    }

    fn stop_virtual_playback(&mut self) {
        self.virtual_play_base_position_ms = self.position_ms;
        self.virtual_play_started_at = None;
    }

    fn surface_window_handle(&self) -> Option<usize> {
        self.native_surface
            .as_ref()
            .and_then(|surface| surface.surface_window_handle_value())
    }

    fn fail_operation(&mut self, operation: &str, error: String) -> String {
        let message = format!("{operation}: {error}");
        self.set_error(message.clone(), Some(error));
        message
    }
}

fn clip_covering_position(
    prepared_timeline: &GesPreviewTimeline,
    position_ms: f64,
) -> Option<&str> {
    prepared_timeline
        .clips
        .iter()
        .find(|clip| position_ms >= clip.start_ms && position_ms < clip.start_ms + clip.duration_ms)
        .map(|clip| clip.id.as_str())
}

fn playback_duration_ms(
    timeline: &TimelinePreviewSnapshot,
    timeline_has_no_clips: bool,
    preview_duration_ms: Option<f64>,
) -> f64 {
    preview_duration_ms.unwrap_or_else(|| {
        if timeline_has_no_clips && timeline.duration_ms <= 0.0 {
            EMPTY_TIMELINE_VIRTUAL_DURATION_MS
        } else {
            timeline.duration_ms
        }
    })
}

#[derive(Debug, Default)]
pub struct SessionTick {
    pub position_changed: bool,
    pub state_changed: bool,
    pub error_emitted: bool,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    use super::{PreviewSession, EMPTY_TIMELINE_VIRTUAL_DURATION_MS};
    use crate::media::model::{
        PreviewSessionState, PreviewViewport, TimelinePreviewFragment, TimelinePreviewSnapshot,
        TimelinePreviewTrack, TimelineTrackType,
    };
    use crate::media::preview::player::fail_next_bind_surface_and_preroll_for_tests;

    fn temp_case_dir(case_name: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_millis();
        let dir =
            std::env::temp_dir().join(format!("opendirector-preview-session-{case_name}-{suffix}"));
        fs::create_dir_all(&dir).expect("failed to create temp case dir");
        dir
    }

    fn build_snapshot() -> TimelinePreviewSnapshot {
        let case_dir = temp_case_dir("snapshot");
        let video_path = case_dir.join("clip.mp4");
        fs::write(&video_path, b"preview").expect("failed to write temp media");

        TimelinePreviewSnapshot {
            project_path: case_dir.to_string_lossy().to_string(),
            duration_ms: 1_000.0,
            fps: 25.0,
            canvas_width: 1280,
            canvas_height: 720,
            tracks: vec![TimelinePreviewTrack {
                id: "video-main".to_string(),
                track_type: TimelineTrackType::Video,
                muted: false,
                order: 0,
            }],
            fragments: vec![TimelinePreviewFragment {
                id: "clip-1".to_string(),
                track_id: "video-main".to_string(),
                absolute_path: video_path.to_string_lossy().to_string(),
                start_ms: 0.0,
                duration_ms: 1_000.0,
                trim_start_ms: 0.0,
                muted: false,
                volume: None,
                crop: None,
                transform: None,
            }],
        }
    }

    fn build_multi_clip_snapshot() -> TimelinePreviewSnapshot {
        let case_dir = temp_case_dir("multi-snapshot");
        let first_path = case_dir.join("clip-1.mp4");
        let second_path = case_dir.join("clip-2.mp4");
        fs::write(&first_path, b"preview-1").expect("failed to write first temp media");
        fs::write(&second_path, b"preview-2").expect("failed to write second temp media");

        TimelinePreviewSnapshot {
            project_path: case_dir.to_string_lossy().to_string(),
            duration_ms: 2_000.0,
            fps: 25.0,
            canvas_width: 1280,
            canvas_height: 720,
            tracks: vec![TimelinePreviewTrack {
                id: "video-main".to_string(),
                track_type: TimelineTrackType::Video,
                muted: false,
                order: 0,
            }],
            fragments: vec![
                TimelinePreviewFragment {
                    id: "clip-1".to_string(),
                    track_id: "video-main".to_string(),
                    absolute_path: first_path.to_string_lossy().to_string(),
                    start_ms: 0.0,
                    duration_ms: 800.0,
                    trim_start_ms: 0.0,
                    muted: false,
                    volume: None,
                    crop: None,
                    transform: None,
                },
                TimelinePreviewFragment {
                    id: "clip-2".to_string(),
                    track_id: "video-main".to_string(),
                    absolute_path: second_path.to_string_lossy().to_string(),
                    start_ms: 800.0,
                    duration_ms: 1_200.0,
                    trim_start_ms: 0.0,
                    muted: false,
                    volume: None,
                    crop: None,
                    transform: None,
                },
            ],
        }
    }

    fn build_empty_snapshot() -> TimelinePreviewSnapshot {
        TimelinePreviewSnapshot {
            project_path: temp_case_dir("empty-snapshot")
                .to_string_lossy()
                .to_string(),
            duration_ms: 0.0,
            fps: 25.0,
            canvas_width: 1280,
            canvas_height: 720,
            tracks: vec![TimelinePreviewTrack {
                id: "video-main".to_string(),
                track_type: TimelineTrackType::Video,
                muted: false,
                order: 0,
            }],
            fragments: Vec::new(),
        }
    }

    fn build_empty_duration_snapshot(duration_ms: f64) -> TimelinePreviewSnapshot {
        TimelinePreviewSnapshot {
            project_path: temp_case_dir("empty-duration-snapshot")
                .to_string_lossy()
                .to_string(),
            duration_ms,
            fps: 25.0,
            canvas_width: 1280,
            canvas_height: 720,
            tracks: vec![TimelinePreviewTrack {
                id: "video-main".to_string(),
                track_type: TimelineTrackType::Video,
                muted: false,
                order: 0,
            }],
            fragments: Vec::new(),
        }
    }

    fn build_short_snapshot(duration_ms: f64) -> TimelinePreviewSnapshot {
        let case_dir = temp_case_dir("short-snapshot");
        let video_path = case_dir.join("clip.mp4");
        fs::write(&video_path, b"preview-short").expect("failed to write temp media");

        TimelinePreviewSnapshot {
            project_path: case_dir.to_string_lossy().to_string(),
            duration_ms,
            fps: 25.0,
            canvas_width: 1280,
            canvas_height: 720,
            tracks: vec![TimelinePreviewTrack {
                id: "video-main".to_string(),
                track_type: TimelineTrackType::Video,
                muted: false,
                order: 0,
            }],
            fragments: vec![TimelinePreviewFragment {
                id: "clip-short".to_string(),
                track_id: "video-main".to_string(),
                absolute_path: video_path.to_string_lossy().to_string(),
                start_ms: 0.0,
                duration_ms,
                trim_start_ms: 0.0,
                muted: false,
                volume: None,
                crop: None,
                transform: None,
            }],
        }
    }

    #[test]
    fn set_rate_normalizes_requested_rate() {
        let mut session = PreviewSession::new("session-1".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session
            .set_rate(100.0)
            .expect("setting rate should succeed");

        assert_eq!(session.rate, 16.0);
        assert_eq!(session.state, PreviewSessionState::Ready);
    }

    #[test]
    fn play_moves_session_to_playing_with_preview_backend() {
        let mut session = PreviewSession::new("session-2".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session.play().expect("play should succeed");

        assert_eq!(session.state, PreviewSessionState::Playing);
    }

    #[test]
    fn diagnostics_include_prepared_timeline_counts() {
        let mut session = PreviewSession::new("session-3".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        let diagnostics = session.diagnostics();

        assert_eq!(diagnostics.timeline_track_count, 1);
        assert_eq!(diagnostics.timeline_fragment_count, 1);
        assert_eq!(diagnostics.prepared_timeline_track_count, 1);
        assert_eq!(diagnostics.prepared_timeline_clip_count, 1);
        assert_eq!(diagnostics.playback_backend, "in-process-ges-pipeline");
        assert_eq!(diagnostics.configured_video_sink_type, None);
        assert_eq!(diagnostics.native_surface_type, None);
        assert!(!diagnostics.native_surface_embedded_content_attached);
    }

    #[test]
    fn remembers_requested_surface_presenting_state_without_attaching_surface() {
        let mut session = PreviewSession::new(
            "session-surface-presenting".to_string(),
            "main".to_string(),
            true,
        );

        assert!(!session.surface_presenting);

        session
            .set_surface_presenting(false, None)
            .expect("hiding a detached surface should succeed");
        assert!(!session.surface_presenting);

        session
            .set_surface_presenting(true, None)
            .expect("showing a detached surface should succeed");
        assert!(session.surface_presenting);
    }

    #[test]
    fn stores_viewport_updates_before_surface_attach() {
        let mut session = PreviewSession::new(
            "session-surface-viewport".to_string(),
            "main".to_string(),
            true,
        );

        session
            .set_viewport(
                PreviewViewport {
                    x: 12.0,
                    y: 34.0,
                    width: 640.0,
                    height: 360.0,
                    scale_factor: 2.0,
                    visible: true,
                },
                None,
            )
            .expect("storing viewport for a detached surface should succeed");

        let viewport = session
            .viewport
            .as_ref()
            .expect("viewport should be cached before attach");
        assert_eq!(viewport.x, 12.0);
        assert_eq!(viewport.y, 34.0);
        assert_eq!(viewport.width, 640.0);
        assert_eq!(viewport.height, 360.0);
        assert_eq!(viewport.scale_factor, 2.0);
        assert!(viewport.visible);
    }

    #[test]
    fn ignores_stale_surface_presenting_revisions() {
        let mut session = PreviewSession::new(
            "session-surface-presenting-revision".to_string(),
            "main".to_string(),
            true,
        );

        session
            .set_surface_presenting(true, Some(2))
            .expect("newer presenting revision should succeed");
        session
            .set_surface_presenting(false, Some(1))
            .expect("stale presenting revision should be ignored");

        assert!(session.surface_presenting);
        assert_eq!(session.surface_sync_revision, 2);
    }

    #[test]
    fn prepare_surface_attach_preserves_previously_requested_presenting_state() {
        let mut session = PreviewSession::new(
            "session-surface-presenting-attach".to_string(),
            "main".to_string(),
            true,
        );

        session
            .set_surface_presenting(true, Some(3))
            .expect("showing a detached surface should succeed");
        let desired_surface_presenting = session
            .prepare_surface_attach(
                Some(PreviewViewport {
                    x: 12.0,
                    y: 34.0,
                    width: 640.0,
                    height: 360.0,
                    scale_factor: 2.0,
                    visible: true,
                }),
                Some(3),
            )
            .expect("prepare should preserve the queued presenting state")
            .expect("surface sync should not be skipped");

        assert!(desired_surface_presenting);
        assert!(session.surface_presenting);
    }

    #[test]
    fn ignores_stale_viewport_revisions() {
        let mut session = PreviewSession::new(
            "session-surface-viewport-revision".to_string(),
            "main".to_string(),
            true,
        );

        session
            .set_viewport(
                PreviewViewport {
                    x: 12.0,
                    y: 34.0,
                    width: 640.0,
                    height: 360.0,
                    scale_factor: 2.0,
                    visible: true,
                },
                Some(4),
            )
            .expect("newer viewport revision should succeed");
        session
            .set_viewport(
                PreviewViewport {
                    x: 90.0,
                    y: 80.0,
                    width: 320.0,
                    height: 180.0,
                    scale_factor: 1.0,
                    visible: false,
                },
                Some(3),
            )
            .expect("stale viewport revision should be ignored");

        let viewport = session
            .viewport
            .as_ref()
            .expect("viewport should remain cached");
        assert_eq!(viewport.x, 12.0);
        assert_eq!(viewport.y, 34.0);
        assert_eq!(viewport.width, 640.0);
        assert_eq!(viewport.height, 360.0);
        assert_eq!(viewport.scale_factor, 2.0);
        assert!(viewport.visible);
        assert_eq!(session.surface_sync_revision, 4);
    }

    #[test]
    fn diagnostics_and_info_expose_platform_status_fields() {
        let session =
            PreviewSession::new("session-platform".to_string(), "main".to_string(), false);

        let info = session.info();
        assert!(!info.native_surface_supported);
        assert!(info.native_surface_implemented);
        assert_eq!(info.native_surface_platform_status, "unsupported");
        assert_eq!(
            info.native_surface_platform_reason.as_deref(),
            Some("Native preview surfaces are disabled in unit tests")
        );

        let diagnostics = session.diagnostics();
        assert!(!diagnostics.native_surface_supported);
        assert!(diagnostics.native_surface_implemented);
        assert_eq!(diagnostics.native_surface_platform_status, "unsupported");
        assert_eq!(
            diagnostics.native_surface_platform_reason.as_deref(),
            Some("Native preview surfaces are disabled in unit tests")
        );
        assert_eq!(diagnostics.configured_video_sink_type, None);
        assert_eq!(diagnostics.native_surface_type, None);
        assert!(!diagnostics.native_surface_embedded_content_attached);
    }

    #[test]
    fn seek_metrics_track_warm_cold_and_burst_counts() {
        let mut session = PreviewSession::new("session-4".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_multi_clip_snapshot())
            .expect("timeline should prepare");

        session.seek(100.0).expect("first seek should succeed");
        session.seek(200.0).expect("second seek should succeed");
        session.seek(1_200.0).expect("third seek should succeed");

        let diagnostics = session.diagnostics();
        assert_eq!(diagnostics.metrics.seek_count, 3);
        assert_eq!(diagnostics.metrics.warm_seek_count, 2);
        assert_eq!(diagnostics.metrics.cold_seek_count, 1);
        assert!(diagnostics.metrics.seek_burst_count >= 1);
        assert!(diagnostics.metrics.max_seek_burst_count >= 2);
        assert!(diagnostics.metrics.last_seek_latency_ms >= 0.0);
        assert!(
            diagnostics.metrics.max_seek_latency_ms >= diagnostics.metrics.last_seek_latency_ms
        );
    }

    #[test]
    fn seek_to_timeline_end_marks_session_ended_without_exceeding_backend_range() {
        let mut session = PreviewSession::new("session-5".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session
            .seek(1_000.0)
            .expect("seek to timeline end should succeed");

        assert_eq!(session.state, PreviewSessionState::Ended);
        assert_eq!(session.position_ms, 1_000.0);
    }

    #[test]
    fn step_frame_to_timeline_end_marks_session_ended() {
        let mut session = PreviewSession::new("session-6".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session.position_ms = 980.0;
        session
            .step_frame(1)
            .expect("stepping forward should succeed");

        assert_eq!(session.state, PreviewSessionState::Ended);
        assert_eq!(session.position_ms, 1_000.0);
    }

    #[test]
    fn shortening_a_playing_timeline_keeps_backend_at_the_new_end() {
        let mut session = PreviewSession::new("session-6a".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session
            .seek_paused_to_position(800.0)
            .expect("preparing backend position should succeed");
        session.state = PreviewSessionState::Playing;

        session
            .set_timeline(build_short_snapshot(500.0))
            .expect("shorter timeline should prepare");

        assert_eq!(session.state, PreviewSessionState::Ended);
        assert!((session.position_ms - 500.0).abs() <= 1.0);

        session
            .tick()
            .expect("tick should preserve the new end position");
        assert_eq!(session.state, PreviewSessionState::Ended);
        assert!((session.position_ms - 500.0).abs() <= 1.0);
    }

    #[test]
    fn failed_pending_preview_replacement_preserves_playing_backend() {
        let mut session = PreviewSession::new(
            "session-failed-preview-replacement".to_string(),
            "main".to_string(),
            false,
        );
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");
        session
            .play_from(250.0)
            .expect("preview playback should start");

        let original_position_ms = session.position_ms;
        fail_next_bind_surface_and_preroll_for_tests(1);

        let result = session.set_timeline(build_short_snapshot(500.0));

        assert!(result.is_err());
        assert_eq!(session.state, PreviewSessionState::Playing);
        assert_eq!(session.position_ms, original_position_ms);
        let preview_player = session
            .preview_player
            .as_ref()
            .expect("existing preview backend should be restored");
        assert!(preview_player.is_playing_for_tests());
        assert_eq!(preview_player.query_position_ms(), original_position_ms);
    }

    #[test]
    fn empty_timeline_does_not_create_preview_backend() {
        let mut session = PreviewSession::new("session-7".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_empty_snapshot())
            .expect("empty timeline should prepare");

        assert_eq!(session.state, PreviewSessionState::Ready);
        assert!(session.preview_player.is_none());
        assert!(session.timeline.is_some());
        assert!(session.prepared_timeline.is_some());
    }

    #[test]
    fn empty_timeline_can_play_without_preview_backend() {
        let mut session = PreviewSession::new("session-8".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_empty_duration_snapshot(1_000.0))
            .expect("empty timeline should prepare");

        session
            .play()
            .expect("play should succeed without preview backend");
        assert_eq!(session.state, PreviewSessionState::Playing);
        assert!(session.preview_player.is_none());

        session.virtual_play_started_at =
            Some(Instant::now() - std::time::Duration::from_millis(500));
        session
            .tick()
            .expect("tick should advance virtual playback");
        assert!(session.position_ms >= 450.0);
        assert_eq!(session.state, PreviewSessionState::Playing);

        session.virtual_play_started_at =
            Some(Instant::now() - std::time::Duration::from_millis(1_200));
        session.tick().expect("tick should end virtual playback");
        assert_eq!(session.position_ms, 1_000.0);
        assert_eq!(session.state, PreviewSessionState::Ended);
    }

    #[test]
    fn fully_empty_timeline_can_play_with_virtual_duration() {
        let mut session = PreviewSession::new("session-8a".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_empty_snapshot())
            .expect("fully empty timeline should prepare");

        session
            .play()
            .expect("play should succeed for a fully empty timeline");
        assert_eq!(session.state, PreviewSessionState::Playing);
        assert!(session.preview_player.is_none());

        session.virtual_play_started_at =
            Some(Instant::now() - std::time::Duration::from_millis(500));
        session
            .tick()
            .expect("tick should advance virtual playback");
        assert!(session.position_ms >= 450.0);
        assert_eq!(session.state, PreviewSessionState::Playing);

        session.virtual_play_started_at =
            Some(Instant::now() - std::time::Duration::from_millis(61_000));
        session
            .tick()
            .expect("tick should finish virtual playback at the synthetic end");
        assert_eq!(session.position_ms, EMPTY_TIMELINE_VIRTUAL_DURATION_MS);
        assert_eq!(session.state, PreviewSessionState::Ended);
    }

    #[test]
    fn empty_timeline_update_preserves_virtual_playback() {
        let mut session = PreviewSession::new("session-9".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_empty_duration_snapshot(1_000.0))
            .expect("initial empty timeline should prepare");
        session
            .play()
            .expect("play should succeed without preview backend");

        session.virtual_play_started_at =
            Some(Instant::now() - std::time::Duration::from_millis(400));

        session
            .set_timeline(build_empty_duration_snapshot(1_500.0))
            .expect("updating empty timeline should preserve playback");

        assert_eq!(session.state, PreviewSessionState::Playing);
        assert!(session.preview_player.is_none());
        assert!(session.virtual_play_started_at.is_some());
        assert!(session.position_ms >= 350.0);
    }

    #[test]
    fn fully_empty_timeline_update_preserves_virtual_playback() {
        let mut session = PreviewSession::new("session-9a".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_empty_snapshot())
            .expect("initial fully empty timeline should prepare");
        session
            .play()
            .expect("play should succeed without preview backend");

        session.virtual_play_started_at =
            Some(Instant::now() - std::time::Duration::from_millis(400));

        session
            .set_timeline(build_empty_snapshot())
            .expect("updating a fully empty timeline should preserve playback");

        assert_eq!(session.state, PreviewSessionState::Playing);
        assert!(session.preview_player.is_none());
        assert!(session.virtual_play_started_at.is_some());
        assert!(session.position_ms >= 350.0);
    }

    #[test]
    fn play_from_timeline_end_keeps_backend_and_session_at_end() {
        let mut session = PreviewSession::new("session-10".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session.play().expect("play should succeed");
        session
            .play_from(1_000.0)
            .expect("play_from to timeline end should succeed");

        assert_eq!(session.state, PreviewSessionState::Ended);
        assert_eq!(session.position_ms, 1_000.0);

        session
            .tick()
            .expect("tick after play_from timeline end should preserve end position");

        assert_eq!(session.state, PreviewSessionState::Ended);
        assert!(session.position_ms >= 999.0);
        assert!(session.position_ms <= 1_000.0);
    }
}
