#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gst_video::VideoFrameExt;
use image::{imageops::FilterType, DynamicImage, ImageFormat, RgbImage};

use super::super::error::MediaResult;
use super::super::runtime;
use super::command::{canonicalize_media_path, file_uri};

const THUMBNAIL_MAX_SIZE: u32 = 512;
const ASYNC_OPERATION_TIMEOUT: Duration = Duration::from_millis(2_000);
const SAMPLE_PULL_TIMEOUT: Duration = Duration::from_millis(2_000);

pub fn render_video_thumbnail(
    input_path: &str,
    output_path: &str,
    time_sec: f64,
) -> MediaResult<()> {
    runtime::require_gstreamer_preview_runtime()?;
    runtime::prepare_gstreamer_process_environment()?;
    gst::init().map_err(|error| format!("failed to initialize GStreamer: {error}"))?;

    let input_path = canonicalize_media_path(input_path)?;
    let output_path = resolve_output_path(output_path)?;
    let pipeline = create_thumbnail_pipeline(&input_path)?;
    let thumbnail_result: MediaResult<()> = (|| {
        wait_for_pipeline_async_completion(&pipeline.playbin, "preroll thumbnail pipeline")?;
        seek_pipeline_to_capture_time(&pipeline, time_sec)?;

        let sample = pipeline
            .video_sink
            .try_pull_preroll(Some(duration_to_clock_time(SAMPLE_PULL_TIMEOUT)))
            .ok_or_else(|| "thumbnail pipeline did not produce a preroll sample".to_string())?;
        let image = image_from_sample(sample)?;
        image
            .resize(THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE, FilterType::Lanczos3)
            .save_with_format(&output_path, ImageFormat::Jpeg)
            .map_err(|error| format!("failed to save thumbnail image: {error}"))?;

        Ok(())
    })();

    let _ = pipeline.playbin.set_state(gst::State::Null);
    thumbnail_result?;

    if !output_path.exists() {
        return Err(format!(
            "thumbnail capture completed without creating {}",
            output_path.display()
        ));
    }

    Ok(())
}

pub fn generate_thumbnail(input_path: &str, output_path: &str) -> MediaResult<()> {
    render_video_thumbnail(input_path, output_path, 0.0)
}

#[derive(Debug)]
struct ThumbnailPipeline {
    playbin: gst::Pipeline,
    video_sink: gst_app::AppSink,
}

fn resolve_output_path(output_path: &str) -> MediaResult<PathBuf> {
    if Path::new(output_path).is_absolute() {
        Ok(Path::new(output_path).to_path_buf())
    } else {
        std::env::current_dir()
            .map_err(|err| format!("failed to resolve current directory: {}", err))
            .map(|current_dir| current_dir.join(output_path))
    }
}

fn create_thumbnail_pipeline(input_path: &Path) -> MediaResult<ThumbnailPipeline> {
    let playbin = gst::ElementFactory::make("playbin")
        .build()
        .map_err(|error| format!("failed to create thumbnail playbin: {error}"))?
        .dynamic_cast::<gst::Pipeline>()
        .map_err(|_| "thumbnail playbin does not implement gst::Pipeline".to_string())?;

    let video_caps = gst::Caps::builder("video/x-raw")
        .field("format", "RGB")
        .build();
    let video_sink = gst_app::AppSink::builder()
        .caps(&video_caps)
        .max_buffers(1)
        .leaky_type(gst_app::AppLeakyType::Downstream)
        .sync(false)
        .wait_on_eos(false)
        .build();
    let audio_sink = gst::ElementFactory::make("fakesink")
        .property("sync", false)
        .property("async", false)
        .build()
        .map_err(|error| format!("failed to create thumbnail audio sink: {error}"))?;

    playbin.set_property("uri", file_uri(input_path));
    playbin.set_property("video-sink", &video_sink);
    playbin.set_property("audio-sink", &audio_sink);
    playbin.set_property("mute", true);

    playbin
        .set_state(gst::State::Paused)
        .map_err(|error| format!("failed to preroll thumbnail pipeline: {error}"))?;

    Ok(ThumbnailPipeline {
        playbin,
        video_sink,
    })
}

fn seek_pipeline_to_capture_time(pipeline: &ThumbnailPipeline, time_sec: f64) -> MediaResult<()> {
    let duration_ms = pipeline
        .playbin
        .query_duration::<gst::ClockTime>()
        .map(clock_time_to_ms)
        .unwrap_or(0.0);
    let seek_ms = clamp_capture_time_ms(time_sec * 1_000.0, duration_ms);

    pipeline
        .playbin
        .seek_simple(
            gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE | gst::SeekFlags::KEY_UNIT,
            clock_time_from_ms(seek_ms),
        )
        .map_err(|error| format!("failed to seek thumbnail pipeline: {error}"))?;
    wait_for_pipeline_async_completion(&pipeline.playbin, "seek thumbnail pipeline")?;
    Ok(())
}

