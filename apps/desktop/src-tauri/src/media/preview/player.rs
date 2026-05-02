use crate::media::ges::preview_timeline_builder::GesPreviewTimeline;

use super::transport::clamp_position;

#[derive(Debug, Default)]
pub struct PreviewBackendPollResult {
    pub reached_eos: bool,
    pub last_error: Option<String>,
}

const SEEK_END_EPSILON_MS: f64 = 0.001;

fn sanitize_duration_ms(duration_ms: f64) -> f64 {
    if duration_ms.is_finite() {
        duration_ms.max(0.0)
    } else {
        0.0
    }
}

fn clamp_seek_position_ms(position_ms: f64, duration_ms: f64) -> f64 {
    let duration_ms = sanitize_duration_ms(duration_ms);
    let position_ms = if position_ms.is_finite() {
        clamp_position(position_ms, duration_ms)
    } else {
        0.0
    };

    if duration_ms <= 0.0 || position_ms < duration_ms {
        position_ms
    } else {
        (duration_ms - SEEK_END_EPSILON_MS).max(0.0)
    }
}

fn seek_segment_range_ms(position_ms: f64, duration_ms: f64) -> (f64, f64) {
    let duration_ms = sanitize_duration_ms(duration_ms);
    let start_ms = clamp_seek_position_ms(position_ms, duration_ms);
    (start_ms, duration_ms.max(start_ms))
}

pub fn configured_video_sink_type() -> Option<&'static str> {
    #[cfg(test)]
    {
        return None;
    }

    #[cfg(all(not(test), target_os = "windows"))]
    {
        return Some("d3d11videosink");
    }

    #[cfg(all(not(test), target_os = "macos"))]
    {
        return Some("glimagesink");
    }

    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
    {
        Some("autovideosink")
    }
}

#[cfg(not(test))]
mod imp {
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    use ges::prelude::*;
    use gst_video::prelude::*;

    use crate::media::ges::clip_modifiers::{apply_ges_clip_modifiers, GesClipModifierPlan};
    use crate::media::ges::preview_timeline_builder::GesPreviewClipPlan;
    use crate::media::model::TimelineTrackType;
    use crate::media::runtime::prepare_gstreamer_process_environment;

    use super::{
        clamp_seek_position_ms, sanitize_duration_ms, seek_segment_range_ms, GesPreviewTimeline,
        PreviewBackendPollResult,
    };

    const ASYNC_OPERATION_TIMEOUT: Duration = Duration::from_millis(1_000);

    #[derive(Debug)]
    pub struct GstreamerPreviewPlayer {
        pipeline: ges::Pipeline,
        _timeline: ges::Timeline,
        video_sink: Option<gst::Element>,
        surface_window_handle: Option<usize>,
        duration_ms: f64,
    }

    // SAFETY:
    // The preview manager serializes all access to preview sessions behind a single mutex.
    // GES/GStreamer bindings do not mark these generated wrapper types as `Send`, but this
    // application only moves the player as an opaque session-owned value between executor
    // tasks and never accesses it concurrently.
    unsafe impl Send for GstreamerPreviewPlayer {}

    impl GstreamerPreviewPlayer {
        pub fn new(
            prepared_timeline: &GesPreviewTimeline,
            surface_window_handle: Option<usize>,
        ) -> Result<Self, String> {
            prepare_gstreamer_process_environment()?;
            ges::init().map_err(|error| format!("failed to initialize GStreamer/GES: {error}"))?;

            let timeline = build_ges_timeline(prepared_timeline)?;
            let pipeline = ges::Pipeline::new();

            let video_sink = if prepared_timeline.has_video {
                let sink = create_video_sink()?;
                bind_video_overlay(&sink, surface_window_handle)?;
                pipeline.preview_set_video_sink(Some(&sink));
                Some(sink)
            } else {
                None
            };

            pipeline.set_timeline(&timeline).map_err(|error| {
                format!("failed to attach preview timeline to pipeline: {error}")
            })?;
            pipeline
                .set_mode(preview_mode(prepared_timeline))
                .map_err(|error| format!("failed to set preview pipeline mode: {error}"))?;
            pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| format!("failed to preroll preview pipeline: {error}"))?;
            if let Err(error) =
                wait_for_pipeline_async_completion(&pipeline, "preroll preview pipeline")
            {
                let _ = pipeline.set_state(gst::State::Null);
                return Err(error);
            }

            Ok(Self {
                pipeline,
                _timeline: timeline,
                video_sink,
                surface_window_handle,
                duration_ms: sanitize_duration_ms(prepared_timeline.duration_ms),
            })
        }

