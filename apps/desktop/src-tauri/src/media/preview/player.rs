use crate::media::ges::preview_timeline_builder::GesPreviewTimeline;

use super::transport::clamp_position;

#[derive(Debug, Default)]
pub struct PreviewBackendPollResult {
    // Seqnums of any EOS messages seen this poll. A post-seek EOS inherits the seek's seqnum, so
    // the session can tell a genuine end-of-stream from a stale EOS left on the bus by a seek.
    pub eos_seqnums: Vec<gst::Seqnum>,
    pub last_error: Option<String>,
    pub async_done_seqnums: Vec<gst::Seqnum>,
}

/// Latest-wins frame timestamp sample stamped with the seek generation that was
/// current when the buffer flowed. Samples whose generation is older than the
/// player's current generation predate the most recent flushing seek and are
/// discarded by the session.
#[derive(Debug, Clone, Copy)]
pub struct FrameSample {
    pub generation: u64,
    pub pts_ms: f64,
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

#[cfg(test)]
pub(crate) fn fail_next_bind_surface_and_preroll_for_tests(count: usize) {
    imp::fail_next_bind_surface_and_preroll_for_tests(count);
}

#[cfg(not(test))]
mod imp {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use ges::prelude::*;
    use gst_video::prelude::*;

    use crate::media::ges::clip_modifiers::{apply_ges_clip_modifiers, GesClipModifierPlan};
    use crate::media::ges::preview_timeline_builder::GesPreviewClipPlan;
    use crate::media::gstreamer::clock_time::{clock_time_from_ms, clock_time_to_ms};
    use crate::media::model::TimelineTrackType;
    use crate::media::runtime::prepare_gstreamer_process_environment;

    use super::{
        clamp_seek_position_ms, sanitize_duration_ms, seek_segment_range_ms, FrameSample,
        GesPreviewTimeline, PreviewBackendPollResult,
    };

    // Only the initial preroll during a pipeline build/swap and the final teardown block
    // on the pipeline settling. Transport ops never block; completion is observed by poll().
    const PIPELINE_BUILD_TIMEOUT: Duration = Duration::from_secs(5);

    #[derive(Debug)]
    pub struct GstreamerPreviewPlayer {
        pipeline: ges::Pipeline,
        _timeline: ges::Timeline,
        video_sink: Option<gst::Element>,
        surface_window_handle: Option<usize>,
        duration_ms: f64,
        frame_timestamp_probe: Option<(gst::Pad, gst::PadProbeId)>,
        frame_slot: Arc<Mutex<Option<FrameSample>>>,
        seek_generation: Arc<AtomicU64>,
    }

    // SAFETY:
    // Each preview session owns its player behind a dedicated `tokio::sync::Mutex`, so the
    // player is only ever accessed by one task at a time. GES/GStreamer bindings do not mark
    // these generated wrapper types as `Send`, but this application only transfers the player
    // as an opaque session-owned value between executor threads (including a build performed on
    // a blocking thread) and never touches it concurrently.
    unsafe impl Send for GstreamerPreviewPlayer {}

    impl GstreamerPreviewPlayer {
        pub fn new_pending(prepared_timeline: &GesPreviewTimeline) -> Result<Self, String> {
            prepare_gstreamer_process_environment()?;
            ges::init().map_err(|error| format!("failed to initialize GStreamer/GES: {error}"))?;

            let timeline = build_ges_timeline(prepared_timeline)?;
            let pipeline = ges::Pipeline::new();

            let video_sink = if prepared_timeline.has_video {
                let sink = create_video_sink()?;
                pipeline.preview_set_video_sink(Some(&sink));
                Some(sink)
            } else {
                None
            };

            // GESPipeline's preview sink setters assert they run on the thread that
            // constructed the pipeline, and GES installs a default audio sink through
            // that setter during the first state change — which happens later on a
            // different thread. Pre-set the audio sink here so GES never has to.
            if prepared_timeline.has_audio {
                let audio_sink = create_audio_sink()?;
                pipeline.preview_set_audio_sink(Some(&audio_sink));
            }

            pipeline.set_timeline(&timeline).map_err(|error| {
                format!("failed to attach preview timeline to pipeline: {error}")
            })?;
            pipeline
                .set_mode(preview_mode())
                .map_err(|error| format!("failed to set preview pipeline mode: {error}"))?;

            let mut player = Self {
                pipeline,
                _timeline: timeline,
                video_sink,
                surface_window_handle: None,
                duration_ms: sanitize_duration_ms(prepared_timeline.duration_ms),
                frame_timestamp_probe: None,
                frame_slot: Arc::new(Mutex::new(None)),
                seek_generation: Arc::new(AtomicU64::new(0)),
            };
            player.install_frame_timestamp_probe();
            Ok(player)
        }

