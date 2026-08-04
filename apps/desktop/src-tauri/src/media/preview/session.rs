use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::media::ges::preview_timeline_builder::{build_preview_timeline, GesPreviewTimeline};
use crate::media::model::{
    PreviewDiagnostics, PreviewRuntimeDiagnostics, PreviewSessionErrorEvent, PreviewSessionFrameTimestampEvent,
    PreviewSessionInfo, PreviewSessionPositionEvent, PreviewSessionState, PreviewSessionStateEvent,
    PreviewViewport, TimelinePreviewSnapshot,
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
const FRAME_TIMESTAMP_EVENT: &str = "media-preview://frame-timestamp";
const FRAME_TIMESTAMP_STALENESS_THRESHOLD_MS: u128 = 200;
const CONSECUTIVE_SEEK_WINDOW_MS: f64 = 200.0;
const EMPTY_TIMELINE_VIRTUAL_DURATION_MS: f64 = 60_000.0;
// Non-fatal safety valve: a flushing seek whose seqnum-matched ASYNC_DONE never arrives is
// unpinned after this window so the session keeps tracking pipeline position.
const PENDING_SEEK_TIMEOUT: Duration = Duration::from_secs(5);

/// A dispatched flushing seek awaiting its seqnum-matched `ASYNC_DONE`. While one is pending the
/// session position stays pinned at `target_ms` (only a matching-generation frame sample may move
/// it). `metrics` is `Some` only for user seeks that should record seek latency/burst statistics;
/// step/preroll/rate re-seeks pin and await completion without inflating seek metrics.
#[derive(Debug)]
struct PendingSeek {
    target_ms: f64,
    seqnum: gst::Seqnum,
    issued_at: Instant,
    metrics: Option<(SeekKind, u64)>,
}

/// Discovery + GES/pipeline construction result. Built off any session lock (potentially on a
/// blocking thread) and then applied to a session via `install_rebuilt_timeline`.
pub struct PreviewRebuild {
    snapshot: TimelinePreviewSnapshot,
    prepared_timeline: GesPreviewTimeline,
    player: Option<GstreamerPreviewPlayer>,
}

impl PreviewRebuild {
    pub fn build(snapshot: TimelinePreviewSnapshot) -> Result<Self, String> {
        let prepared_timeline = build_preview_timeline(&snapshot)?;
        let player = if prepared_timeline.clips.is_empty() {
            None
        } else {
            Some(GstreamerPreviewPlayer::new_pending(&prepared_timeline)?)
        };
        Ok(Self {
            snapshot,
            prepared_timeline,
            player,
        })
    }

    /// Discard a rebuild that will not be installed (superseded by a newer submission), shutting
    /// down any pipeline it prepared so it never leaks.
    pub fn shutdown(self) {
        if let Some(mut player) = self.player {
            let _ = player.shutdown();
        }
    }
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
    transport_epoch: u64,
    pending_seek: Option<PendingSeek>,
    // Seqnum of the most recently dispatched flushing seek. Unlike `pending_seek` it is NOT
    // cleared on completion or by the safety valve, so a genuine post-seek EOS (which inherits the
    // seek's seqnum) can be distinguished from a stale EOS long after the seek settled.
    last_seek_seqnum: Option<gst::Seqnum>,
    last_frame_timestamp_ms: f64,
    last_frame_timestamp_at: Option<Instant>,
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
            transport_epoch: 0,
            pending_seek: None,
            last_seek_seqnum: None,
            last_frame_timestamp_ms: 0.0,
            last_frame_timestamp_at: None,
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
            transport_epoch: self.transport_epoch,
            pending_seek_target_ms: self.pending_seek.as_ref().map(|pending| pending.target_ms),
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
        if matches!(self.state, PreviewSessionState::Destroyed) {
            return Ok(());
        }

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
        if matches!(self.state, PreviewSessionState::Destroyed) {
            return Ok(());
        }
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
        if matches!(self.state, PreviewSessionState::Destroyed) {
            return Ok(());
        }
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

    // Synchronous build + install. Production drives the two phases separately so discovery runs
    // off the session lock (see `PreviewSessionManager::set_timeline`); this convenience keeps the
    // pairing testable in-process.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn set_timeline(&mut self, snapshot: TimelinePreviewSnapshot) -> Result<(), String> {
        let rebuild = PreviewRebuild::build(snapshot).map_err(|error| {
            let message = format!("Failed to build preview timeline: {error}");
            self.set_error(message.clone(), Some(error));
            message
        })?;
        self.install_rebuilt_timeline(rebuild)
    }

    pub fn install_rebuilt_timeline(&mut self, rebuild: PreviewRebuild) -> Result<(), String> {
        let PreviewRebuild {
            snapshot: timeline,
            prepared_timeline,
            player,
        } = rebuild;

        // The session may have been destroyed while this rebuild was built off-lock. Discard the
        // freshly built pipeline instead of resurrecting a torn-down session and leaking it.
        if matches!(self.state, PreviewSessionState::Destroyed) {
            if let Some(mut player) = player {
                let _ = player.shutdown();
            }
            return Err("preview session was destroyed".to_string());
        }

        let was_playing = matches!(self.state, PreviewSessionState::Playing);
        self.sync_playback_position();
        let previous_position_ms = self.position_ms;
        let previous_virtual_play_started_at = self.virtual_play_started_at;
        let previous_virtual_play_base_position_ms = self.virtual_play_base_position_ms;

        let next_duration_ms =
            playback_duration_ms(&timeline, prepared_timeline.clips.is_empty(), None);

        self.stop_virtual_playback();
        self.position_ms = clamp_position(self.position_ms, next_duration_ms);
        self.reset_frame_timestamps();

        match player {
            None => {
                if let Err(error) = self.replace_preview_player(None) {
                    return Err(self.fail_operation(
                        "Failed to reset preview backend for empty timeline",
                        error,
                    ));
                }
            }
            Some(player) => {
                if let Err(error) = self.replace_preview_player_with_pending(player) {
                    // Swap failed. The session moves to Error state via fail_operation below.
                    // On some failure paths — notably the Windows block, which retires the old
                    // player before prerolling the new one — the old player is already shut down
                    // and self.preview_player is None, so the front end must rebuild on the next
                    // set_timeline. Position and virtual-playback state are restored regardless.
                    self.position_ms = previous_position_ms;
                    self.virtual_play_started_at = previous_virtual_play_started_at;
                    self.virtual_play_base_position_ms = previous_virtual_play_base_position_ms;
                    return Err(self.fail_operation(
                        "Failed to bind preview backend to native preview surface",
                        error,
                    ));
                }
            }
        }

        // The pipeline was swapped for a fresh one; any seek in flight on the old pipeline is gone,
        // and its seqnum must not gate the new pipeline's genuine EOS.
        self.pending_seek = None;
        self.last_seek_seqnum = None;

        if was_playing && self.position_ms >= next_duration_ms {
            if let Some(preview_player) = self.preview_player.as_mut() {
                if next_duration_ms > 0.0 {
                    let seek_position_ms =
                        preview_player.clamp_seek_position_ms(next_duration_ms);
                    match preview_player.seek_paused(seek_position_ms) {
                        Ok(seqnum) => self.set_pending_seek(seek_position_ms, seqnum, None),
                        Err(error) => {
                            return Err(self.fail_operation(
                                "Failed to position preview backend at the updated timeline end",
                                error,
                            ))
                        }
                    }
                } else if let Err(error) = preview_player.pause() {
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
                let play_position_ms = self.position_ms;
                match preview_player.play(play_position_ms, self.rate) {
                    Ok(seqnum) => self.set_pending_seek(play_position_ms, seqnum, None),
                    Err(error) => {
                        return Err(self.fail_operation(
                            "Failed to resume preview backend after timeline update",
                            error,
                        ))
                    }
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

    // Gate shared by every transport entry point: commands arriving after destroy or
    // carrying a stale epoch are dropped as no-ops; fresh commands adopt their epoch.
    fn accept_transport_command(&mut self, epoch: u64) -> bool {
        if matches!(self.state, PreviewSessionState::Destroyed) {
            return false;
        }
        if epoch < self.transport_epoch {
            return false;
        }
        self.transport_epoch = epoch;
        true
    }

    // Drop the frame-PTS state and any latched frame sample together (contract R3):
    // around a flushing seek, a pre-flush PTS must never rewind the trusted position.
    fn discard_frame_samples(&mut self) {
        self.reset_frame_timestamps();
        if let Some(preview_player) = self.preview_player.as_ref() {
            preview_player.clear_frame_sample();
        }
    }

    pub fn play(&mut self, epoch: u64) -> Result<(), String> {
        if !self.accept_transport_command(epoch) {
            return Ok(());
        }

        if self.timeline.is_none() {
            self.set_error("Cannot play before timeline is attached", None);
            return Err("Cannot play before timeline is attached".to_string());
        }

        // Play from the trusted position_ms (a pinned seek target while a seek is pending);
        // clear any stale frame sample so playback never resumes from a pre-seek PTS.
        self.discard_frame_samples();

        let duration_ms = self.effective_duration_ms();
        if self.position_ms >= duration_ms {
            self.position_ms = duration_ms;
            self.state = PreviewSessionState::Ended;
            return Ok(());
        }

        if let Some(preview_player) = self.preview_player.as_mut() {
            let previous_position_ms = self.position_ms;
            let play_position_ms = preview_player.clamp_seek_position_ms(self.position_ms);
            match preview_player.play(play_position_ms, self.rate) {
                Ok(seqnum) => {
                    self.position_ms = play_position_ms;
                    self.begin_metered_pending_seek(previous_position_ms, play_position_ms, seqnum);
                }
                Err(error) => {
                    return Err(self.fail_operation("Failed to start preview playback", error))
                }
            }
        } else {
            self.start_virtual_playback();
        }
        self.state = PreviewSessionState::Playing;
        self.last_error = None;
        self.metrics.play_count += 1;
        Ok(())
    }

    pub fn play_from(&mut self, time_ms: f64, epoch: u64) -> Result<(), String> {
        if !self.accept_transport_command(epoch) {
            return Ok(());
        }

        if self.timeline.is_none() {
            self.set_error("Cannot play before timeline is attached", None);
            return Err("Cannot play before timeline is attached".to_string());
        }

        self.discard_frame_samples();
        let previous_position_ms = self.position_ms;
        let duration_ms = self.effective_duration_ms();
        self.position_ms = clamp_position(time_ms, duration_ms);

        if self.position_ms >= duration_ms {
            self.seek_to_session_end(None)?;
            self.last_error = None;
            return Ok(());
        }

        if let Some(preview_player) = self.preview_player.as_mut() {
            let play_position_ms = preview_player.clamp_seek_position_ms(self.position_ms);
            match preview_player.play(play_position_ms, self.rate) {
                Ok(seqnum) => {
                    self.position_ms = play_position_ms;
                    self.begin_metered_pending_seek(previous_position_ms, play_position_ms, seqnum);
                }
                Err(error) => {
                    return Err(self.fail_operation("Failed to start preview playback", error))
                }
            }
        } else {
            self.start_virtual_playback();
        }

        self.state = PreviewSessionState::Playing;
        self.last_error = None;
        self.metrics.play_count += 1;
        Ok(())
    }

    pub fn pause(&mut self, epoch: u64) -> Result<(), String> {
        if !self.accept_transport_command(epoch) {
            return Ok(());
        }

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

    pub fn seek(&mut self, time_ms: f64, epoch: u64) -> Result<(), String> {
        if !self.accept_transport_command(epoch) {
            return Ok(());
        }

        let previous_position_ms = self.position_ms;
        let was_playing = matches!(self.state, PreviewSessionState::Playing);
        self.discard_frame_samples();
        let duration_ms = self.effective_duration_ms();
        self.state = PreviewSessionState::Seeking;
        self.position_ms = clamp_position(time_ms, duration_ms);
        let seek_metrics =
            Some((self.classify_seek(previous_position_ms, self.position_ms), self.next_seek_burst_count()));

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
            // No pipeline to await: record seek metrics immediately.
            if let Some((kind, burst_count)) = seek_metrics {
                self.record_completed_seek(kind, 0.0, burst_count);
            }
            self.last_error = None;
            return Ok(());
        }

        if self.position_ms >= duration_ms {
            self.seek_to_session_end(seek_metrics)?;
            return Ok(());
        }

        let Some(preview_player) = self.preview_player.as_mut() else {
            // Unreachable: the pipeline-less path returned above.
            return Ok(());
        };
        let seek_position_ms = preview_player.clamp_seek_position_ms(self.position_ms);
        self.position_ms = seek_position_ms;

        let seek_result = if was_playing {
            preview_player.play(seek_position_ms, self.rate)
        } else {
            preview_player.seek_paused(seek_position_ms)
        };
        match seek_result {
            Ok(seqnum) => self.set_pending_seek(seek_position_ms, seqnum, seek_metrics),
            Err(error) => {
                let operation = if was_playing {
                    "Failed to resume preview playback after seek"
                } else {
                    "Failed to seek paused preview playback"
                };
                return Err(self.fail_operation(operation, error));
            }
        }

        self.state = if was_playing {
            PreviewSessionState::Playing
        } else {
            PreviewSessionState::Paused
        };
        self.last_error = None;
        Ok(())
    }

    pub fn step_frame(&mut self, direction: i32, epoch: u64) -> Result<(), String> {
        if !self.accept_transport_command(epoch) {
            return Ok(());
        }

        self.stop_virtual_playback();
        self.discard_frame_samples();
        let duration_ms = self.effective_duration_ms();
        let frame_duration_ms = self.frame_duration_ms();
        self.position_ms = clamp_position(
            self.position_ms + frame_duration_ms * if direction >= 0 { 1.0 } else { -1.0 },
            duration_ms,
        );

        if self.position_ms >= duration_ms {
            self.seek_to_session_end(None)?;
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

    pub fn set_rate(&mut self, rate: f64, epoch: u64) -> Result<(), String> {
        if !self.accept_transport_command(epoch) {
            return Ok(());
        }

        self.sync_playback_position();
        self.rate = normalize_rate(rate);
        if matches!(self.state, PreviewSessionState::Playing) {
            // A rate change dispatches a flushing seek; clear the frame-PTS state first so a
            // pre-rate sample cannot rewind the pinned position (contract R3).
            self.discard_frame_samples();
            let target_ms = self.position_ms;
            if let Some(preview_player) = self.preview_player.as_mut() {
                match preview_player.play(target_ms, self.rate) {
                    Ok(seqnum) => self.set_pending_seek(target_ms, seqnum, None),
                    Err(error) => {
                        return Err(
                            self.fail_operation("Failed to update preview playback rate", error)
                        )
                    }
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
        self.timeline = None;
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
                epoch: self.transport_epoch,
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
                epoch: self.transport_epoch,
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

    fn drain_frame_timestamps(&mut self) -> bool {
        if let Some(preview_player) = self.preview_player.as_ref() {
            let current_generation = preview_player.seek_generation();
            // Only accept samples stamped with the current seek generation; anything older
            // predates the most recent flushing seek and would teleport the playhead backwards.
            if let Some(sample) = preview_player.take_frame_sample() {
                if sample.generation == current_generation {
                    self.last_frame_timestamp_ms = sample.pts_ms;
                    self.last_frame_timestamp_at = Some(Instant::now());
                }
            }
        }
        if let Some(last_at) = self.last_frame_timestamp_at {
            if last_at.elapsed().as_millis() < FRAME_TIMESTAMP_STALENESS_THRESHOLD_MS {
                let duration_ms = self.duration_ms();
                self.position_ms = clamp_position(self.last_frame_timestamp_ms, duration_ms);
                return true;
            }
        }
        false
    }

    fn reset_frame_timestamps(&mut self) {
        self.last_frame_timestamp_ms = 0.0;
        self.last_frame_timestamp_at = None;
    }

    pub fn emit_frame_timestamp(&self, app: &AppHandle) -> Result<(), String> {
        app.emit(
            FRAME_TIMESTAMP_EVENT,
            PreviewSessionFrameTimestampEvent {
                session_id: self.session_id.clone(),
                position_ms: self.position_ms,
                epoch: self.transport_epoch,
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

    fn frame_duration_ms(&self) -> f64 {
        match self.timeline.as_ref() {
            Some(timeline) if timeline.fps > 0.0 => 1000.0 / timeline.fps,
            _ => 1000.0 / 30.0,
        }
    }

    // EOS messages are not flushed off the bus by a seek and, unlike ASYNC_DONE, can predate the
    // current segment. GStreamer stamps a post-seek EOS with the seek's seqnum, so honor EOS only
    // when it carries the most recent seek's seqnum (or no seek was ever dispatched — natural
    // playout). As a fallback for any GES element that drops the seqnum, also accept EOS when
    // nothing is pending and the pipeline is already parked within a frame of the end.
    fn should_honor_eos(&self, eos_seqnums: &[gst::Seqnum]) -> bool {
        if eos_seqnums.is_empty() {
            return false;
        }
        if self
            .last_seek_seqnum
            .map_or(true, |seqnum| eos_seqnums.contains(&seqnum))
        {
            return true;
        }
        if self.pending_seek.is_none() {
            if let Some(preview_player) = self.preview_player.as_ref() {
                if let Some(position_ms) = preview_player.query_position_ms() {
                    return position_ms >= self.duration_ms() - self.frame_duration_ms();
                }
            }
        }
        false
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

    fn seek_to_session_end(
        &mut self,
        seek_metrics: Option<(SeekKind, u64)>,
    ) -> Result<(), String> {
        let duration_ms = self.effective_duration_ms();
        if let Some(preview_player) = self.preview_player.as_mut() {
            let seek_position_ms = preview_player.clamp_seek_position_ms(duration_ms);
            if duration_ms > 0.0 {
                match preview_player.seek_paused(seek_position_ms) {
                    Ok(seqnum) => self.set_pending_seek(seek_position_ms, seqnum, seek_metrics),
                    Err(error) => {
                        return Err(self.fail_operation(
                            "Failed to seek preview backend to the last frame",
                            error,
                        ))
                    }
                }
            } else if let Err(error) = preview_player.pause() {
                return Err(self.fail_operation(
                    "Failed to pause preview backend at empty-session end",
                    error,
                ));
            }
        }

        self.position_ms = duration_ms;
        self.state = PreviewSessionState::Ended;
        Ok(())
    }

    fn seek_paused_to_position(&mut self, position_ms: f64) -> Result<(), String> {
        if let Some(preview_player) = self.preview_player.as_mut() {
            let seek_position_ms = preview_player.clamp_seek_position_ms(position_ms);
            match preview_player.seek_paused(seek_position_ms) {
                Ok(seqnum) => {
                    self.position_ms = seek_position_ms;
                    self.set_pending_seek(seek_position_ms, seqnum, None);
                }
                Err(error) => {
                    return Err(self.fail_operation("Failed to seek paused preview backend", error))
                }
            }
        } else {
            self.position_ms = position_ms;
        }

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

    fn begin_metered_pending_seek(
        &mut self,
        previous_position_ms: f64,
        target_ms: f64,
        seqnum: gst::Seqnum,
    ) {
        let metrics = Some((
            self.classify_seek(previous_position_ms, target_ms),
            self.next_seek_burst_count(),
        ));
        self.set_pending_seek(target_ms, seqnum, metrics);
    }

    fn set_pending_seek(
        &mut self,
        target_ms: f64,
        seqnum: gst::Seqnum,
        metrics: Option<(SeekKind, u64)>,
    ) {
        // Remember the seqnum for EOS gating; unlike `pending_seek` it survives completion so a
        // genuine post-seek EOS arriving later still matches (see `should_honor_eos`).
        self.last_seek_seqnum = Some(seqnum);
        self.pending_seek = Some(PendingSeek {
            target_ms,
            seqnum,
            issued_at: Instant::now(),
            metrics,
        });
    }

    // Called from tick() when a pending seek's seqnum-matched ASYNC_DONE arrives: unpin the
    // position, fold in seek latency metrics (for user seeks only), and repaint the freshly
    // seeked frame on macOS when the pipeline is not playing.
    fn record_completed_seek(&mut self, kind: SeekKind, latency_ms: f64, burst_count: u64) {
        self.metrics.record_seek(kind, latency_ms, burst_count);
        self.last_seek_completed_at = Some(Instant::now());
    }

    fn complete_pending_seek(&mut self) {
        let Some(pending) = self.pending_seek.take() else {
            return;
        };
        if let Some((kind, burst_count)) = pending.metrics {
            let latency_ms = pending.issued_at.elapsed().as_secs_f64() * 1000.0;
            self.record_completed_seek(kind, latency_ms, burst_count);
        }
        if !matches!(self.state, PreviewSessionState::Playing) {
            if let Some(preview_player) = self.preview_player.as_ref() {
                preview_player.expose_on_seek_complete();
            }
        }
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
            } else {
                if let Some(pending) = self.pending_seek.as_ref() {
                    if poll
                        .async_done_seqnums
                        .iter()
                        .any(|seqnum| *seqnum == pending.seqnum)
                    {
                        self.complete_pending_seek();
                    }
                }
                if self.should_honor_eos(&poll.eos_seqnums) {
                    // A genuine end-of-stream: unpin any in-flight seek (a stale target must not
                    // hold the playhead past the end) and drop its frame sample, then settle.
                    if self.pending_seek.take().is_some() {
                        self.discard_frame_samples();
                    }
                    self.position_ms = self.duration_ms();
                    self.state = PreviewSessionState::Ended;
                }
            }
        }

        // GES/nlecomposition does not propagate seek-event seqnums onto ASYNC_DONE (observed:
        // ASYNC_DONE carries unrelated seqnums on every seek), so the seqnum fast-path above
        // rarely fires on GES pipelines. Confirm completion by observation instead: once the
        // pipeline reports a position at (or, while playing, just past) the target, the flush
        // has landed and the pin can lift. Clear the frame slot at that point — it may still
        // hold a pre-flush sample stamped with the current generation.
        if let Some(pending) = self.pending_seek.as_ref() {
            if let Some(queried_ms) = self
                .preview_player
                .as_ref()
                .and_then(|preview_player| preview_player.query_position_ms())
            {
                let elapsed_ms = pending.issued_at.elapsed().as_secs_f64() * 1000.0;
                let slack_ms = if matches!(self.state, PreviewSessionState::Playing) {
                    elapsed_ms + 200.0
                } else {
                    50.0
                };
                if queried_ms >= pending.target_ms - 50.0
                    && queried_ms <= pending.target_ms + slack_ms
                {
                    self.complete_pending_seek();
                    self.discard_frame_samples();
                }
            }
        }

        // Safety valve: unpin a seek whose ASYNC_DONE never arrived, without poisoning the session.
        // Also drop any frame sample latched under the pin so a pre-flush PTS can't rewind us.
        if let Some(pending) = self.pending_seek.as_ref() {
            if pending.issued_at.elapsed() > PENDING_SEEK_TIMEOUT {
                self.pending_seek = None;
                self.discard_frame_samples();
            }
        }

        let playing = matches!(self.state, PreviewSessionState::Playing);
        let has_player = self.preview_player.is_some();

        if self.pending_seek.is_some() {
            // Position stays pinned at the seek target until the seqnum-matched ASYNC_DONE lands.
            // We never drain here: a buffer carrying the current generation can still be a pre-flush
            // frame, and ASYNC_DONE cannot fire until a post-flush buffer has overwritten the slot,
            // so by the tick that unpins, the slot already holds a genuine post-seek PTS.
        } else if playing && has_player {
            if self.drain_frame_timestamps() {
                tick.position_source_is_frame_timestamp = true;
            } else {
                self.sync_playback_position();
            }
        } else {
            self.sync_playback_position();
        }

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
    ) -> Result<(), String> {
        let surface_window_handle = self.surface_window_handle();

        // The order of "retire old player" vs "preroll new player" is platform-dependent and
        // the two requirements are mutually exclusive, so this function branches on the target
        // OS rather than sharing one sequence.
        //
        // Windows (d3d11videosink): the old sink MUST release its SetWindowLongPtrW subclassing
        // of the surface HWND — restored when shutdown() drives the pipeline to Null — BEFORE the
        // new sink binds the same HWND. If both subclass the HWND at once, SetWindowLongPtrW
        // returns the prior subclass proc as the "original" proc, so external_window_proc ==
        // sub_class_proc and d3d11 asserts/aborts (STATUS_STACK_BUFFER_OVERRUN). Commit ef72a75
        // flipped this to preroll-first to fix a macOS seek race and regressed Windows; every
        // timeline rebuild hits this path and crashed.
        //
        // macOS (glimagesink): no HWND subclassing, so the opposite order is required — preroll
        // the new pipeline before retiring the old one — to avoid the seek race ef72a75 fixed.
        #[cfg(target_os = "windows")]
        {
            // Retire the old player first so its d3d11 sink releases the surface HWND's wndproc
            // subclassing before the new sink binds it. Note this forfeits the "preroll failure
            // leaves the old player in place" guarantee: if the new player fails to preroll after
            // the old one is shut down, the session is left with no player (Error state, front end
            // can rebuild). A crash is strictly worse than a transiently empty preview, and this
            // matches pre-ef72a75 Windows behavior.
            if let Some(surface) = self.native_surface.as_mut() {
                if let Err(error) = surface.set_embedded_content_attached(false) {
                    let _ = preview_player.shutdown();
                    return Err(error);
                }
            }

            let mut existing = self.preview_player.take();
            if let Some(existing_player) = existing.as_mut() {
                if let Err(error) = existing_player.shutdown() {
                    self.preview_player = existing;
                    if let Some(surface) = self.native_surface.as_mut() {
                        let _ = surface.set_embedded_content_attached(surface_window_handle.is_some());
                    }
                    return Err(error);
                }
            }

            if let Err(error) = preview_player.bind_surface_and_preroll(surface_window_handle) {
                let _ = preview_player.shutdown();
                return Err(error);
            }

            if let Some(surface) = self.native_surface.as_mut() {
                if let Err(error) =
                    surface.set_embedded_content_attached(surface_window_handle.is_some())
                {
                    let _ = preview_player.shutdown();
                    return Err(error);
                }
            }

            self.preview_player = Some(preview_player);
            Ok(())
        }

        #[cfg(not(target_os = "windows"))]
        {
            // Preroll the NEW pipeline before retiring the old one so a preroll/bind failure
            // leaves the existing player untouched and the session still usable (ef72a75 fix).
            if let Err(error) = preview_player.bind_surface_and_preroll(surface_window_handle) {
                let _ = preview_player.shutdown();
                return Err(error);
            }

            if let Some(surface) = self.native_surface.as_mut() {
                let _ = surface.set_embedded_content_attached(false);
            }

            let mut existing = self.preview_player.take();
            if let Some(existing_player) = existing.as_mut() {
                if let Err(error) = existing_player.shutdown() {
                    // Keep the old player; discard the freshly prerolled one.
                    let _ = preview_player.shutdown();
                    self.preview_player = existing;
                    if let Some(surface) = self.native_surface.as_mut() {
                        let _ = surface.set_embedded_content_attached(surface_window_handle.is_some());
                    }
                    return Err(error);
                }
            }

            if let Some(surface) = self.native_surface.as_mut() {
                if let Err(error) =
                    surface.set_embedded_content_attached(surface_window_handle.is_some())
                {
                    let _ = preview_player.shutdown();
                    return Err(error);
                }
            }

            self.preview_player = Some(preview_player);
            Ok(())
        }
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
        // While a flushing seek is in flight the position is pinned at its target (I1); the
        // pipeline still reports the pre-seek position until the flush lands.
        if self.pending_seek.is_some() {
            return;
        }

        if let Some(preview_player) = self.preview_player.as_ref() {
            // A failed position query keeps the previous position instead of teleporting to 0.
            if let Some(position_ms) = preview_player.query_position_ms() {
                self.position_ms = clamp_position(position_ms, preview_player.duration_ms());
            }
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
    pub position_source_is_frame_timestamp: bool,
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
            .set_rate(100.0, 1)
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

        session.play(1).expect("play should succeed");

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

        // Seek latency is now measured dispatch -> seqnum-matched ASYNC_DONE, so each seek is
        // completed by a tick before the metrics are recorded.
        session.seek(100.0, 1).expect("first seek should succeed");
        session.tick().expect("tick completes the first seek");
        session.seek(200.0, 2).expect("second seek should succeed");
        session.tick().expect("tick completes the second seek");
        session.seek(1_200.0, 3).expect("third seek should succeed");
        session.tick().expect("tick completes the third seek");

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
            .seek(1_000.0, 1)
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
            .step_frame(1, 1)
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
    fn failed_pending_preview_replacement_yields_error_state() {
        let mut session = PreviewSession::new(
            "session-failed-preview-replacement".to_string(),
            "main".to_string(),
            false,
        );
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");
        session
            .play_from(250.0, 1)
            .expect("preview playback should start");

        fail_next_bind_surface_and_preroll_for_tests(1);

        let result = session.set_timeline(build_short_snapshot(500.0));

        assert!(result.is_err());
        assert_eq!(session.state, PreviewSessionState::Error);
        assert!(session.last_error.is_some());
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
            .play(1)
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
            .play(1)
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
            .play(1)
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
            .play(1)
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

        session.play(1).expect("play should succeed");
        session
            .play_from(1_000.0, 2)
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

    fn build_missing_asset_snapshot() -> TimelinePreviewSnapshot {
        // References a file that was never created, so asset discovery (path canonicalization)
        // fails and the rebuild is rejected before any pipeline is touched.
        let case_dir = temp_case_dir("missing-asset");
        let missing_path = case_dir.join("missing.mp4");

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
                id: "clip-missing".to_string(),
                track_id: "video-main".to_string(),
                absolute_path: missing_path.to_string_lossy().to_string(),
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

    #[test]
    fn tick_with_pending_seek_keeps_position_pinned() {
        let mut session = PreviewSession::new("session-pin".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        // Pin the position at a target with a seek whose ASYNC_DONE will not arrive this tick.
        session.position_ms = 250.0;
        session.pending_seek = Some(super::PendingSeek {
            target_ms: 250.0,
            seqnum: gst::Seqnum::next(),
            issued_at: Instant::now(),
            metrics: None,
        });

        session
            .tick()
            .expect("ticking with a pending seek should succeed");

        assert_eq!(session.position_ms, 250.0);
        assert!(session.pending_seek.is_some());
    }

    #[test]
    fn stale_epoch_transport_command_is_a_no_op() {
        let mut session =
            PreviewSession::new("session-epoch".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session.seek(300.0, 5).expect("seek at epoch 5 should succeed");
        let pinned_position_ms = session.position_ms;

        session
            .seek(0.0, 4)
            .expect("a superseded (lower epoch) seek is dropped as a no-op");

        assert_eq!(session.position_ms, pinned_position_ms);
        assert_eq!(session.transport_epoch, 5);
    }

    #[test]
    fn stale_generation_frame_sample_is_discarded() {
        use crate::media::preview::player::FrameSample;

        let mut session =
            PreviewSession::new("session-generation".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");
        session.play(1).expect("play should succeed");
        session.tick().expect("tick completes the play seek");
        let baseline_position_ms = session.position_ms;

        // A sample stamped with an older generation predates the last flushing seek.
        if let Some(player) = session.preview_player.as_mut() {
            player.set_frame_sample_for_tests(FrameSample {
                generation: 0,
                pts_ms: 999.0,
            });
        }
        session
            .tick()
            .expect("tick discarding the stale sample should succeed");
        assert_eq!(session.position_ms, baseline_position_ms);

        // A current-generation sample is accepted and advances the playhead.
        let current_generation = session
            .preview_player
            .as_ref()
            .expect("preview player should exist")
            .seek_generation();
        if let Some(player) = session.preview_player.as_mut() {
            player.set_frame_sample_for_tests(FrameSample {
                generation: current_generation,
                pts_ms: 500.0,
            });
        }
        session
            .tick()
            .expect("tick applying the fresh sample should succeed");
        assert!((session.position_ms - 500.0).abs() < 1.0);
    }

    #[test]
    fn transport_epoch_is_adopted_and_exposed() {
        let mut session =
            PreviewSession::new("session-epoch-adopt".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        session.seek(100.0, 7).expect("seek at epoch 7 should succeed");

        // Event helpers stamp `self.transport_epoch`; assert the adopted value it exposes.
        assert_eq!(session.transport_epoch, 7);
        let diagnostics = session.diagnostics();
        assert_eq!(diagnostics.transport_epoch, 7);
        assert!(diagnostics.pending_seek_target_ms.is_some());
    }

    #[test]
    fn set_timeline_with_undiscoverable_asset_keeps_session_alive() {
        let mut session =
            PreviewSession::new("session-missing".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("initial timeline should prepare");
        session
            .play_from(200.0, 1)
            .expect("preview playback should start");
        assert!(session.preview_player.is_some());

        let result = session.set_timeline(build_missing_asset_snapshot());

        assert!(result.is_err());
        // The failed rebuild never touched the pipeline: the old player and timeline are retained.
        assert!(session.preview_player.is_some());
        assert!(session.timeline.is_some());
        assert!(session.last_error.is_some());
    }

    #[test]
    fn play_clears_any_staged_frame_sample() {
        use crate::media::preview::player::FrameSample;

        let mut session =
            PreviewSession::new("session-play-clear".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");

        // Stage a sample as if a pre-play buffer had already been latched into the slot.
        if let Some(player) = session.preview_player.as_mut() {
            player.set_frame_sample_for_tests(FrameSample {
                generation: 0,
                pts_ms: 999.0,
            });
        }

        session.play(1).expect("play should succeed");

        // R6/I4: play() clears the frame slot so playback never resumes from a stale pre-seek PTS.
        let residual = session
            .preview_player
            .as_ref()
            .expect("preview player should exist")
            .take_frame_sample();
        assert!(residual.is_none());
    }

    #[test]
    fn set_rate_while_playing_does_not_rewind_to_a_stale_frame_timestamp() {
        let mut session =
            PreviewSession::new("session-rate-pin".to_string(), "main".to_string(), false);
        session
            .set_timeline(build_snapshot())
            .expect("timeline should prepare");
        session.play_from(300.0, 1).expect("playback should start");
        session.tick().expect("tick completes the play seek");

        // A fresh pre-rate-change frame timestamp must not survive the rate change and rewind us.
        session.position_ms = 300.0;
        session.last_frame_timestamp_ms = 120.0;
        session.last_frame_timestamp_at = Some(Instant::now());

        session.set_rate(2.0, 2).expect("changing rate should succeed");
        let target_ms = session.position_ms;
        session
            .tick()
            .expect("tick after the rate change should succeed");

        assert!((session.position_ms - target_ms).abs() < 1.0);
    }
}