        pub fn bind_surface_handle(
            &mut self,
            surface_window_handle: Option<usize>,
        ) -> Result<(), String> {
            if self.surface_window_handle == surface_window_handle {
                return Ok(());
            }
            self.surface_window_handle = surface_window_handle;
            if let Some(video_sink) = self.video_sink.as_ref() {
                bind_video_overlay(video_sink, surface_window_handle)?;
            }
            Ok(())
        }

        pub fn play(&mut self, position_ms: f64, rate: f64) -> Result<(), String> {
            self.seek_internal(position_ms, rate)?;
            self.pipeline
                .set_state(gst::State::Playing)
                .map_err(|error| format!("failed to start preview pipeline: {error}"))?;
            wait_for_pipeline_async_completion(&self.pipeline, "start preview pipeline")?;
            Ok(())
        }

        pub fn pause(&mut self) -> Result<(), String> {
            self.pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| format!("failed to pause preview pipeline: {error}"))?;
            wait_for_pipeline_async_completion(&self.pipeline, "pause preview pipeline")?;
            Ok(())
        }

        pub fn seek_paused(&mut self, position_ms: f64) -> Result<(), String> {
            self.pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| format!("failed to prepare preview pipeline for seek: {error}"))?;
            wait_for_pipeline_async_completion(
                &self.pipeline,
                "prepare preview pipeline for seek",
            )?;
            self.seek_internal(position_ms, 1.0)
        }

        pub fn query_position_ms(&self) -> f64 {
            self.pipeline
                .query_position::<gst::ClockTime>()
                .map(clock_time_to_ms)
                .unwrap_or(0.0)
                .clamp(0.0, self.duration_ms)
        }

        pub fn poll(&mut self) -> Result<PreviewBackendPollResult, String> {
            let mut result = PreviewBackendPollResult::default();
            let bus = self
                .pipeline
                .bus()
                .ok_or_else(|| "preview pipeline bus is unavailable".to_string())?;

            for message in bus.iter_timed(Some(gst::ClockTime::ZERO)) {
                match message.view() {
                    gst::MessageView::Eos(..) => {
                        result.reached_eos = true;
                    }
                    gst::MessageView::Error(error) => {
                        let detail = error
                            .debug()
                            .map(|value| value.to_string())
                            .filter(|value| !value.trim().is_empty());
                        let mut message = error.error().to_string();
                        if let Some(detail) = detail {
                            message.push_str(": ");
                            message.push_str(detail.as_str());
                        }
                        result.last_error = Some(message);
                    }
                    _ => {}
                }
            }

            Ok(result)
        }

        pub fn shutdown(&mut self) -> Result<(), String> {
            self.pipeline
                .set_state(gst::State::Null)
                .map_err(|error| format!("failed to stop preview pipeline: {error}"))?;
            wait_for_pipeline_async_completion(&self.pipeline, "stop preview pipeline")?;
            Ok(())
        }

        pub fn duration_ms(&self) -> f64 {
            self.duration_ms
        }

        pub fn clamp_seek_position_ms(&self, position_ms: f64) -> f64 {
            clamp_seek_position_ms(position_ms, self.duration_ms)
        }

        fn seek_internal(&self, position_ms: f64, rate: f64) -> Result<(), String> {
            // Keep the segment stop explicit so repeated seeks never reuse a stale earlier stop.
            let (start_ms, stop_ms) = seek_segment_range_ms(position_ms, self.duration_ms);
            self.pipeline
                .seek(
                    rate,
                    gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                    gst::SeekType::Set,
                    clock_time_from_ms(start_ms),
                    gst::SeekType::Set,
                    clock_time_from_ms(stop_ms),
                )
                .map_err(|error| format!("failed to seek preview pipeline: {error}"))?;
            wait_for_pipeline_async_completion(&self.pipeline, "seek preview pipeline")?;
            Ok(())
        }
    }

    fn wait_for_pipeline_async_completion(
        pipeline: &ges::Pipeline,
        operation: &str,
    ) -> Result<(), String> {
        let bus = pipeline
            .bus()
            .ok_or_else(|| "preview pipeline bus is unavailable".to_string())?;
        let started_at = Instant::now();

        loop {
            let (result, current_state, pending_state) = pipeline.state(Some(gst::ClockTime::ZERO));
            result.map_err(|error| {
                format!(
                    "failed to query preview pipeline state while waiting to {operation}: {error}"
                )
            })?;

            if pending_state == gst::State::VoidPending {
                return Ok(());
            }

            let elapsed = started_at.elapsed();
            if elapsed >= ASYNC_OPERATION_TIMEOUT {
                return Err(format!(
                    "timed out waiting to {operation} (current={current_state:?}, pending={pending_state:?})"
                ));
            }

            let remaining = ASYNC_OPERATION_TIMEOUT
                .checked_sub(elapsed)
                .unwrap_or_default()
                .as_millis() as u64;
            let timeout_ms = remaining.min(100);
            let Some(message) = bus.timed_pop_filtered(
                gst::ClockTime::from_mseconds(timeout_ms),
                &[gst::MessageType::AsyncDone, gst::MessageType::Error],
            ) else {
                continue;
            };

            if let gst::MessageView::Error(error) = message.view() {
                let detail = error
                    .debug()
                    .map(|value| value.to_string())
                    .filter(|value| !value.trim().is_empty());
                let mut message = error.error().to_string();
                if let Some(detail) = detail {
                    message.push_str(": ");
                    message.push_str(detail.as_str());
                }
                return Err(format!(
                    "preview pipeline reported an error while waiting to {operation}: {message}"
                ));
            }
        }
    }

    fn build_ges_timeline(prepared_timeline: &GesPreviewTimeline) -> Result<ges::Timeline, String> {
        let timeline = ges::Timeline::new_audio_video();
        timeline.set_auto_transition(false);

        let mut layers = BTreeMap::<usize, ges::Layer>::new();
        let mut asset_cache = BTreeMap::<String, ges::UriClipAsset>::new();

        for clip in &prepared_timeline.clips {
            if clip.track_type == TimelineTrackType::Video && !clip.visible {
                continue;
            }

            let layer = layers
                .entry(clip.layer)
                .or_insert_with(|| timeline.append_layer())
                .clone();
            let asset = asset_cache
                .entry(clip.uri.clone())
                .or_insert_with(|| {
                    ges::UriClipAsset::request_sync(&clip.uri)
                        .expect("valid preview asset should have been discoverable")
                })
                .clone();

            let ges_clip = layer
                .add_asset(
                    &asset,
                    Some(clock_time_from_ms(clip.start_ms)),
                    Some(clock_time_from_ms(clip.inpoint_ms)),
                    Some(clock_time_from_ms(clip.duration_ms)),
                    track_type_for_clip(clip),
                )
                .map_err(|error| format!("failed to add preview clip {}: {error}", clip.id))?;

            ges_clip
                .set_name(Some(&clip.id))
                .map_err(|error| format!("failed to name preview clip {}: {error}", clip.id))?;

            apply_clip_modifiers(&ges_clip, clip)?;
        }

        if !timeline.commit_sync() {
            return Err("failed to commit GES preview timeline".to_string());
        }

        Ok(timeline)
    }

    fn apply_clip_modifiers(ges_clip: &ges::Clip, clip: &GesPreviewClipPlan) -> Result<(), String> {
        apply_ges_clip_modifiers(
            ges_clip,
            &GesClipModifierPlan {
                clip_id: clip.id.clone(),
                track_type: clip.track_type.clone(),
                volume: clip.volume,
                crop: clip.crop.clone(),
                transform: clip.transform.clone(),
            },
        )
    }

    fn track_type_for_clip(clip: &GesPreviewClipPlan) -> ges::TrackType {
        match clip.track_type {
            TimelineTrackType::Video => ges::TrackType::VIDEO,
            TimelineTrackType::Audio => ges::TrackType::AUDIO,
        }
    }

    fn preview_mode(prepared_timeline: &GesPreviewTimeline) -> ges::PipelineFlags {
        let mut flags = ges::PipelineFlags::empty();
        if prepared_timeline.has_audio {
            flags |= ges::PipelineFlags::AUDIO_PREVIEW;
        }
        if prepared_timeline.has_video {
            flags |= ges::PipelineFlags::VIDEO_PREVIEW;
        }
        if flags.is_empty() {
            ges::PipelineFlags::FULL_PREVIEW
        } else {
            flags
        }
    }

    fn create_video_sink() -> Result<gst::Element, String> {
        #[cfg(target_os = "windows")]
        {
            return gst::ElementFactory::make("d3d11videosink")
                .property("force-aspect-ratio", true)
                .property_from_str("fullscreen-toggle-mode", "none")
                .build()
                .map_err(|error| format!("failed to create d3d11videosink: {error}"));
        }

        #[cfg(target_os = "macos")]
        {
            return gst::ElementFactory::make("glimagesink")
                .property("force-aspect-ratio", true)
                .build()
                .map_err(|error| format!("failed to create glimagesink: {error}"));
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            gst::ElementFactory::make("autovideosink")
                .build()
                .map_err(|error| format!("failed to create autovideosink: {error}"))
        }
    }

    fn bind_video_overlay(
        video_sink: &gst::Element,
        surface_window_handle: Option<usize>,
    ) -> Result<(), String> {
        let Some(surface_window_handle) = surface_window_handle else {
            return Ok(());
        };

        let overlay = video_sink
            .dynamic_cast_ref::<gst_video::VideoOverlay>()
            .ok_or_else(|| {
                "configured preview video sink does not implement GstVideoOverlay".to_string()
            })?;
        overlay.handle_events(false);
        unsafe {
            overlay.set_window_handle(surface_window_handle as usize as _);
        }
        overlay.expose();
        Ok(())
    }

    fn clock_time_from_ms(value_ms: f64) -> gst::ClockTime {
        let clamped = if value_ms.is_finite() {
            value_ms.max(0.0)
        } else {
            0.0
        };
        gst::ClockTime::from_nseconds((clamped * 1_000_000.0).round() as u64)
    }

    fn clock_time_to_ms(value: gst::ClockTime) -> f64 {
        value.nseconds() as f64 / 1_000_000.0
    }
}

