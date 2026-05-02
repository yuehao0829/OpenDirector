use super::error::{backend_not_ready, MediaResult};
use super::model::{
    AssetProcessRequest, AssetProcessResult, MediaConcatRequest, MediaConcatResult,
    MediaProbeRequest, TimelineRenderRequest, TimelineRenderResult,
};
use super::{ges, gstreamer, runtime};
use crate::commands::metadata::MediaMetadataResult;

pub fn process_asset(request: AssetProcessRequest) -> MediaResult<AssetProcessResult> {
    match detect_media_type(&request.input_path) {
        "image" => ges::render::process_asset(&request),
        _ => match runtime::require_gstreamer_runtime() {
            Ok(_) => ges::render::process_asset(&request),
            Err(reason) => Err(backend_not_ready("gstreamerGes", &reason)),
        },
    }
}

pub fn concat_media(request: MediaConcatRequest) -> MediaResult<MediaConcatResult> {
    match runtime::require_gstreamer_runtime() {
        Ok(_) => ges::render::concat_media(&request),
        Err(reason) => Err(backend_not_ready("gstreamerGes", &reason)),
    }
}

pub fn probe_media(request: MediaProbeRequest) -> MediaResult<MediaMetadataResult> {
    match runtime::require_gstreamer_preview_runtime() {
        Ok(_) => gstreamer::discoverer::probe_media(&request),
        Err(reason) => Err(backend_not_ready("gstreamerGes", &reason)),
    }
}

pub fn render_timeline(request: TimelineRenderRequest) -> MediaResult<TimelineRenderResult> {
    match runtime::require_gstreamer_runtime() {
        Ok(_) => ges::render::render_timeline(&request),
        Err(reason) => Err(backend_not_ready("gstreamerGes", &reason)),
    }
}

fn detect_media_type(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" | "wmv" => "video",
        "mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac" => "audio",
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff" | "tif" | "gif" => "image",
        _ => "video",
    }
}

#[cfg(test)]
mod tests {
    use std::f32::consts::PI;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::media::gstreamer::command::{file_uri, run_tool, GstreamerTool};
    use crate::media::gstreamer::thumbnail;

    fn temp_case_dir(case_name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_millis();
        let dir = std::env::temp_dir().join(format!("genline-{case_name}-{suffix}"));
        fs::create_dir_all(&dir).expect("failed to create temp case dir");
        dir
    }