fn clamp_capture_time_ms(time_ms: f64, duration_ms: f64) -> f64 {
    let time_ms = if time_ms.is_finite() {
        time_ms.max(0.0)
    } else {
        0.0
    };
    let duration_ms = if duration_ms.is_finite() {
        duration_ms.max(0.0)
    } else {
        0.0
    };

    if duration_ms <= 0.0 {
        return time_ms;
    }

    let upper_bound = (duration_ms - 1.0).max(0.0);
    time_ms.min(upper_bound)
}

fn image_from_sample(sample: gst::Sample) -> MediaResult<DynamicImage> {
    let caps = sample
        .caps()
        .ok_or_else(|| "thumbnail sample has no caps".to_string())?;
    let info = gst_video::VideoInfo::from_caps(caps)
        .map_err(|error| format!("failed to read thumbnail caps: {error}"))?;
    let buffer = sample
        .buffer_owned()
        .ok_or_else(|| "thumbnail sample has no buffer".to_string())?;
    let frame = gst_video::VideoFrame::from_buffer_readable(buffer, &info)
        .map_err(|_| "failed to map thumbnail frame".to_string())?;

    let width = frame.width();
    let height = frame.height();
    let stride = frame.plane_stride()[0] as usize;
    let row_len = width as usize * 3;
    let plane = frame
        .plane_data(0)
        .map_err(|error| format!("failed to read thumbnail plane data: {error}"))?;

    if plane.len() < stride * height as usize {
        return Err("thumbnail plane data is smaller than expected".to_string());
    }

    let mut packed = Vec::with_capacity(row_len * height as usize);
    for row in 0..height as usize {
        let row_start = row * stride;
        let row_end = row_start + row_len;
        packed.extend_from_slice(&plane[row_start..row_end]);
    }

    let rgb_image = RgbImage::from_raw(width, height, packed)
        .ok_or_else(|| "failed to build RGB thumbnail image".to_string())?;
    Ok(DynamicImage::ImageRgb8(rgb_image))
}

fn wait_for_pipeline_async_completion(
    pipeline: &gst::Pipeline,
    operation: &str,
) -> MediaResult<()> {
    let bus = pipeline
        .bus()
        .ok_or_else(|| "thumbnail pipeline bus is unavailable".to_string())?;
    let started_at = Instant::now();

    loop {
        let (result, current_state, pending_state) = pipeline.state(Some(gst::ClockTime::ZERO));
        result.map_err(|error| {
            format!(
                "failed to query thumbnail pipeline state while waiting to {operation}: {error}"
            )
        })?;

        if pending_state == gst::State::VoidPending {
            return Ok(());
        }

        if started_at.elapsed() >= ASYNC_OPERATION_TIMEOUT {
            return Err(format!(
                "timed out waiting to {operation} (current={current_state:?}, pending={pending_state:?})"
            ));
        }

        let Some(message) = bus.timed_pop_filtered(
            duration_to_clock_time(Duration::from_millis(100)),
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
                "thumbnail pipeline reported an error while waiting to {operation}: {message}"
            ));
        }
    }
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

fn duration_to_clock_time(duration: Duration) -> gst::ClockTime {
    gst::ClockTime::from_nseconds(duration.as_nanos() as u64)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::render_video_thumbnail;
    use crate::media::runtime;

    fn temp_case_dir(case_name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_millis();
        let dir = std::env::temp_dir().join(format!("opendirector-thumbnail-{case_name}-{suffix}"));
        fs::create_dir_all(&dir).expect("failed to create temp case dir");
        dir
    }

    fn gst_launch_path() -> PathBuf {
        let runtime = runtime::require_gstreamer_preview_runtime()
            .expect("GStreamer preview runtime is required for thumbnail smoke tests");
        runtime
            .bootstrap
            .runtime_root
            .as_ref()
            .expect("runtime root should exist")
            .join("bin")
            .join("gst-launch-1.0")
    }

    fn render_test_clip(output_path: &Path) {
        let status = Command::new(gst_launch_path())
            .args([
                "-q",
                "-e",
                "videotestsrc",
                "num-buffers=45",
                "pattern=smpte",
                "!",
                "video/x-raw,framerate=30/1,width=320,height=180",
                "!",
                "x264enc",
                "!",
                "mp4mux",
                "!",
                "filesink",
                &format!("location={}", output_path.display()),
            ])
            .status()
            .expect("gst-launch-1.0 should start");
        assert!(status.success(), "gst-launch-1.0 should succeed");
        assert!(output_path.exists(), "test clip should exist");
    }

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn render_video_thumbnail_smoke() {
        let case_dir = temp_case_dir("smoke");
        let input_path = case_dir.join("input.mp4");
        let output_path = case_dir.join("thumb.jpg");

        render_test_clip(&input_path);
        render_video_thumbnail(
            &input_path.to_string_lossy(),
            &output_path.to_string_lossy(),
            0.5,
        )
        .expect("thumbnail render should succeed");

        let metadata = fs::metadata(&output_path).expect("thumbnail should exist");
        assert!(metadata.len() > 0, "thumbnail should not be empty");
    }
}