#[cfg(test)]
mod imp {
    use super::{
        clamp_seek_position_ms, sanitize_duration_ms, GesPreviewTimeline, PreviewBackendPollResult,
    };

    #[derive(Debug)]
    pub struct GstreamerPreviewPlayer {
        duration_ms: f64,
        position_ms: f64,
        rate: f64,
        playing: bool,
        surface_window_handle: Option<usize>,
    }

    impl GstreamerPreviewPlayer {
        pub fn new(
            prepared_timeline: &GesPreviewTimeline,
            surface_window_handle: Option<usize>,
        ) -> Result<Self, String> {
            Ok(Self {
                duration_ms: sanitize_duration_ms(prepared_timeline.duration_ms),
                position_ms: 0.0,
                rate: 1.0,
                playing: false,
                surface_window_handle,
            })
        }

        pub fn bind_surface_handle(
            &mut self,
            surface_window_handle: Option<usize>,
        ) -> Result<(), String> {
            self.surface_window_handle = surface_window_handle;
            Ok(())
        }

        pub fn play(&mut self, position_ms: f64, rate: f64) -> Result<(), String> {
            self.position_ms = clamp_seek_position_ms(position_ms, self.duration_ms);
            self.rate = rate;
            self.playing = true;
            Ok(())
        }

