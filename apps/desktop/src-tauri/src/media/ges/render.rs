use std::path::{Path, PathBuf};

use image::{imageops::FilterType, GenericImageView, Rgba, RgbaImage};

use super::super::error::MediaResult;
use super::super::model::{
    AssetProcessRequest, AssetProcessResult, MediaConcatRequest, MediaConcatResult,
    TimelineRenderClip, TimelineRenderRequest, TimelineRenderResult, TimelineRenderTrack,
    TimelineTrackType,
};
use super::super::runtime;
use super::args::{fps_fraction, sanitize_clip_token};
use super::clip_modifiers::build_cli_modifier_args;
use super::{builder, effects};
use crate::media::gstreamer::command::{
    canonicalize_media_path, file_uri, run_tool, GstreamerTool,
};

pub fn process_asset(request: &AssetProcessRequest) -> MediaResult<AssetProcessResult> {
    let plan = builder::build_asset_render_plan(request);
    let crop = effects::extract_crop_effect(request);
    let media_type = detect_media_type(&plan.input_path);

    std::fs::create_dir_all(&plan.output_dir)
        .map_err(|err| format!("failed to create output directory: {}", err))?;

    let output_path = allocate_output_path(
        &plan.output_dir,
        output_extension(media_type, request.output_format.as_deref()),
    )?;

    match media_type {
        "image" => process_image_asset(request, crop, &output_path)?,
        "audio" | "video" => process_timed_asset(request, &output_path)?,
        _ => return Err(format!("unsupported media type for {}", plan.input_path)),
    }

    let file_size = std::fs::metadata(&output_path)
        .map_err(|err| format!("failed to stat rendered output: {}", err))?
        .len();

    Ok(AssetProcessResult {
        output_path: output_path.to_string_lossy().to_string(),
        file_size,
        backend_used: request.preferred_backend(),
    })
}