    fn runtime_state() -> &'static runtime::GstreamerRuntimeState {
        runtime::require_gstreamer_runtime().expect("GStreamer runtime is required for smoke tests")
    }

    fn render_test_clip(output_path: &Path, pattern: &str, duration_secs: f64) {
        let runtime = runtime_state();
        let args = vec![
            format!("--outputuri={}", file_uri(output_path)),
            "--format=video/quicktime:video/x-h264:audio/mpeg,mpegversion=4".to_string(),
            "+test-clip".to_string(),
            pattern.to_string(),
            format!("duration={duration_secs:.6}"),
        ];

        let output =
            run_tool(&runtime.bootstrap, GstreamerTool::GesLaunch, &args).expect("launch failed");
        assert!(
            output.status.success(),
            "ges-launch failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output_path.exists(),
            "expected rendered clip at {}",
            output_path.display()
        );
    }

    fn write_test_wav(output_path: &Path, duration_secs: f32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer =
            hound::WavWriter::create(output_path, spec).expect("failed to create wav writer");
        let sample_count = (spec.sample_rate as f32 * duration_secs) as usize;

        for sample_index in 0..sample_count {
            let t = sample_index as f32 / spec.sample_rate as f32;
            let sample = (t * 440.0 * 2.0 * PI).sin();
            let value = (sample * i16::MAX as f32 * 0.3) as i16;
            writer.write_sample(value).expect("failed to write sample");
        }

        writer.finalize().expect("failed to finalize wav");
    }

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn probe_and_thumbnail_smoke() {
        let case_dir = temp_case_dir("probe-thumbnail");
        let input_path = case_dir.join("input.mp4");
        let thumb_path = case_dir.join("thumb.jpg");

        render_test_clip(&input_path, "smpte", 2.0);

        let metadata = probe_media(MediaProbeRequest {
            path: input_path.to_string_lossy().to_string(),
        })
        .expect("probe_media should succeed");

        assert!(
            metadata.duration_ms.unwrap_or_default() > 1500.0,
            "unexpected metadata: {:?}",
            metadata
        );
        assert!(metadata.width.unwrap_or_default() > 0);
        assert!(metadata.height.unwrap_or_default() > 0);

        thumbnail::render_video_thumbnail(
            &input_path.to_string_lossy(),
            &thumb_path.to_string_lossy(),
            0.5,
        )
        .expect("thumbnail render should succeed");

        let thumb_meta = fs::metadata(&thumb_path).expect("thumbnail should exist");
        assert!(thumb_meta.len() > 0, "thumbnail should not be empty");
    }

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn process_and_concat_smoke() {
        let case_dir = temp_case_dir("process-concat");
        let input_a = case_dir.join("input-a.mp4");
        let input_b = case_dir.join("input-b.mp4");
        let processed_dir = case_dir.join("processed");
        let concat_dir = case_dir.join("concat");

        render_test_clip(&input_a, "smpte", 2.0);
        render_test_clip(&input_b, "snow", 2.0);

        let processed = process_asset(AssetProcessRequest {
            backend: None,
            input_path: input_a.to_string_lossy().to_string(),
            output_dir: processed_dir.to_string_lossy().to_string(),
            crop_x: Some(0.1),
            crop_y: Some(0.1),
            crop_w: Some(0.8),
            crop_h: Some(0.8),
            trim_start_ms: Some(250.0),
            trim_end_ms: Some(1250.0),
            max_width: Some(160),
            max_height: Some(120),
            target_aspect_ratio: None,
            output_format: Some("mp4".to_string()),
        })
        .expect("process_asset should succeed");

        assert!(
            Path::new(&processed.output_path).exists(),
            "processed output should exist"
        );
        assert!(
            processed.file_size > 0,
            "processed output should not be empty"
        );

        let processed_meta = probe_media(MediaProbeRequest {
            path: processed.output_path.clone(),
        })
        .expect("processed output should be probe-able");
        assert!(
            processed_meta.duration_ms.unwrap_or_default() > 500.0,
            "unexpected processed metadata: {:?}",
            processed_meta
        );

        let concat = concat_media(MediaConcatRequest {
            backend: None,
            input_paths: vec![
                input_a.to_string_lossy().to_string(),
                input_b.to_string_lossy().to_string(),
            ],
            output_dir: concat_dir.to_string_lossy().to_string(),
            output_filename: "joined-smoke".to_string(),
        })
        .expect("concat_media should succeed");

        assert!(
            Path::new(&concat.output_path).exists(),
            "concat output should exist"
        );
        assert!(concat.file_size > 0, "concat output should not be empty");

        let concat_meta = probe_media(MediaProbeRequest {
            path: concat.output_path,
        })
        .expect("concat output should be probe-able");
        assert!(
            concat_meta.duration_ms.unwrap_or_default() > 3000.0,
            "unexpected concat metadata: {:?}",
            concat_meta
        );
    }

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn process_audio_smoke() {
        let case_dir = temp_case_dir("process-audio");
        let input_path = case_dir.join("input.wav");
        let processed_dir = case_dir.join("processed");
        write_test_wav(&input_path, 2.0);

        let processed = process_asset(AssetProcessRequest {
            backend: None,
            input_path: input_path.to_string_lossy().to_string(),
            output_dir: processed_dir.to_string_lossy().to_string(),
            crop_x: None,
            crop_y: None,
            crop_w: None,
            crop_h: None,
            trim_start_ms: Some(250.0),
            trim_end_ms: Some(1250.0),
            max_width: None,
            max_height: None,
            target_aspect_ratio: None,
            output_format: None,
        })
        .expect("audio process_asset should succeed");

        let reader =
            hound::WavReader::open(&processed.output_path).expect("processed audio should exist");
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 44_100);
        assert_eq!(reader.duration(), 44_100);
    }
}