        pub fn pause(&mut self) -> Result<(), String> {
            self.playing = false;
            Ok(())
        }

        pub fn seek_paused(&mut self, position_ms: f64) -> Result<(), String> {
            self.position_ms = clamp_seek_position_ms(position_ms, self.duration_ms);
            self.playing = false;
            Ok(())
        }

        pub fn query_position_ms(&self) -> f64 {
            self.position_ms
        }

        pub fn poll(&mut self) -> Result<PreviewBackendPollResult, String> {
            let _ = (self.rate, self.playing, self.surface_window_handle);
            Ok(PreviewBackendPollResult::default())
        }

        pub fn shutdown(&mut self) -> Result<(), String> {
            self.playing = false;
            Ok(())
        }

        pub fn duration_ms(&self) -> f64 {
            self.duration_ms
        }

        pub fn clamp_seek_position_ms(&self, position_ms: f64) -> f64 {
            clamp_seek_position_ms(position_ms, self.duration_ms)
        }
    }
}

pub use imp::GstreamerPreviewPlayer;

#[cfg(test)]
mod tests {
    use super::{clamp_seek_position_ms, seek_segment_range_ms};

    #[test]
    fn clamp_seek_position_preserves_in_range_values() {
        assert_eq!(clamp_seek_position_ms(125.0, 1_000.0), 125.0);
    }

    #[test]
    fn clamp_seek_position_avoids_exact_end_boundary() {
        assert_eq!(clamp_seek_position_ms(1_000.0, 1_000.0), 999.999);
        assert_eq!(clamp_seek_position_ms(1_500.0, 1_000.0), 999.999);
    }

    #[test]
    fn clamp_seek_position_handles_zero_or_invalid_duration() {
        assert_eq!(clamp_seek_position_ms(50.0, 0.0), 0.0);
        assert_eq!(clamp_seek_position_ms(50.0, f64::NAN), 0.0);
    }

    #[test]
    fn seek_segment_range_always_keeps_stop_at_or_after_start() {
        assert_eq!(seek_segment_range_ms(125.0, 1_000.0), (125.0, 1_000.0));
        assert_eq!(seek_segment_range_ms(1_000.0, 1_000.0), (999.999, 1_000.0));
        assert_eq!(seek_segment_range_ms(1_500.0, 1_000.0), (999.999, 1_000.0));
    }

    #[test]
    fn seek_segment_range_handles_zero_or_invalid_duration() {
        assert_eq!(seek_segment_range_ms(50.0, 0.0), (0.0, 0.0));
        assert_eq!(seek_segment_range_ms(50.0, f64::NAN), (0.0, 0.0));
    }
}