pub fn concat_media(request: &MediaConcatRequest) -> MediaResult<MediaConcatResult> {
    let plan = builder::build_concat_plan(request);
    let runtime = runtime::require_gstreamer_runtime()?;

    if plan.input_paths.len() < 2 {
        return Err("at least 2 input paths are required for concat".to_string());
    }

    std::fs::create_dir_all(&plan.output_dir)
        .map_err(|err| format!("failed to create output directory: {}", err))?;

    let output_path = Path::new(&plan.output_dir)
        .join(format!("{}.mp4", sanitize_filename(&plan.output_filename)));

    let mut args = vec![
        format!("--outputuri={}", file_uri(&output_path)),
        "--format=video/quicktime:video/x-h264:audio/mpeg,mpegversion=4".to_string(),
    ];

    for input in &plan.input_paths {
        let input_path = canonicalize_media_path(input)?;
        args.push("+clip".to_string());
        args.push(file_uri(&input_path));
    }

    let output = run_tool(&runtime.bootstrap, GstreamerTool::GesLaunch, &args)?;
    if !output.status.success() {
        return Err(format!(
            "ges-launch-1.0 concat failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let file_size = std::fs::metadata(&output_path)
        .map_err(|err| format!("failed to stat concat output: {}", err))?
        .len();

    Ok(MediaConcatResult {
        output_path: output_path.to_string_lossy().to_string(),
        file_size,
        backend_used: request.preferred_backend(),
    })
}

pub fn render_timeline(request: &TimelineRenderRequest) -> MediaResult<TimelineRenderResult> {
    validate_timeline_request(request)?;

    let runtime = runtime::require_gstreamer_runtime()?;
    let output_path = PathBuf::from(&request.output_path);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create render output directory: {}", err))?;
    }

    let args = build_timeline_render_args(request)?;
    let output = run_tool(&runtime.bootstrap, GstreamerTool::GesLaunch, &args)?;
    if !output.status.success() {
        return Err(format!(
            "ges-launch-1.0 timeline render failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let file_size = std::fs::metadata(&output_path)
        .map_err(|err| format!("failed to stat rendered timeline output: {}", err))?
        .len();

    Ok(TimelineRenderResult {
        output_path: output_path.to_string_lossy().to_string(),
        file_size,
        backend_used: request.preferred_backend(),
    })
}

fn validate_timeline_request(request: &TimelineRenderRequest) -> MediaResult<()> {
    if request.width == 0 || request.height == 0 {
        return Err("timeline render requires a positive output resolution".to_string());
    }

    if !request.fps.is_finite() || request.fps <= 0.0 {
        return Err("timeline render requires a positive fps value".to_string());
    }

    if request.tracks.is_empty() {
        return Err("timeline render requires at least one track".to_string());
    }

    let track_ids: std::collections::HashSet<&str> = request
        .tracks
        .iter()
        .map(|track| track.id.as_str())
        .collect();
    for clip in &request.clips {
        if clip.duration_ms <= 0.0 {
            return Err(format!(
                "timeline render clip {} has a non-positive duration",
                clip.id
            ));
        }

        if !track_ids.contains(clip.track_id.as_str()) {
            return Err(format!(
                "timeline render clip {} references unknown track {}",
                clip.id, clip.track_id
            ));
        }
    }

    Ok(())
}

fn build_timeline_render_args(request: &TimelineRenderRequest) -> MediaResult<Vec<String>> {
    let output_path = PathBuf::from(&request.output_path);
    let has_video = request
        .tracks
        .iter()
        .any(|track| track.track_type == TimelineTrackType::Video);
    let has_audio = request
        .tracks
        .iter()
        .any(|track| track.track_type == TimelineTrackType::Audio);

    let mut args = vec![
        format!("--outputuri={}", file_uri(&output_path)),
        format!(
            "--format={}",
            timeline_output_format_caps(request.output_format.as_deref(), has_video)
        ),
    ];

    if has_video {
        args.extend([
            "+track".to_string(),
            "video".to_string(),
            format!(
                "restrictions=video/x-raw,width={},height={},framerate={},pixel-aspect-ratio=1/1",
                request.width,
                request.height,
                fps_fraction(request.fps)
            ),
        ]);
    }

    if has_audio {
        args.extend([
            "+track".to_string(),
            "audio".to_string(),
            "restrictions=audio/x-raw,channels=2,rate=44100,layout=interleaved".to_string(),
        ]);
    }

    let layer_by_track_id = build_timeline_layer_map(&request.tracks);
    let track_by_id: std::collections::HashMap<&str, &TimelineRenderTrack> = request
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track))
        .collect();

    let mut clips = request.clips.clone();
    clips.sort_by(|left, right| {
        let left_layer = layer_by_track_id
            .get(left.track_id.as_str())
            .copied()
            .unwrap_or(0);
        let right_layer = layer_by_track_id
            .get(right.track_id.as_str())
            .copied()
            .unwrap_or(0);

        left_layer
            .cmp(&right_layer)
            .then_with(|| left.start_ms.total_cmp(&right.start_ms))
            .then_with(|| left.id.cmp(&right.id))
    });

    for clip in clips {
        let track = track_by_id.get(clip.track_id.as_str()).ok_or_else(|| {
            format!(
                "timeline render clip {} references unknown track {}",
                clip.id, clip.track_id
            )
        })?;
        let layer = layer_by_track_id
            .get(clip.track_id.as_str())
            .copied()
            .unwrap_or(0);

        args.extend(build_timeline_clip_args(track, &clip, layer)?);
    }

    Ok(args)
}

fn build_timeline_layer_map(
    tracks: &[TimelineRenderTrack],
) -> std::collections::HashMap<&str, usize> {
    let mut map = std::collections::HashMap::new();

    let mut video_tracks: Vec<&TimelineRenderTrack> = tracks
        .iter()
        .filter(|track| track.track_type == TimelineTrackType::Video)
        .collect();
    video_tracks.sort_by(|left, right| {
        right
            .order
            .cmp(&left.order)
            .then_with(|| left.id.cmp(&right.id))
    });

    for (index, track) in video_tracks.into_iter().enumerate() {
        map.insert(track.id.as_str(), index);
    }

    let mut audio_tracks: Vec<&TimelineRenderTrack> = tracks
        .iter()
        .filter(|track| track.track_type == TimelineTrackType::Audio)
        .collect();
    audio_tracks.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then_with(|| left.id.cmp(&right.id))
    });

    for (index, track) in audio_tracks.into_iter().enumerate() {
        map.insert(track.id.as_str(), index);
    }

    map
}

fn build_timeline_clip_args(
    track: &TimelineRenderTrack,
    clip: &TimelineRenderClip,
    layer: usize,
) -> MediaResult<Vec<String>> {
    let input_path = canonicalize_media_path(&clip.input_path)?;
    let mut args = vec![
        "+clip".to_string(),
        file_uri(&input_path),
        format!("name={}", sanitize_clip_token(&clip.id)),
        format!("layer={layer}"),
        format!("start={:.6}", clip.start_ms.max(0.0) / 1000.0),
        format!("duration={:.6}", clip.duration_ms / 1000.0),
        format!(
            "track-types={}",
            match track.track_type {
                TimelineTrackType::Video => "video",
                TimelineTrackType::Audio => "audio",
            }
        ),
    ];

    if let Some(trim_start_ms) = clip.trim_start_ms.filter(|value| *value > 0.0) {
        args.push(format!("inpoint={:.6}", trim_start_ms / 1000.0));
    }

    let volume = if track.track_type == TimelineTrackType::Audio
        && (track.muted || clip.mute.unwrap_or(false))
    {
        0.0
    } else {
        1.0
    };
    let modifier_plan = super::clip_modifiers::resolve_clip_modifier_plan(
        clip.id.clone(),
        track.track_type.clone(),
        &clip.input_path,
        volume,
        clip.crop.as_ref(),
        clip.transform.as_ref(),
    )?;
    args.extend(build_cli_modifier_args(&modifier_plan));

    Ok(args)
}

fn process_image_asset(
    request: &AssetProcessRequest,
    crop: Option<effects::CropEffectDescriptor>,
    output_path: &Path,
) -> MediaResult<()> {
    let mut image = image::open(&request.input_path)
        .map_err(|err| format!("failed to open image {}: {}", request.input_path, err))?;

    if let Some(crop) = crop {
        let (width, height) = image.dimensions();
        let x = ((crop.x * width as f64).round() as u32).min(width.saturating_sub(1));
        let y = ((crop.y * height as f64).round() as u32).min(height.saturating_sub(1));
        let crop_width = ((crop.width * width as f64).round() as u32).clamp(1, width - x);
        let crop_height = ((crop.height * height as f64).round() as u32).clamp(1, height - y);
        image = image.crop_imm(x, y, crop_width, crop_height);
    }

    if let (Some(max_width), Some(max_height)) = (request.max_width, request.max_height) {
        image = image.resize(max_width, max_height, FilterType::Lanczos3);
    }

    if let Some(aspect_ratio) = request.target_aspect_ratio.as_deref() {
        if aspect_ratio != "adaptive" {
            image = pad_to_aspect_ratio(image, aspect_ratio)?;
        }
    }

    image
        .save(output_path)
        .map_err(|err| format!("failed to save processed image: {}", err))?;

    Ok(())
}

fn process_timed_asset(request: &AssetProcessRequest, output_path: &Path) -> MediaResult<()> {
    let runtime = runtime::require_gstreamer_runtime()?;
    let input_path = canonicalize_media_path(&request.input_path)?;
    let media_type = detect_media_type(&request.input_path);
    let metadata = crate::media::gstreamer::discoverer::probe_media(
        &super::super::model::MediaProbeRequest {
            path: request.input_path.clone(),
        },
    )?;

    let mut args = vec![
        format!("--outputuri={}", file_uri(output_path)),
        format!(
            "--format={}",
            output_format_caps(media_type, request.output_format.as_deref())
        ),
        "+clip".to_string(),
        file_uri(&input_path),
    ];

    if let Some(start_seconds) = trim_start_seconds(request) {
        args.push(format!("inpoint={start_seconds}"));
    }

    if let Some(duration_seconds) = trim_duration_seconds(request) {
        args.push(format!("duration={duration_seconds}"));
    }

    if let Some(crop) = effects::extract_crop_effect(request) {
        if let (Some(width), Some(height)) = (metadata.width, metadata.height) {
            let left = ((crop.x * width as f64).round() as u32).min(width.saturating_sub(1));
            let top = ((crop.y * height as f64).round() as u32).min(height.saturating_sub(1));
            let crop_width = ((crop.width * width as f64).round() as u32).clamp(1, width - left);
            let crop_height = ((crop.height * height as f64).round() as u32).clamp(1, height - top);
            let right = width.saturating_sub(left + crop_width);
            let bottom = height.saturating_sub(top + crop_height);

            args.extend([
                "+effect".to_string(),
                "videocrop".to_string(),
                "set-left".to_string(),
                left.to_string(),
                "set-right".to_string(),
                right.to_string(),
                "set-top".to_string(),
                top.to_string(),
                "set-bottom".to_string(),
                bottom.to_string(),
            ]);
        }
    }

    if let (Some(max_width), Some(max_height)) = (request.max_width, request.max_height) {
        args.extend([
            "+effect".to_string(),
            format!(
                "videoscale ! capsfilter caps=video/x-raw,width={max_width},height={max_height},pixel-aspect-ratio=1/1"
            ),
        ]);
    }

    let output = run_tool(&runtime.bootstrap, GstreamerTool::GesLaunch, &args)?;
    if !output.status.success() {
        return Err(format!(
            "ges-launch-1.0 render failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(())
}

fn pad_to_aspect_ratio(
    image: image::DynamicImage,
    aspect_ratio: &str,
) -> Result<image::DynamicImage, String> {
    let Some((ratio_w, ratio_h)) = parse_aspect_ratio(aspect_ratio) else {
        return Ok(image);
    };

    let (width, height) = image.dimensions();
    let current = width as f64 / height.max(1) as f64;
    let target = ratio_w / ratio_h;

    if (current - target).abs() < 0.001 {
        return Ok(image);
    }

    let (canvas_width, canvas_height) = if current > target {
        (width, ((width as f64 / target).round() as u32).max(height))
    } else {
        (
            (((height as f64) * target).round() as u32).max(width),
            height,
        )
    };

    let mut canvas = RgbaImage::from_pixel(canvas_width, canvas_height, Rgba([0, 0, 0, 255]));
    let rgba = image.to_rgba8();
    let x = ((canvas_width - width) / 2) as i64;
    let y = ((canvas_height - height) / 2) as i64;
    image::imageops::overlay(&mut canvas, &rgba, x, y);

    Ok(image::DynamicImage::ImageRgba8(canvas))
}

fn parse_aspect_ratio(value: &str) -> Option<(f64, f64)> {
    let (width, height) = value.split_once(':')?;
    let width = width.trim().parse::<f64>().ok()?;
    let height = height.trim().parse::<f64>().ok()?;
    if width > 0.0 && height > 0.0 {
        Some((width, height))
    } else {
        None
    }
}

fn trim_start_seconds(request: &AssetProcessRequest) -> Option<String> {
    request
        .trim_start_ms
        .map(|value| format!("{:.6}", value.max(0.0) / 1000.0))
}

fn trim_duration_seconds(request: &AssetProcessRequest) -> Option<String> {
    let end = request.trim_end_ms?;
    let start = request.trim_start_ms.unwrap_or(0.0);
    let duration_ms = end - start;
    if duration_ms > 0.0 {
        Some(format!("{:.6}", duration_ms / 1000.0))
    } else {
        None
    }
}

fn allocate_output_path(output_dir: &str, extension: &str) -> Result<PathBuf, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| format!("failed to get system time: {}", err))?
        .as_millis();
    Ok(Path::new(output_dir).join(format!("processed_{timestamp}.{extension}")))
}

fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "concat".to_string()
    } else {
        trimmed
            .chars()
            .map(|ch| match ch {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => ch,
            })
            .collect()
    }
}

