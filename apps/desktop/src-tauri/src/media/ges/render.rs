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
use crate::commands::metadata::MediaMetadataResult;
use crate::media::gstreamer::command::{
    canonicalize_media_path, file_uri, run_tool, GstreamerTool,
};

const H264_ENCODING_PROPERTY: &str = "video/x-h264,bitrate=20000000";

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
        "--encoding-property".to_string(),
        H264_ENCODING_PROPERTY.to_string(),
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
            "--encoding-property".to_string(),
            H264_ENCODING_PROPERTY.to_string(),
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
    let args =
        build_timed_asset_render_args(request, output_path, &input_path, media_type, &metadata);

    let output = run_tool(&runtime.bootstrap, GstreamerTool::GesLaunch, &args)?;
    if !output.status.success() {
        return Err(format!(
            "ges-launch-1.0 render failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(())
}

fn build_timed_asset_render_args(
    request: &AssetProcessRequest,
    output_path: &Path,
    input_path: &Path,
    media_type: &str,
    metadata: &MediaMetadataResult,
) -> Vec<String> {
    let mut args = vec![
        format!("--outputuri={}", file_uri(output_path)),
        format!(
            "--format={}",
            output_format_caps(media_type, request.output_format.as_deref(), metadata)
        ),
    ];

    if media_type == "video" {
        args.extend([
            "--encoding-property".to_string(),
            H264_ENCODING_PROPERTY.to_string(),
        ]);
    }

    let crop_bounds = resolve_timed_asset_crop_bounds(request, metadata);
    let scaled_output_dimensions = resolve_timed_asset_output_dimensions(
        media_type,
        request,
        crop_bounds
            .as_ref()
            .map(|bounds| (bounds.crop_width, bounds.crop_height)),
    );

    if let Some((output_width, output_height)) = scaled_output_dimensions {
        args.extend([
            "+track".to_string(),
            "video".to_string(),
            build_video_track_restrictions(output_width, output_height, metadata.frame_rate),
        ]);

        if timed_asset_has_audio_stream(media_type, metadata) {
            args.extend([
                "+track".to_string(),
                "audio".to_string(),
                build_audio_track_restrictions(
                    metadata.channels.filter(|value| *value > 0),
                    metadata.sample_rate.filter(|value| *value > 0),
                ),
            ]);
        }
    }

    args.extend(["+clip".to_string(), file_uri(input_path)]);

    if let Some(start_seconds) = trim_start_seconds(request) {
        args.push(format!("inpoint={start_seconds}"));
    }

    if let Some(duration_seconds) = trim_duration_seconds(request) {
        args.push(format!("duration={duration_seconds}"));
    }

    if let Some(crop_bounds) = crop_bounds {
        args.extend([
            "+effect".to_string(),
            "videocrop".to_string(),
            "set-left".to_string(),
            crop_bounds.left.to_string(),
            "set-right".to_string(),
            crop_bounds.right.to_string(),
            "set-top".to_string(),
            crop_bounds.top.to_string(),
            "set-bottom".to_string(),
            crop_bounds.bottom.to_string(),
        ]);
    }

    if let Some((output_width, output_height)) = scaled_output_dimensions {
        args.extend(build_video_clip_layout_args(output_width, output_height));
    }

    args
}

#[derive(Debug, Clone, Copy)]
struct TimedAssetCropBounds {
    left: u32,
    right: u32,
    top: u32,
    bottom: u32,
    crop_width: u32,
    crop_height: u32,
}

fn resolve_timed_asset_crop_bounds(
    request: &AssetProcessRequest,
    metadata: &MediaMetadataResult,
) -> Option<TimedAssetCropBounds> {
    let crop = effects::extract_crop_effect(request)?;
    let (width, height) = (metadata.width?, metadata.height?);
    let left = ((crop.x * width as f64).round() as u32).min(width.saturating_sub(1));
    let top = ((crop.y * height as f64).round() as u32).min(height.saturating_sub(1));
    let crop_width = ((crop.width * width as f64).round() as u32).clamp(1, width - left);
    let crop_height = ((crop.height * height as f64).round() as u32).clamp(1, height - top);

    Some(TimedAssetCropBounds {
        left,
        right: width.saturating_sub(left + crop_width),
        top,
        bottom: height.saturating_sub(top + crop_height),
        crop_width,
        crop_height,
    })
}

fn resolve_timed_asset_output_dimensions(
    media_type: &str,
    request: &AssetProcessRequest,
    cropped_dimensions: Option<(u32, u32)>,
) -> Option<(u32, u32)> {
    if media_type != "video" {
        return None;
    }

    if let (Some(max_width), Some(max_height)) = (request.max_width, request.max_height) {
        return Some((
            normalize_video_dimension(max_width),
            normalize_video_dimension(max_height),
        ));
    }

    cropped_dimensions.map(|(width, height)| {
        (
            normalize_video_dimension(width),
            normalize_video_dimension(height),
        )
    })
}

fn build_video_track_restrictions(width: u32, height: u32, frame_rate: Option<f64>) -> String {
    let mut restrictions =
        format!("restrictions=video/x-raw,width={width},height={height},pixel-aspect-ratio=1/1");

    if let Some(frame_rate) = frame_rate.filter(|value| value.is_finite() && *value > 0.0) {
        restrictions.push_str(&format!(",framerate={}", fps_fraction(frame_rate)));
    }

    restrictions
}

fn build_video_clip_layout_args(width: u32, height: u32) -> Vec<String> {
    vec![
        "set-width".to_string(),
        width.to_string(),
        "set-height".to_string(),
        height.to_string(),
        "set-posx".to_string(),
        "0".to_string(),
        "set-posy".to_string(),
        "0".to_string(),
    ]
}

fn build_audio_track_restrictions(channels: Option<u32>, sample_rate: Option<u32>) -> String {
    let channel_count = channels.unwrap_or(2).max(1);
    let sample_rate = sample_rate.unwrap_or(44_100).max(1);

    format!(
        "restrictions=audio/x-raw,channels={channel_count},rate={sample_rate},layout=interleaved"
    )
}

fn timed_asset_has_audio_stream(media_type: &str, metadata: &MediaMetadataResult) -> bool {
    if media_type != "video" {
        return false;
    }

    metadata.has_audio.unwrap_or_else(|| {
        metadata.channels.filter(|value| *value > 0).is_some()
            || metadata.sample_rate.filter(|value| *value > 0).is_some()
    })
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

fn normalize_video_dimension(value: u32) -> u32 {
    let normalized = value.max(2);
    if normalized % 2 == 0 {
        normalized
    } else {
        normalized - 1
    }
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

fn output_format_caps(
    media_type: &str,
    output_format: Option<&str>,
    metadata: &MediaMetadataResult,
) -> String {
    match (media_type, output_format.unwrap_or("")) {
        ("audio", "mp3") => "audio/mpeg,mpegversion=1,layer=3".to_string(),
        ("audio", _) => wav_audio_output_format_caps(
            metadata.channels.filter(|value| *value > 0),
            metadata.sample_rate.filter(|value| *value > 0),
        ),
        (_, _) => "video/quicktime:video/x-h264:audio/mpeg,mpegversion=4".to_string(),
    }
}

fn timeline_output_format_caps(output_format: Option<&str>, has_video: bool) -> String {
    if !has_video {
        return match output_format.unwrap_or("") {
            "mp3" => "audio/mpeg,mpegversion=1,layer=3".to_string(),
            _ => wav_audio_output_format_caps(Some(2), Some(44_100)),
        };
    }

    match output_format.unwrap_or("") {
        "mov" => "video/quicktime:video/x-h264:audio/mpeg,mpegversion=4".to_string(),
        _ => "video/quicktime:video/x-h264:audio/mpeg,mpegversion=4".to_string(),
    }
}

fn wav_audio_output_format_caps(channels: Option<u32>, sample_rate: Option<u32>) -> String {
    let mut caps = "audio/x-wav:audio/x-raw,format=S16LE,layout=interleaved".to_string();

    if let Some(rate) = sample_rate {
        caps.push_str(&format!(",rate={rate}"));
    }

    if let Some(channel_count) = channels {
        caps.push_str(&format!(",channels={channel_count}"));
    }

    caps
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
        let dir = std::env::temp_dir().join(format!("opendirector-{case_name}-{suffix}"));
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
    fn build_timed_asset_render_args_applies_track_restrictions_for_cropped_video() {
        let request = AssetProcessRequest {
            backend: None,
            input_path: "/tmp/input.mp4".to_string(),
            output_dir: "/tmp/output".to_string(),
            crop_x: Some(0.0),
            crop_y: Some(0.0),
            crop_w: Some(0.421875),
            crop_h: Some(1.0),
            trim_start_ms: Some(250.0),
            trim_end_ms: Some(1250.0),
            max_width: None,
            max_height: None,
            target_aspect_ratio: Some("3:4".to_string()),
            output_format: Some("mp4".to_string()),
        };
        let output_path = Path::new("/tmp/output/processed.mp4");
        let input_path = Path::new("/tmp/input.mp4");
        let metadata = MediaMetadataResult {
            duration_ms: Some(2_000.0),
            width: Some(1920),
            height: Some(1080),
            frame_rate: Some(30.0),
            channels: Some(2),
            sample_rate: Some(48_000),
            codec: Some("video/quicktime".to_string()),
            has_audio: Some(true),
        };

        let args =
            build_timed_asset_render_args(&request, output_path, input_path, "video", &metadata);

        assert!(args.iter().any(|arg| {
            arg == "restrictions=video/x-raw,width=810,height=1080,pixel-aspect-ratio=1/1,framerate=30/1"
        }));
        assert!(args.iter().any(|arg| {
            arg == "restrictions=audio/x-raw,channels=2,rate=48000,layout=interleaved"
        }));
        assert!(args.iter().any(|arg| arg == "videocrop"));
        assert!(args.iter().any(|arg| arg == "set-width"));
        assert!(args.iter().any(|arg| arg == "810"));
        assert!(args.iter().any(|arg| arg == "set-height"));
        assert!(args.iter().any(|arg| arg == "1080"));
        assert!(args.iter().any(|arg| arg == "set-posx"));
        assert!(args.iter().any(|arg| arg == "set-posy"));
        assert!(args.iter().any(|arg| arg == "inpoint=0.250000"));
        assert!(args.iter().any(|arg| arg == "duration=1.000000"));
    }

    #[test]
    fn build_timed_asset_render_args_applies_track_restrictions_for_scaled_video() {
        let request = AssetProcessRequest {
            backend: None,
            input_path: "/tmp/input.mp4".to_string(),
            output_dir: "/tmp/output".to_string(),
            crop_x: None,
            crop_y: None,
            crop_w: None,
            crop_h: None,
            trim_start_ms: None,
            trim_end_ms: None,
            max_width: Some(720),
            max_height: Some(1280),
            target_aspect_ratio: None,
            output_format: Some("mp4".to_string()),
        };
        let output_path = Path::new("/tmp/output/processed.mp4");
        let input_path = Path::new("/tmp/input.mp4");
        let metadata = MediaMetadataResult {
            duration_ms: Some(2_000.0),
            width: Some(1920),
            height: Some(1080),
            frame_rate: Some(25.0),
            channels: Some(2),
            sample_rate: Some(44_100),
            codec: Some("video/quicktime".to_string()),
            has_audio: Some(true),
        };

        let args =
            build_timed_asset_render_args(&request, output_path, input_path, "video", &metadata);

        assert!(args.iter().any(|arg| {
            arg == "restrictions=video/x-raw,width=720,height=1280,pixel-aspect-ratio=1/1,framerate=25/1"
        }));
        assert!(args.iter().any(|arg| arg == "set-width"));
        assert!(args.iter().any(|arg| arg == "720"));
        assert!(args.iter().any(|arg| arg == "set-height"));
        assert!(args.iter().any(|arg| arg == "1280"));
    }

    #[test]
    fn build_timed_asset_render_args_keeps_audio_track_when_probe_omits_audio_details() {
        let request = AssetProcessRequest {
            backend: None,
            input_path: "/tmp/input.mp4".to_string(),
            output_dir: "/tmp/output".to_string(),
            crop_x: Some(0.0),
            crop_y: Some(0.0),
            crop_w: Some(0.5),
            crop_h: Some(1.0),
            trim_start_ms: None,
            trim_end_ms: None,
            max_width: None,
            max_height: None,
            target_aspect_ratio: Some("1:1".to_string()),
            output_format: Some("mp4".to_string()),
        };
        let output_path = Path::new("/tmp/output/processed.mp4");
        let input_path = Path::new("/tmp/input.mp4");
        let metadata = MediaMetadataResult {
            duration_ms: Some(2_000.0),
            width: Some(1920),
            height: Some(1080),
            frame_rate: Some(30.0),
            channels: None,
            sample_rate: None,
            codec: Some("video/quicktime".to_string()),
            has_audio: Some(true),
        };

        let args =
            build_timed_asset_render_args(&request, output_path, input_path, "video", &metadata);

        assert!(args.iter().any(|arg| arg == "audio"));
        assert!(args.iter().any(|arg| {
            arg == "restrictions=audio/x-raw,channels=2,rate=44100,layout=interleaved"
        }));
    }

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn process_cropped_video_smoke_outputs_requested_canvas() {
        let case_dir = temp_case_dir("process-cropped-video");
        let input_path = case_dir.join("input.mp4");
        let processed_dir = case_dir.join("processed");
        let request = AssetProcessRequest {
            backend: None,
            input_path: input_path.to_string_lossy().to_string(),
            output_dir: processed_dir.to_string_lossy().to_string(),
            crop_x: Some(0.2890625),
            crop_y: Some(0.0),
            crop_w: Some(0.421875),
            crop_h: Some(1.0),
            trim_start_ms: None,
            trim_end_ms: None,
            max_width: None,
            max_height: None,
            target_aspect_ratio: Some("3:4".to_string()),
            output_format: Some("mp4".to_string()),
        };

        render_test_clip(&input_path, "snow", 2.0);
        let input_metadata = crate::media::gstreamer::discoverer::probe_media(&MediaProbeRequest {
            path: request.input_path.clone(),
        })
        .expect("input clip should be probe-able");
        let crop_bounds =
            resolve_timed_asset_crop_bounds(&request, &input_metadata).expect("crop should resolve");
        let expected_dimensions = resolve_timed_asset_output_dimensions(
            "video",
            &request,
            Some((crop_bounds.crop_width, crop_bounds.crop_height)),
        )
        .expect("output dimensions should resolve");

        let processed = process_asset(&request).expect("cropped video process_asset should succeed");

        assert!(
            Path::new(&processed.output_path).exists(),
            "processed output should exist"
        );
        assert!(
            processed.file_size > 0,
            "processed output should not be empty"
        );

        let metadata = crate::media::gstreamer::discoverer::probe_media(&MediaProbeRequest {
            path: processed.output_path,
        })
        .expect("processed output should be probe-able");

        assert_eq!(metadata.width, Some(expected_dimensions.0));
        assert_eq!(metadata.height, Some(expected_dimensions.1));
        assert!(metadata.frame_rate.unwrap_or_default() > 0.0);
    }

    #[test]
    fn output_format_caps_uses_audio_stream_profile_for_wav() {
        let metadata = MediaMetadataResult {
            duration_ms: Some(2_000.0),
            width: None,
            height: None,
            frame_rate: None,
            channels: Some(1),
            sample_rate: Some(44_100),
            codec: Some("audio/x-wav".to_string()),
            has_audio: Some(true),
        };

        let caps = output_format_caps("audio", None, &metadata);

        assert_eq!(
            caps,
            "audio/x-wav:audio/x-raw,format=S16LE,layout=interleaved,rate=44100,channels=1"
        );
    }

    #[test]
    fn timeline_output_format_caps_uses_audio_stream_profile_for_audio_only_wav() {
        let caps = timeline_output_format_caps(None, false);

        assert_eq!(
            caps,
            "audio/x-wav:audio/x-raw,format=S16LE,layout=interleaved,rate=44100,channels=2"
        );
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

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn render_audio_only_timeline_smoke() {
        let case_dir = temp_case_dir("timeline-render-audio-only");
        let audio_path = case_dir.join("tone.wav");
        let output_path = case_dir.join("timeline.wav");

        write_test_wav(&audio_path, 2.0);

        let result = render_timeline(&TimelineRenderRequest {
            backend: None,
            output_path: output_path.to_string_lossy().to_string(),
            output_format: Some("wav".to_string()),
            width: 640,
            height: 360,
            fps: 25.0,
            tracks: vec![TimelineRenderTrack {
                id: "audio-main".to_string(),
                track_type: TimelineTrackType::Audio,
                muted: false,
                order: 0,
            }],
            clips: vec![TimelineRenderClip {
                id: "audio-clip".to_string(),
                track_id: "audio-main".to_string(),
                input_path: audio_path.to_string_lossy().to_string(),
                start_ms: 0.0,
                duration_ms: 1_000.0,
                trim_start_ms: Some(250.0),
                mute: None,
                crop: None,
                transform: None,
            }],
        })
        .expect("audio-only timeline render should succeed");

        assert_eq!(result.output_path, output_path.to_string_lossy());
        assert!(
            output_path.exists(),
            "audio-only timeline output should exist"
        );
        assert!(
            result.file_size > 0,
            "audio-only timeline output should not be empty"
        );

        let metadata = crate::media::gstreamer::discoverer::probe_media(&MediaProbeRequest {
            path: output_path.to_string_lossy().to_string(),
        })
        .expect("audio-only timeline output should be probe-able");

        assert!(
            metadata.duration_ms.unwrap_or_default() > 900.0,
            "unexpected audio-only timeline metadata: {:?}",
            metadata
        );
        assert_eq!(metadata.sample_rate, Some(44_100));
        assert_eq!(metadata.channels, Some(2));
    }
}