        pub fn bind_surface_and_preroll(
            &mut self,
            surface_window_handle: Option<usize>,
        ) -> Result<(), String> {
            self.bind_surface_handle(surface_window_handle)?;
            self.pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| format!("failed to preroll preview pipeline: {error}"))?;
            wait_for_pipeline_settle(&self.pipeline, "preroll preview pipeline")
        }

        pub fn bind_surface_handle(
            &mut self,
            surface_window_handle: Option<usize>,
        ) -> Result<(), String> {
            if self.surface_window_handle == surface_window_handle {
                return Ok(());
            }
            if let Some(video_sink) = self.video_sink.as_ref() {
                bind_video_overlay(video_sink, surface_window_handle)?;
            }
            self.surface_window_handle = surface_window_handle;
            Ok(())
        }

        fn install_frame_timestamp_probe(&mut self) {
            let Some(video_sink) = self.video_sink.as_ref() else {
                return;
            };
            let Some(sink_pad) = video_sink.static_pad("sink") else {
                return;
            };
            let frame_slot = self.frame_slot.clone();
            let seek_generation = self.seek_generation.clone();
            let Some(probe_id) = sink_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
                if let Some(buffer) = info.buffer() {
                    if let Some(pts) = buffer.pts() {
                        let sample = FrameSample {
                            generation: seek_generation.load(Ordering::Acquire),
                            pts_ms: clock_time_to_ms(pts),
                        };
                        if let Ok(mut slot) = frame_slot.lock() {
                            *slot = Some(sample);
                        }
                    }
                }
                gst::PadProbeReturn::Ok
            }) else {
                return;
            };
            self.frame_timestamp_probe = Some((sink_pad, probe_id));
        }

        pub fn take_frame_sample(&self) -> Option<FrameSample> {
            self.frame_slot.lock().ok().and_then(|mut slot| slot.take())
        }

        pub fn clear_frame_sample(&self) {
            if let Ok(mut slot) = self.frame_slot.lock() {
                *slot = None;
            }
        }

        pub fn seek_generation(&self) -> u64 {
            self.seek_generation.load(Ordering::Acquire)
        }

        pub fn play(&mut self, position_ms: f64, rate: f64) -> Result<gst::Seqnum, String> {
            let seqnum = self.seek_internal(position_ms, rate)?;
            self.pipeline
                .set_state(gst::State::Playing)
                .map_err(|error| format!("failed to start preview pipeline: {error}"))?;
            Ok(seqnum)
        }

        pub fn pause(&mut self) -> Result<(), String> {
            self.pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| format!("failed to pause preview pipeline: {error}"))?;
            Ok(())
        }

        pub fn seek_paused(&mut self, position_ms: f64) -> Result<gst::Seqnum, String> {
            self.pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| format!("failed to prepare preview pipeline for seek: {error}"))?;
            self.seek_internal(position_ms, 1.0)
        }

        #[cfg(target_os = "macos")]
        pub fn expose_on_seek_complete(&self) {
            expose_video_sink(self.video_sink.as_ref());
        }

        #[cfg(not(target_os = "macos"))]
        pub fn expose_on_seek_complete(&self) {}

        pub fn query_position_ms(&self) -> Option<f64> {
            self.pipeline
                .query_position::<gst::ClockTime>()
                .map(|position| clock_time_to_ms(position).clamp(0.0, self.duration_ms))
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
                        result.eos_seqnums.push(message.seqnum());
                    }
                    gst::MessageView::AsyncDone(..) => {
                        result.async_done_seqnums.push(message.seqnum());
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
            if let Some((pad, probe_id)) = self.frame_timestamp_probe.take() {
                pad.remove_probe(probe_id);
            }
            self.pipeline
                .set_state(gst::State::Null)
                .map_err(|error| format!("failed to stop preview pipeline: {error}"))?;
            wait_for_pipeline_settle(&self.pipeline, "stop preview pipeline")?;
            self.surface_window_handle = None;
            Ok(())
        }

        pub fn duration_ms(&self) -> f64 {
            self.duration_ms
        }

        pub fn clamp_seek_position_ms(&self, position_ms: f64) -> f64 {
            clamp_seek_position_ms(position_ms, self.duration_ms)
        }

        fn seek_internal(&self, position_ms: f64, rate: f64) -> Result<gst::Seqnum, String> {
            // Bump the generation BEFORE dispatching so frames buffered under the old segment
            // are stamped stale and the session discards them once the flush lands.
            self.seek_generation.fetch_add(1, Ordering::AcqRel);
            // Keep the segment stop explicit so repeated seeks never reuse a stale earlier stop.
            let (start_ms, stop_ms) = seek_segment_range_ms(position_ms, self.duration_ms);
            let seek_event = gst::event::Seek::new(
                rate,
                gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                gst::SeekType::Set,
                clock_time_from_ms(start_ms),
                gst::SeekType::Set,
                clock_time_from_ms(stop_ms),
            );
            let seqnum = seek_event.seqnum();
            let accepted = self.pipeline.send_event(seek_event);
            if accepted {
                Ok(seqnum)
            } else {
                Err("failed to seek preview pipeline".to_string())
            }
        }
    }

    impl Drop for GstreamerPreviewPlayer {
        fn drop(&mut self) {
            // Best-effort teardown for any path that drops a player without calling shutdown()
            // (e.g. a rebuild discarded after its session was destroyed). Never block or panic here.
            if let Some((pad, probe_id)) = self.frame_timestamp_probe.take() {
                pad.remove_probe(probe_id);
            }
            let _ = self.pipeline.set_state(gst::State::Null);
        }
    }

    fn wait_for_pipeline_settle(pipeline: &ges::Pipeline, operation: &str) -> Result<(), String> {
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
            if elapsed >= PIPELINE_BUILD_TIMEOUT {
                return Err(format!(
                    "timed out waiting to {operation} (current={current_state:?}, pending={pending_state:?})"
                ));
            }

            let remaining = PIPELINE_BUILD_TIMEOUT
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
            let asset = match asset_cache.get(&clip.uri) {
                Some(asset) => asset.clone(),
                None => {
                    let asset = ges::UriClipAsset::request_sync(&clip.uri).map_err(|error| {
                        format!("failed to discover preview asset {}: {error}", clip.uri)
                    })?;
                    asset_cache.insert(clip.uri.clone(), asset.clone());
                    asset
                }
            };

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

    fn preview_mode() -> ges::PipelineFlags {
        ges::PipelineFlags::FULL_PREVIEW
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

    fn create_audio_sink() -> Result<gst::Element, String> {
        gst::ElementFactory::make("autoaudiosink")
            .build()
            .map_err(|error| format!("failed to create autoaudiosink: {error}"))
    }

    #[cfg(target_os = "macos")]
    fn expose_video_sink(video_sink: Option<&gst::Element>) {
        if let Some(sink) = video_sink {
            if let Some(overlay) = sink.dynamic_cast_ref::<gst_video::VideoOverlay>() {
                overlay.expose();
            }
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

}

#[cfg(test)]
mod imp {
    use std::cell::Cell;

    use super::{
        clamp_seek_position_ms, sanitize_duration_ms, FrameSample, GesPreviewTimeline,
        PreviewBackendPollResult,
    };

    thread_local! {
        static FAIL_NEXT_BIND_SURFACE_AND_PREROLL_COUNT: Cell<usize> = Cell::new(0);
    }

    pub(super) fn fail_next_bind_surface_and_preroll_for_tests(count: usize) {
        FAIL_NEXT_BIND_SURFACE_AND_PREROLL_COUNT.with(|remaining| remaining.set(count));
    }

    fn should_fail_bind_surface_and_preroll() -> bool {
        FAIL_NEXT_BIND_SURFACE_AND_PREROLL_COUNT.with(|remaining| {
            let count = remaining.get();
            if count == 0 {
                return false;
            }
            remaining.set(count - 1);
            true
        })
    }

    #[derive(Debug)]
    pub struct GstreamerPreviewPlayer {
        duration_ms: f64,
        position_ms: f64,
        rate: f64,
        playing: bool,
        surface_window_handle: Option<usize>,
        seek_generation: u64,
        frame_slot: Cell<Option<FrameSample>>,
        pending_async_done: Option<gst::Seqnum>,
    }

    impl GstreamerPreviewPlayer {
        pub fn new_pending(prepared_timeline: &GesPreviewTimeline) -> Result<Self, String> {
            Ok(Self {
                duration_ms: sanitize_duration_ms(prepared_timeline.duration_ms),
                position_ms: 0.0,
                rate: 1.0,
                playing: false,
                surface_window_handle: None,
                seek_generation: 0,
                frame_slot: Cell::new(None),
                pending_async_done: None,
            })
        }

        pub fn bind_surface_and_preroll(
            &mut self,
            surface_window_handle: Option<usize>,
        ) -> Result<(), String> {
            if should_fail_bind_surface_and_preroll() {
                return Err("injected preview preroll failure".to_string());
            }
            self.bind_surface_handle(surface_window_handle)
        }

        pub fn bind_surface_handle(
            &mut self,
            surface_window_handle: Option<usize>,
        ) -> Result<(), String> {
            self.surface_window_handle = surface_window_handle;
            Ok(())
        }

        pub fn take_frame_sample(&self) -> Option<FrameSample> {
            self.frame_slot.take()
        }

        pub fn clear_frame_sample(&self) {
            self.frame_slot.set(None);
        }

        pub fn seek_generation(&self) -> u64 {
            self.seek_generation
        }

        pub fn play(&mut self, position_ms: f64, rate: f64) -> Result<gst::Seqnum, String> {
            self.position_ms = clamp_seek_position_ms(position_ms, self.duration_ms);
            self.rate = rate;
            self.playing = true;
            Ok(self.dispatch_seek())
        }

        pub fn pause(&mut self) -> Result<(), String> {
            self.playing = false;
            Ok(())
        }

        pub fn seek_paused(&mut self, position_ms: f64) -> Result<gst::Seqnum, String> {
            self.position_ms = clamp_seek_position_ms(position_ms, self.duration_ms);
            self.playing = false;
            Ok(self.dispatch_seek())
        }

        pub fn expose_on_seek_complete(&self) {}

        pub fn query_position_ms(&self) -> Option<f64> {
            Some(self.position_ms)
        }

        pub fn poll(&mut self) -> Result<PreviewBackendPollResult, String> {
            let _ = (self.rate, self.playing, self.surface_window_handle);
            Ok(PreviewBackendPollResult {
                async_done_seqnums: self.pending_async_done.take().into_iter().collect(),
                ..PreviewBackendPollResult::default()
            })
        }

        pub fn set_frame_sample_for_tests(&mut self, sample: FrameSample) {
            self.frame_slot.set(Some(sample));
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

        // Model a flushing seek: bump the generation and stage the seqnum that the next poll()
        // will surface as the matching ASYNC_DONE, mirroring the real backend's completion path.
        fn dispatch_seek(&mut self) -> gst::Seqnum {
            self.seek_generation += 1;
            let seqnum = gst::Seqnum::next();
            self.pending_async_done = Some(seqnum);
            seqnum
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