fn detect_media_type(path: &str) -> &'static str {
    let ext = Path::new(path)
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

fn output_extension(media_type: &str, output_format: Option<&str>) -> &'static str {
    if let Some(format) = output_format {
        return match format {
            "jpeg" | "jpg" => "jpg",
            "wav" => "wav",
            "mp3" => "mp3",
            "mp4" => "mp4",
            _ => "mp4",
        };
    }

    match media_type {
        "image" => "jpg",
        "audio" => "wav",
        _ => "mp4",
    }
}

fn output_format_caps(media_type: &str, output_format: Option<&str>) -> &'static str {
    match (media_type, output_format.unwrap_or("")) {
        ("audio", "mp3") => "audio/mpeg,mpegversion=1,layer=3",
        ("audio", _) => "audio/x-wav",
        (_, _) => "video/quicktime:video/x-h264:audio/mpeg,mpegversion=4",
    }
}

fn timeline_output_format_caps(output_format: Option<&str>, has_video: bool) -> &'static str {
    if !has_video {
        return match output_format.unwrap_or("") {
            "mp3" => "audio/mpeg,mpegversion=1,layer=3",
            _ => "audio/x-wav",
        };
    }

    match output_format.unwrap_or("") {
        "mov" => "video/quicktime:video/x-h264:audio/mpeg,mpegversion=4",
        _ => "video/quicktime:video/x-h264:audio/mpeg,mpegversion=4",
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
    use crate::media::model::{MediaProbeRequest, PreviewTransform, TimelineRenderCrop};

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
    fn build_timeline_render_args_emits_tracks_and_clip_properties() {
        let request = TimelineRenderRequest {
            backend: None,
            output_path: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/timeline-render.mp4")
                .to_string_lossy()
                .to_string(),
            output_format: Some("mp4".to_string()),
            width: 1920,
            height: 1080,
            fps: 30.0,
            tracks: vec![
                TimelineRenderTrack {
                    id: "video-top".to_string(),
                    track_type: TimelineTrackType::Video,
                    muted: false,
                    order: 2,
                },
                TimelineRenderTrack {
                    id: "audio-main".to_string(),
                    track_type: TimelineTrackType::Audio,
                    muted: true,
                    order: 0,
                },
            ],
            clips: vec![
                TimelineRenderClip {
                    id: "clip-a".to_string(),
                    track_id: "video-top".to_string(),
                    input_path: env!("CARGO_MANIFEST_DIR").to_string(),
                    start_ms: 1000.0,
                    duration_ms: 750.0,
                    trim_start_ms: Some(250.0),
                    mute: None,
                    crop: None,
                    transform: Some(PreviewTransform {
                        x: Some(32.0),
                        y: Some(-12.0),
                        scale_x: None,
                        scale_y: None,
                        rotation_deg: Some(180.0),
                        opacity: Some(0.85),
                    }),
                },
                TimelineRenderClip {
                    id: "clip-b".to_string(),
                    track_id: "audio-main".to_string(),
                    input_path: env!("CARGO_MANIFEST_DIR").to_string(),
                    start_ms: 0.0,
                    duration_ms: 500.0,
                    trim_start_ms: None,
                    mute: None,
                    crop: None,
                    transform: None,
                },
            ],
        };

        let args = build_timeline_render_args(&request).expect("args should build");

        assert!(args.iter().any(|arg| arg.contains("--outputuri=")));
        assert!(args
            .iter()
            .any(|arg| arg == "--format=video/quicktime:video/x-h264:audio/mpeg,mpegversion=4"));
        assert!(args.iter().any(|arg| arg == "video"));
        assert!(args.iter().any(|arg| arg == "audio"));
        assert!(args.iter().any(|arg| arg == "track-types=video"));
        assert!(args.iter().any(|arg| arg == "track-types=audio"));
        assert!(args.iter().any(|arg| arg == "layer=0"));
        assert!(args.iter().any(|arg| arg == "start=1.000000"));
        assert!(args.iter().any(|arg| arg == "duration=0.750000"));
        assert!(args.iter().any(|arg| arg == "inpoint=0.250000"));
        assert!(args.iter().any(|arg| arg == "set-alpha"));
        assert!(args.iter().any(|arg| arg == "0.850000"));
        assert!(args.iter().any(|arg| arg == "set-posx"));
        assert!(args.iter().any(|arg| arg == "32"));
        assert!(args.iter().any(|arg| arg == "set-video-direction"));
        assert!(args.iter().any(|arg| arg == "180"));
        assert!(args.iter().any(|arg| arg == "set-volume"));
    }

    #[test]
    fn validate_timeline_request_rejects_invalid_payload() {
        let invalid = TimelineRenderRequest {
            backend: None,
            output_path: "C:/exports/out.mp4".to_string(),
            output_format: Some("mp4".to_string()),
            width: 1920,
            height: 1080,
            fps: 25.0,
            tracks: vec![TimelineRenderTrack {
                id: "video-top".to_string(),
                track_type: TimelineTrackType::Video,
                muted: false,
                order: 0,
            }],
            clips: vec![TimelineRenderClip {
                id: "clip-a".to_string(),
                track_id: "missing-track".to_string(),
                input_path: "C:/media/clip.mp4".to_string(),
                start_ms: 0.0,
                duration_ms: 1000.0,
                trim_start_ms: None,
                mute: None,
                crop: None,
                transform: None,
            }],
        };

        let error = validate_timeline_request(&invalid).expect_err("request should be invalid");
        assert!(error.contains("references unknown track"));
    }

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn render_timeline_smoke() {
        let case_dir = temp_case_dir("timeline-render");
        let bottom_video_path = case_dir.join("bottom.mp4");
        let top_video_path = case_dir.join("top.mp4");
        let audio_path = case_dir.join("tone.wav");
        let output_path = case_dir.join("timeline.mp4");

        render_test_clip(&bottom_video_path, "smpte", 2.0);
        render_test_clip(&top_video_path, "snow", 1.5);
        write_test_wav(&audio_path, 2.0);

        let result = render_timeline(&TimelineRenderRequest {
            backend: None,
            output_path: output_path.to_string_lossy().to_string(),
            output_format: Some("mp4".to_string()),
            width: 640,
            height: 360,
            fps: 25.0,
            tracks: vec![
                TimelineRenderTrack {
                    id: "video-bottom".to_string(),
                    track_type: TimelineTrackType::Video,
                    muted: false,
                    order: 0,
                },
                TimelineRenderTrack {
                    id: "video-top".to_string(),
                    track_type: TimelineTrackType::Video,
                    muted: false,
                    order: 1,
                },
                TimelineRenderTrack {
                    id: "audio-main".to_string(),
                    track_type: TimelineTrackType::Audio,
                    muted: false,
                    order: 0,
                },
            ],
            clips: vec![
                TimelineRenderClip {
                    id: "bottom-clip".to_string(),
                    track_id: "video-bottom".to_string(),
                    input_path: bottom_video_path.to_string_lossy().to_string(),
                    start_ms: 0.0,
                    duration_ms: 2000.0,
                    trim_start_ms: None,
                    mute: None,
                    crop: None,
                    transform: None,
                },
                TimelineRenderClip {
                    id: "top-clip".to_string(),
                    track_id: "video-top".to_string(),
                    input_path: top_video_path.to_string_lossy().to_string(),
                    start_ms: 500.0,
                    duration_ms: 1000.0,
                    trim_start_ms: Some(250.0),
                    mute: None,
                    crop: Some(TimelineRenderCrop {
                        x: 0.1,
                        y: 0.1,
                        width: 0.8,
                        height: 0.8,
                    }),
                    transform: Some(PreviewTransform {
                        x: Some(12.0),
                        y: Some(8.0),
                        scale_x: Some(0.8),
                        scale_y: Some(0.8),
                        rotation_deg: None,
                        opacity: Some(0.9),
                    }),
                },
                TimelineRenderClip {
                    id: "audio-clip".to_string(),
                    track_id: "audio-main".to_string(),
                    input_path: audio_path.to_string_lossy().to_string(),
                    start_ms: 0.0,
                    duration_ms: 1800.0,
                    trim_start_ms: None,
                    mute: None,
                    crop: None,
                    transform: None,
                },
            ],
        })
        .expect("timeline render should succeed");

        assert_eq!(result.output_path, output_path.to_string_lossy());
        assert!(output_path.exists(), "timeline output should exist");
        assert!(result.file_size > 0, "timeline output should not be empty");

        let metadata = crate::media::gstreamer::discoverer::probe_media(&MediaProbeRequest {
            path: output_path.to_string_lossy().to_string(),
        })
        .expect("timeline output should be probe-able");

        assert!(
            metadata.duration_ms.unwrap_or_default() > 1_500.0,
            "unexpected timeline metadata: {:?}",
            metadata
        );
        assert_eq!(metadata.width, Some(640));
        assert_eq!(metadata.height, Some(360));
        assert!(metadata.frame_rate.unwrap_or_default() > 0.0);
        assert!(
            metadata.channels.unwrap_or_default() >= 1,
            "expected rendered audio track: {:?}",
            metadata
        );
    }
}
