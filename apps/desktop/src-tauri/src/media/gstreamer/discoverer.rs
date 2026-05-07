use std::path::Path;

use crate::commands::metadata::MediaMetadataResult;

use super::super::error::MediaResult;
use super::super::model::MediaProbeRequest;
use super::super::runtime;
use super::clock_time::clock_time_to_ms;
use super::command::canonicalize_media_path;
use ges::gst_pbutils::{prelude::*, Discoverer, DiscovererInfo, DiscovererResult, DiscovererVideoInfo};

const DISCOVERER_TIMEOUT_SECONDS: u64 = 5;

pub fn probe_media(request: &MediaProbeRequest) -> MediaResult<MediaMetadataResult> {
    runtime::require_gstreamer_preview_runtime()?;
    runtime::prepare_gstreamer_process_environment()?;

    let media_path = canonicalize_media_path(&request.path)?;
    let uri = media_file_uri(&media_path)?;
    let discoverer = Discoverer::new(gst::ClockTime::from_seconds(DISCOVERER_TIMEOUT_SECONDS))
        .map_err(|error| format!("failed to create GStreamer discoverer: {error}"))?;
    let info = discoverer
        .discover_uri(&uri)
        .map_err(|error| format!("failed to discover media {}: {error}", media_path.display()))?;

    if info.result() != DiscovererResult::Ok {
        return Err(describe_discoverer_failure(
            &info,
            &media_path.display().to_string(),
        ));
    }

    Ok(metadata_from_discoverer_info(&info))
}

fn media_file_uri(path: &Path) -> MediaResult<String> {
    gst::glib::filename_to_uri(path, None)
        .map(|uri| uri.to_string())
        .map_err(|error| {
            format!(
                "failed to convert media path {} to URI: {error}",
                path.display()
            )
        })
}

fn metadata_from_discoverer_info(info: &DiscovererInfo) -> MediaMetadataResult {
    let video_streams = info.video_streams();
    let audio_streams = info.audio_streams();
    let video_stream = video_streams
        .iter()
        .find(|stream| !stream.is_image())
        .or_else(|| video_streams.first());
    let audio_stream = audio_streams.first();

    MediaMetadataResult {
        duration_ms: info.duration().map(clock_time_to_ms),
        width: video_stream.and_then(|stream| nonzero_u32(stream.width())),
        height: video_stream.and_then(|stream| nonzero_u32(stream.height())),
        frame_rate: video_stream.and_then(video_frame_rate),
        channels: audio_stream.and_then(|stream| nonzero_u32(stream.channels())),
        sample_rate: audio_stream.and_then(|stream| nonzero_u32(stream.sample_rate())),
        codec: video_stream
            .and_then(stream_caps_name)
            .or_else(|| audio_stream.and_then(stream_caps_name)),
        has_audio: Some(!audio_streams.is_empty()),
    }
}

fn describe_discoverer_failure(info: &DiscovererInfo, path: &str) -> String {
    let details = info.missing_elements_installer_details();
    if details.is_empty() {
        format!(
            "GStreamer discoverer failed for {path}: {:?}",
            info.result()
        )
    } else {
        let names: Vec<_> = details.into_iter().map(|v| v.to_string()).collect();
        format!(
            "GStreamer discoverer failed for {path}: {:?}; missing plugins: {}",
            info.result(),
            names.join(", ")
        )
    }
}

fn video_frame_rate(stream: &DiscovererVideoInfo) -> Option<f64> {
    let fraction = stream.framerate();
    let numerator = fraction.numer();
    let denominator = fraction.denom();
    if numerator > 0 && denominator > 0 {
        Some(numerator as f64 / denominator as f64)
    } else {
        None
    }
}

fn stream_caps_name(stream: &impl DiscovererStreamInfoExt) -> Option<String> {
    stream
        .caps()
        .and_then(|caps| {
            caps.structure(0)
                .map(|structure| structure.name().to_string())
        })
        .filter(|name| !name.trim().is_empty())
}

fn nonzero_u32(value: u32) -> Option<u32> {
    (value > 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{media_file_uri, nonzero_u32};

    #[test]
    fn nonzero_u32_filters_zero_values() {
        assert_eq!(nonzero_u32(0), None);
        assert_eq!(nonzero_u32(42), Some(42));
    }

    #[test]
    fn media_file_uri_encodes_reserved_characters() {
        let uri = media_file_uri(Path::new("/tmp/OpenDirector #?.wav"))
            .expect("path should convert to a file URI");

        assert_eq!(uri, "file:///tmp/OpenDirector%20%23%3F.wav");
    }
}
