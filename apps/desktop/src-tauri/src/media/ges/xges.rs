use reqwest::Url;
use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use crate::media::gstreamer::command::{
    canonicalize_media_path, file_uri, portable_path_string, run_tool, GstreamerTool,
};
use crate::media::model::MediaProbeRequest;
use crate::media::runtime;

use super::args::fps_fraction;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesTimelineExportRequest {
    pub project_name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub tracks: Vec<XgesTimelineTrack>,
    pub clips: Vec<XgesTimelineClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum XgesTrackType {
    Video,
    Audio,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesTimelineTrack {
    pub id: String,
    #[serde(rename = "type")]
    pub track_type: XgesTrackType,
    pub muted: bool,
    pub order: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesTimelineClip {
    pub id: String,
    pub track_id: String,
    pub input_path: String,
    pub name: Option<String>,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub trim_start_ms: Option<f64>,
    pub mute: Option<bool>,
    pub crop: Option<XgesTimelineCrop>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesTimelineCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesImportWarning {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum XgesImportedAssetType {
    Video,
    Image,
    Audio,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesImportedAsset {
    pub id: String,
    pub name: String,
    pub local_path: String,
    pub duration: Option<f64>,
    #[serde(rename = "type")]
    pub asset_type: XgesImportedAssetType,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesImportedFragment {
    pub id: String,
    pub name: String,
    pub start: f64,
    pub duration: f64,
    pub trim_start: Option<f64>,
    pub source_asset_id: Option<String>,
    pub crop: Option<XgesTimelineCrop>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesImportedTrack {
    pub id: String,
    #[serde(rename = "type")]
    pub track_type: XgesTrackType,
    pub name: String,
    pub muted: bool,
    pub order: i32,
    pub fragments: Vec<XgesImportedFragment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedXgesProject {
    pub project_name: String,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub assets: Vec<XgesImportedAsset>,
    pub tracks: Vec<XgesImportedTrack>,
    pub total_duration: f64,
    pub warnings: Vec<XgesImportWarning>,
}

pub fn export_timeline_to_xges(
    request: &XgesTimelineExportRequest,
    output_path: &Path,
) -> Result<(), String> {
    let runtime = runtime::require_gstreamer_runtime()?;
    validate_request(request)?;

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create XGES output directory: {err}"))?;
    }

    let args = build_save_args(request, output_path)?;
    let output = run_tool(&runtime.bootstrap, GstreamerTool::GesLaunch, &args)?;
    if !output.status.success() {
        return Err(format!(
            "ges-launch-1.0 save failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    if let Some(project_name) = request.project_name.as_deref() {
        annotate_project_name(output_path, project_name)?;
    }

    Ok(())
}

fn validate_request(request: &XgesTimelineExportRequest) -> Result<(), String> {
    if request.width == 0 || request.height == 0 {
        return Err("XGES export requires a positive output resolution".to_string());
    }

    if !request.fps.is_finite() || request.fps <= 0.0 {
        return Err("XGES export requires a positive fps value".to_string());
    }

    if request.tracks.is_empty() {
        return Err("XGES export requires at least one track".to_string());
    }

    let track_ids: std::collections::HashSet<&str> = request
        .tracks
        .iter()
        .map(|track| track.id.as_str())
        .collect();
    for clip in &request.clips {
        if clip.duration_ms <= 0.0 {
            return Err(format!("XGES clip {} has a non-positive duration", clip.id));
        }

        if !track_ids.contains(clip.track_id.as_str()) {
            return Err(format!(
                "XGES clip {} references unknown track {}",
                clip.id, clip.track_id
            ));
        }
    }

    Ok(())
}

fn build_save_args(
    request: &XgesTimelineExportRequest,
    output_path: &Path,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        format!("--save-only={}", portable_path_string(output_path)),
        "--no-interactive".to_string(),
    ];

    let has_video = request
        .tracks
        .iter()
        .any(|track| track.track_type == XgesTrackType::Video);
    let has_audio = request
        .tracks
        .iter()
        .any(|track| track.track_type == XgesTrackType::Audio);

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

    let layer_by_track_id = build_layer_map(&request.tracks);
    let track_by_id: HashMap<&str, &XgesTimelineTrack> = request
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
                "XGES clip {} references unknown track {}",
                clip.id, clip.track_id
            )
        })?;
        let layer = layer_by_track_id
            .get(clip.track_id.as_str())
            .copied()
            .unwrap_or(0);

        args.extend(build_clip_args(track, &clip, layer)?);
    }

    Ok(args)
}

fn build_layer_map(tracks: &[XgesTimelineTrack]) -> HashMap<&str, usize> {
    let mut map = HashMap::new();

    let mut video_tracks: Vec<&XgesTimelineTrack> = tracks
        .iter()
        .filter(|track| track.track_type == XgesTrackType::Video)
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

    let mut audio_tracks: Vec<&XgesTimelineTrack> = tracks
        .iter()
        .filter(|track| track.track_type == XgesTrackType::Audio)
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

fn build_clip_args(
    track: &XgesTimelineTrack,
    clip: &XgesTimelineClip,
    layer: usize,
) -> Result<Vec<String>, String> {
    let input_path = canonicalize_media_path(&clip.input_path)?;
    let mut args = vec![
        "+clip".to_string(),
        file_uri(&input_path),
        format!("name={}", clip_token(clip)),
        format!("layer={layer}"),
        format!("start={:.6}", (clip.start_ms.max(0.0)) / 1000.0),
        format!("duration={:.6}", clip.duration_ms / 1000.0),
        format!(
            "track-types={}",
            match track.track_type {
                XgesTrackType::Video => "video",
                XgesTrackType::Audio => "audio",
            }
        ),
    ];

    if let Some(trim_start_ms) = clip.trim_start_ms.filter(|value| *value > 0.0) {
        args.push(format!("inpoint={:.6}", trim_start_ms / 1000.0));
    }

    if let Some(crop_args) = build_crop_args(track, clip)? {
        args.extend(crop_args);
    }

    if track.track_type == XgesTrackType::Audio
        && (track.muted || clip.mute.unwrap_or(false))
    {
        args.extend(["set-volume".to_string(), "0.0".to_string()]);
    }

    Ok(args)
}

fn build_crop_args(
    track: &XgesTimelineTrack,
    clip: &XgesTimelineClip,
) -> Result<Option<Vec<String>>, String> {
    if track.track_type != XgesTrackType::Video {
        return Ok(None);
    }

    let Some(crop) = clip.crop.as_ref() else {
        return Ok(None);
    };

    let metadata = crate::media::gstreamer::discoverer::probe_media(&MediaProbeRequest {
        path: clip.input_path.clone(),
    })?;

    let Some(width) = metadata.width else {
        return Ok(None);
    };
    let Some(height) = metadata.height else {
        return Ok(None);
    };

    let left = ((crop.x * width as f64).round() as u32).min(width.saturating_sub(1));
    let top = ((crop.y * height as f64).round() as u32).min(height.saturating_sub(1));
    let crop_width = ((crop.width * width as f64).round() as u32).clamp(1, width - left);
    let crop_height = ((crop.height * height as f64).round() as u32).clamp(1, height - top);
    let right = width.saturating_sub(left + crop_width);
    let bottom = height.saturating_sub(top + crop_height);

    Ok(Some(vec![
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
    ]))
}

fn clip_token(clip: &XgesTimelineClip) -> String {
    let raw = clip.name.as_deref().unwrap_or(&clip.id);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return clip.id.clone();
    }

    trimmed
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => ch,
            _ => '_',
        })
        .collect()
}

fn annotate_project_name(output_path: &Path, project_name: &str) -> Result<(), String> {
    let sanitized_name = sanitize_project_name(project_name);
    if sanitized_name.is_empty() {
        return Ok(());
    }

    let contents = std::fs::read_to_string(output_path).map_err(|err| {
        format!(
            "failed to read generated XGES {}: {err}",
            output_path.display()
        )
    })?;

    let updated = if contents.contains("properties='properties;'") {
        contents.replacen(
            "properties='properties;'",
            &format!("properties='properties, name=(string){sanitized_name};'"),
            1,
        )
    } else if contents.contains("properties=\"properties;\"") {
        contents.replacen(
            "properties=\"properties;\"",
            &format!("properties=\"properties, name=(string){sanitized_name};\""),
            1,
        )
    } else {
        contents
    };

    std::fs::write(output_path, updated).map_err(|err| {
        format!(
            "failed to update XGES project metadata {}: {err}",
            output_path.display()
        )
    })
}

fn sanitize_project_name(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| match ch {
            '\'' | '"' | ';' | '\r' | '\n' => '_',
            _ => ch,
        })
        .collect::<String>()
}

struct ParsedAssetRecord {
    imported: XgesImportedAsset,
    has_video: bool,
    has_audio: bool,
}

struct ParsedLayerFragment {
    layer_priority: i32,
    track_type: XgesTrackType,
    muted: bool,
    path: Option<String>,
    fragment: XgesImportedFragment,
}

pub fn parse_xges_project(contents: &str) -> Result<ParsedXgesProject, String> {
    let document =
        Document::parse(contents).map_err(|err| format!("Failed to parse XGES XML: {err}"))?;
    let project = document
        .descendants()
        .find(|node| node.has_tag_name("project"))
        .ok_or_else(|| "XGES project element not found".to_string())?;
    let timeline = project
        .children()
        .find(|node| node.has_tag_name("timeline"))
        .ok_or_else(|| "XGES timeline element not found".to_string())?;

    let mut warnings = Vec::new();
    let assets_by_uri = parse_asset_catalog(project, &mut warnings);
    let track_types_by_id = parse_track_types(timeline);
    let (width, height, fps) = resolve_timeline_format(timeline, assets_by_uri.values());
    let fragments =
        parse_timeline_fragments(timeline, &assets_by_uri, &track_types_by_id, &mut warnings);
    let total_duration = fragments
        .iter()
        .map(|entry| entry.fragment.start + entry.fragment.duration)
        .fold(0.0_f64, f64::max);
    let tracks = build_import_tracks(fragments, &mut warnings);

    let mut assets: Vec<_> = assets_by_uri
        .into_values()
        .map(|record| record.imported)
        .collect();
    assets.sort_by(|left, right| left.local_path.cmp(&right.local_path));

    Ok(ParsedXgesProject {
        project_name: extract_node_string_property(project, "name")
            .or_else(|| extract_node_string_property(project, "title"))
            .unwrap_or_else(|| "Imported XGES Project".to_string()),
        fps,
        width,
        height,
        assets,
        tracks,
        total_duration,
        warnings,
    })
}

fn parse_asset_catalog(
    project: Node<'_, '_>,
    warnings: &mut Vec<XgesImportWarning>,
) -> HashMap<String, ParsedAssetRecord> {
    let mut assets = HashMap::new();

    for asset in project.descendants().filter(|node| {
        node.has_tag_name("asset")
            && node
                .parent()
                .is_some_and(|parent| parent.has_tag_name("ressources"))
    }) {
        if asset.attribute("extractable-type-name") != Some("GESUriClip") {
            continue;
        }

        let Some(asset_uri) = asset.attribute("id") else {
            warnings.push(XgesImportWarning {
                code: "missing_asset_id".to_string(),
                message: "Skipped XGES asset without an id attribute.".to_string(),
                path: None,
            });
            continue;
        };

        let properties = parse_property_string(asset.attribute("properties").unwrap_or_default());
        let local_path = uri_to_local_path(asset_uri).unwrap_or_else(|| {
            warnings.push(XgesImportWarning {
                code: "non_file_asset_uri".to_string(),
                message: format!(
                    "XGES asset uses a non-file URI and was imported as-is: {asset_uri}"
                ),
                path: Some(asset_uri.to_string()),
            });
            asset_uri.to_string()
        });

        let mut has_video = false;
        let mut has_audio = false;
        let mut is_image = false;
        let mut width = None;
        let mut height = None;

        for stream_info in asset
            .children()
            .filter(|node| node.has_tag_name("stream-info"))
        {
            let extractable_type = stream_info
                .attribute("extractable-type-name")
                .unwrap_or_default();
            let caps = stream_info.attribute("caps").unwrap_or_default();

            if extractable_type.contains("Video") {
                has_video = true;
                if caps.trim_start().starts_with("image/") {
                    is_image = true;
                }
                width = width.or_else(|| extract_caps_u32(caps, "width"));
                height = height.or_else(|| extract_caps_u32(caps, "height"));
            }

            if extractable_type.contains("Audio") {
                has_audio = true;
            }
        }

        let asset_type = if has_video && is_image && !has_audio {
            XgesImportedAssetType::Image
        } else if has_video {
            XgesImportedAssetType::Video
        } else if has_audio {
            XgesImportedAssetType::Audio
        } else {
            warnings.push(XgesImportWarning {
                code: "unknown_asset_type".to_string(),
                message: format!(
                    "Could not infer media type for XGES asset {asset_uri}; defaulted to video."
                ),
                path: Some(local_path.clone()),
            });
            XgesImportedAssetType::Video
        };

        let imported = XgesImportedAsset {
            id: make_asset_id(asset_uri),
            name: properties
                .get("name")
                .cloned()
                .filter(|value| !value.is_empty())
                .or_else(|| derive_asset_name(&local_path))
                .unwrap_or_else(|| asset_uri.to_string()),
            local_path,
            duration: properties
                .get("duration")
                .and_then(|value| value.parse::<u64>().ok())
                .map(ns_to_ms),
            asset_type,
            width,
            height,
        };

        assets.insert(
            asset_uri.to_string(),
            ParsedAssetRecord {
                imported,
                has_video,
                has_audio,
            },
        );
    }

    assets
}

fn parse_track_types(timeline: Node<'_, '_>) -> HashMap<String, XgesTrackType> {
    let mut mapping = HashMap::new();

    for track in timeline
        .children()
        .filter(|node| node.has_tag_name("track"))
    {
        let Some(track_id) = track.attribute("track-id") else {
            continue;
        };
        let Some(track_type) =
            parse_track_type_mask(track.attribute("track-type").unwrap_or_default())
                .into_iter()
                .next()
        else {
            continue;
        };
        mapping.insert(track_id.to_string(), track_type);
    }

    mapping
}

fn resolve_timeline_format<'a>(
    timeline: Node<'a, 'a>,
    assets: impl Iterator<Item = &'a ParsedAssetRecord>,
) -> (u32, u32, f64) {
    for track in timeline
        .children()
        .filter(|node| node.has_tag_name("track"))
    {
        let Some(track_type) =
            parse_track_type_mask(track.attribute("track-type").unwrap_or_default())
                .into_iter()
                .next()
        else {
            continue;
        };
        if track_type != XgesTrackType::Video {
            continue;
        }

        let properties = parse_property_string(track.attribute("properties").unwrap_or_default());
        let Some(restriction_caps) = properties.get("restriction-caps") else {
            continue;
        };
        let normalized_caps = normalize_caps_string(restriction_caps);
        let width = extract_caps_u32(&normalized_caps, "width");
        let height = extract_caps_u32(&normalized_caps, "height");
        let fps = extract_caps_fraction(&normalized_caps, "framerate");

        if let (Some(width), Some(height), Some(fps)) = (width, height, fps) {
            return (width, height, fps);
        }
    }

    let fallback_asset = assets
        .filter(|asset| {
            matches!(
                asset.imported.asset_type,
                XgesImportedAssetType::Video | XgesImportedAssetType::Image
            )
        })
        .find(|asset| asset.imported.width.is_some() && asset.imported.height.is_some());

    (
        fallback_asset
            .and_then(|asset| asset.imported.width)
            .unwrap_or(1920),
        fallback_asset
            .and_then(|asset| asset.imported.height)
            .unwrap_or(1080),
        30.0,
    )
}

fn parse_timeline_fragments(
    timeline: Node<'_, '_>,
    assets_by_uri: &HashMap<String, ParsedAssetRecord>,
    track_types_by_id: &HashMap<String, XgesTrackType>,
    warnings: &mut Vec<XgesImportWarning>,
) -> Vec<ParsedLayerFragment> {
    let mut fragments = Vec::new();

    for layer in timeline
        .children()
        .filter(|node| node.has_tag_name("layer"))
    {
        let layer_priority = layer
            .attribute("priority")
            .and_then(|value| value.parse::<i32>().ok())
            .unwrap_or(0);

        for clip in layer.children().filter(|node| node.has_tag_name("clip")) {
            fragments.extend(parse_clip(
                clip,
                layer_priority,
                assets_by_uri,
                track_types_by_id,
                warnings,
            ));
        }
    }

    fragments
}

fn parse_clip(
    clip: Node<'_, '_>,
    layer_priority: i32,
    assets_by_uri: &HashMap<String, ParsedAssetRecord>,
    track_types_by_id: &HashMap<String, XgesTrackType>,
    warnings: &mut Vec<XgesImportWarning>,
) -> Vec<ParsedLayerFragment> {
    let clip_id = clip.attribute("id").unwrap_or("clip");
    let properties = parse_property_string(clip.attribute("properties").unwrap_or_default());
    let asset_uri = clip.attribute("asset-id").unwrap_or_default();
    let asset = assets_by_uri.get(asset_uri);
    let name = properties
        .get("name")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("Clip {clip_id}"));
    let start = clip
        .attribute("start")
        .and_then(|value| value.parse::<u64>().ok())
        .map(ns_to_ms)
        .unwrap_or(0.0);
    let duration = clip
        .attribute("duration")
        .and_then(|value| value.parse::<u64>().ok())
        .map(ns_to_ms)
        .unwrap_or(0.0);
    let trim_start = clip
        .attribute("inpoint")
        .and_then(|value| value.parse::<u64>().ok())
        .map(ns_to_ms)
        .filter(|value| *value > 0.0);

    if duration <= 0.0 {
        warnings.push(XgesImportWarning {
            code: "non_positive_clip_duration".to_string(),
            message: format!("Skipped XGES clip {clip_id} because its duration is not positive."),
            path: asset.map(|record| record.imported.local_path.clone()),
        });
        return Vec::new();
    }

    let track_types = {
        let parsed = parse_track_type_mask(clip.attribute("track-types").unwrap_or_default());
        if parsed.is_empty() {
            infer_track_types_from_asset(asset)
        } else {
            parsed
        }
    };

    if track_types.is_empty() {
        warnings.push(XgesImportWarning {
            code: "unknown_clip_track_type".to_string(),
            message: format!(
                "Skipped XGES clip {clip_id} because its track type could not be inferred."
            ),
            path: asset.map(|record| record.imported.local_path.clone()),
        });
        return Vec::new();
    }

    let video_crop = parse_clip_crop(clip, asset, warnings);
    let audio_muted = clip_audio_muted(clip, track_types_by_id);

    if asset.is_none() && !asset_uri.is_empty() {
        warnings.push(XgesImportWarning {
            code: "missing_asset_reference".to_string(),
            message: format!("XGES clip {clip_id} references missing asset {asset_uri}."),
            path: Some(asset_uri.to_string()),
        });
    }

    track_types
        .into_iter()
        .map(|track_type| ParsedLayerFragment {
            layer_priority,
            track_type: track_type.clone(),
            muted: track_type == XgesTrackType::Audio && audio_muted,
            path: asset.map(|record| record.imported.local_path.clone()),
            fragment: XgesImportedFragment {
                id: format!(
                    "xges-{clip_id}-{}",
                    match track_type {
                        XgesTrackType::Video => "video",
                        XgesTrackType::Audio => "audio",
                    }
                ),
                name: name.clone(),
                start,
                duration,
                trim_start,
                source_asset_id: asset.map(|record| record.imported.id.clone()),
                crop: if track_type == XgesTrackType::Video {
                    video_crop.clone()
                } else {
                    None
                },
            },
        })
        .collect()
}

fn build_import_tracks(
    fragments: Vec<ParsedLayerFragment>,
    warnings: &mut Vec<XgesImportWarning>,
) -> Vec<XgesImportedTrack> {
    let mut video_layers: BTreeMap<i32, Vec<ParsedLayerFragment>> = BTreeMap::new();
    let mut audio_layers: BTreeMap<i32, Vec<ParsedLayerFragment>> = BTreeMap::new();

    for entry in fragments {
        match entry.track_type {
            XgesTrackType::Video => video_layers
                .entry(entry.layer_priority)
                .or_default()
                .push(entry),
            XgesTrackType::Audio => audio_layers
                .entry(entry.layer_priority)
                .or_default()
                .push(entry),
        }
    }

    let video_count = video_layers.len() as i32;
    let mut tracks = Vec::new();

    for (index, (layer_priority, mut layer_fragments)) in video_layers.into_iter().enumerate() {
        layer_fragments.sort_by(|left, right| {
            left.fragment
                .start
                .total_cmp(&right.fragment.start)
                .then_with(|| left.fragment.id.cmp(&right.fragment.id))
        });
        let order = video_count - 1 - index as i32;
        tracks.push(XgesImportedTrack {
            id: format!("xges-video-layer-{layer_priority}"),
            track_type: XgesTrackType::Video,
            name: format!("Video Track {}", order + 1),
            muted: false,
            order,
            fragments: layer_fragments
                .into_iter()
                .map(|entry| entry.fragment)
                .collect(),
        });
    }

    for (index, (layer_priority, mut layer_fragments)) in audio_layers.into_iter().enumerate() {
        layer_fragments.sort_by(|left, right| {
            left.fragment
                .start
                .total_cmp(&right.fragment.start)
                .then_with(|| left.fragment.id.cmp(&right.fragment.id))
        });
        let has_muted = layer_fragments.iter().any(|entry| entry.muted);
        let has_unmuted = layer_fragments.iter().any(|entry| !entry.muted);
        let muted = has_muted && !has_unmuted;

        if has_muted && has_unmuted {
            let path = layer_fragments.iter().find_map(|entry| entry.path.clone());
            warnings.push(XgesImportWarning {
                code: "unsupported_partial_audio_mute".to_string(),
                message: format!(
                    "XGES audio layer {layer_priority} mixes muted and audible clips; OpenDirector imported the track as audible because fragment-level mute is not supported."
                ),
                path,
            });
        }

        let order = index as i32;
        tracks.push(XgesImportedTrack {
            id: format!("xges-audio-layer-{layer_priority}"),
            track_type: XgesTrackType::Audio,
            name: format!("Audio Track {}", order + 1),
            muted,
            order,
            fragments: layer_fragments
                .into_iter()
                .map(|entry| entry.fragment)
                .collect(),
        });
    }

    tracks
}

fn parse_clip_crop(
    clip: Node<'_, '_>,
    asset: Option<&ParsedAssetRecord>,
    warnings: &mut Vec<XgesImportWarning>,
) -> Option<XgesTimelineCrop> {
    let Some(asset) = asset else {
        return None;
    };

    let (Some(source_width), Some(source_height)) = (asset.imported.width, asset.imported.height)
    else {
        return None;
    };

    for effect in clip.children().filter(|node| node.has_tag_name("effect")) {
        if effect.attribute("asset-id") != Some("videocrop") {
            continue;
        }

        let properties =
            parse_property_string(effect.attribute("children-properties").unwrap_or_default());
        let left = properties
            .get("GstVideoCrop::left")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let right = properties
            .get("GstVideoCrop::right")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let top = properties
            .get("GstVideoCrop::top")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let bottom = properties
            .get("GstVideoCrop::bottom")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);

        let width = source_width as f64;
        let height = source_height as f64;
        let visible_width = (width - left - right).max(1.0);
        let visible_height = (height - top - bottom).max(1.0);

        return Some(XgesTimelineCrop {
            x: (left / width).clamp(0.0, 1.0),
            y: (top / height).clamp(0.0, 1.0),
            width: (visible_width / width).clamp(0.0, 1.0),
            height: (visible_height / height).clamp(0.0, 1.0),
        });
    }

    if clip.children().any(|node| node.has_tag_name("effect")) {
        warnings.push(XgesImportWarning {
            code: "unsupported_clip_effect".to_string(),
            message: format!(
                "XGES clip {} contains effects beyond videocrop; unsupported effects were ignored.",
                clip.attribute("id").unwrap_or("clip")
            ),
            path: Some(asset.imported.local_path.clone()),
        });
    }

    None
}

fn clip_audio_muted(
    clip: Node<'_, '_>,
    track_types_by_id: &HashMap<String, XgesTrackType>,
) -> bool {
    for source in clip.children().filter(|node| node.has_tag_name("source")) {
        let source_type = source
            .attribute("track-id")
            .and_then(|track_id| track_types_by_id.get(track_id))
            .cloned()
            .or_else(|| {
                let properties =
                    parse_property_string(source.attribute("properties").unwrap_or_default());
                properties
                    .get("track-type")
                    .and_then(|value| parse_track_type_mask(value).into_iter().next())
            });

        if source_type != Some(XgesTrackType::Audio) {
            continue;
        }

        let properties =
            parse_property_string(source.attribute("children-properties").unwrap_or_default());
        let muted = properties
            .get("GstVolume::mute")
            .map(|value| value == "true")
            .unwrap_or(false);
        let volume = properties
            .get("GstVolume::volume")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(1.0);

        if muted || volume.abs() <= f64::EPSILON {
            return true;
        }
    }

    false
}

fn parse_track_type_mask(value: &str) -> Vec<XgesTrackType> {
    let Ok(mask) = value.trim().parse::<u32>() else {
        return Vec::new();
    };

    let mut types = Vec::new();
    if mask & 4 != 0 {
        types.push(XgesTrackType::Video);
    }
    if mask & 2 != 0 {
        types.push(XgesTrackType::Audio);
    }
    types
}

fn infer_track_types_from_asset(asset: Option<&ParsedAssetRecord>) -> Vec<XgesTrackType> {
    let Some(asset) = asset else {
        return Vec::new();
    };

    let mut types = Vec::new();
    if asset.has_video {
        types.push(XgesTrackType::Video);
    }
    if asset.has_audio {
        types.push(XgesTrackType::Audio);
    }
    types
}

fn parse_property_string(raw: &str) -> HashMap<String, String> {
    let mut properties = HashMap::new();
    let mut remainder = raw.trim();

    if let Some(prefix_end) = remainder.find(',') {
        let prefix = remainder[..prefix_end].trim();
        if prefix == "properties" || prefix == "metadatas" {
            remainder = &remainder[prefix_end + 1..];
        }
    }

    while !remainder.trim().is_empty() {
        remainder = remainder.trim_start_matches(|ch: char| ch.is_whitespace() || ch == ',');
        if remainder.is_empty() {
            break;
        }

        let Some(eq_index) = remainder.find("=(") else {
            break;
        };
        let key = remainder[..eq_index].trim();
        let typed_value = &remainder[eq_index + 2..];
        let Some(type_end) = typed_value.find(')') else {
            break;
        };
        let value_start = type_end + 1;
        let value_remainder = &typed_value[value_start..];
        let Some((value_end, delimiter)) = find_property_value_end(value_remainder) else {
            properties.insert(key.to_string(), value_remainder.trim().to_string());
            break;
        };

        properties.insert(
            key.to_string(),
            value_remainder[..value_end].trim().to_string(),
        );
        remainder = match delimiter {
            ';' | ',' => &value_remainder[value_end + 1..],
            _ => "",
        };
    }

    properties
}

fn find_property_value_end(value: &str) -> Option<(usize, char)> {
    let mut escaped = false;

    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == ',' || ch == ';' {
            return Some((index, ch));
        }
    }

    None
}

fn extract_node_string_property(node: Node<'_, '_>, key: &str) -> Option<String> {
    parse_property_string(node.attribute("properties").unwrap_or_default())
        .get(key)
        .cloned()
        .filter(|value| !value.is_empty())
}

fn normalize_caps_string(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut chars = value.trim().trim_matches('"').chars();

    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                normalized.push(next);
            }
        } else {
            normalized.push(ch);
        }
    }

    normalized
}

fn extract_caps_u32(caps: &str, field: &str) -> Option<u32> {
    let marker = format!("{field}=(int)");
    let start = caps.find(&marker)? + marker.len();
    let remainder = &caps[start..];
    let end = remainder.find(',').unwrap_or(remainder.len());
    remainder[..end].trim().parse::<u32>().ok()
}

fn extract_caps_fraction(caps: &str, field: &str) -> Option<f64> {
    let marker = format!("{field}=(fraction)");
    let start = caps.find(&marker)? + marker.len();
    let remainder = &caps[start..];
    let end = remainder.find(',').unwrap_or(remainder.len());
    let value = remainder[..end].trim();
    let (numerator, denominator) = value.split_once('/')?;
    let numerator = numerator.trim().parse::<f64>().ok()?;
    let denominator = denominator
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| *value > 0.0)?;
    Some(numerator / denominator)
}

fn uri_to_local_path(uri: &str) -> Option<String> {
    let parsed = Url::parse(uri).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }

    parsed
        .to_file_path()
        .ok()
        .map(|path| portable_path_string(&path))
}

fn derive_asset_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn make_asset_id(asset_uri: &str) -> String {
    let digest = Sha256::digest(asset_uri.as_bytes());
    let suffix = hex::encode(&digest[..8]);
    format!("xges-asset-{suffix}")
}

fn ns_to_ms(value: u64) -> f64 {
    value as f64 / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn unique_temp_dir(case_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("opendirector-xges-{case_name}-{unique}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn fps_fraction_normalizes_common_rates() {
        assert_eq!(fps_fraction(30.0), "30/1");
        assert_eq!(fps_fraction(29.97), "2997/100");
        assert_eq!(fps_fraction(23.976), "2997/125");
    }

    #[test]
    fn build_layer_map_matches_ui_track_order() {
        let tracks = vec![
            XgesTimelineTrack {
                id: "video-bottom".to_string(),
                track_type: XgesTrackType::Video,
                muted: false,
                order: 0,
            },
            XgesTimelineTrack {
                id: "video-top".to_string(),
                track_type: XgesTrackType::Video,
                muted: false,
                order: 2,
            },
            XgesTimelineTrack {
                id: "audio-main".to_string(),
                track_type: XgesTrackType::Audio,
                muted: false,
                order: 0,
            },
            XgesTimelineTrack {
                id: "audio-secondary".to_string(),
                track_type: XgesTrackType::Audio,
                muted: false,
                order: 1,
            },
        ];

        let layers = build_layer_map(&tracks);
        assert_eq!(layers.get("video-top"), Some(&0));
        assert_eq!(layers.get("video-bottom"), Some(&1));
        assert_eq!(layers.get("audio-main"), Some(&0));
        assert_eq!(layers.get("audio-secondary"), Some(&1));
    }

    #[test]
    fn build_save_args_emits_tracks_and_clip_properties() {
        let request = XgesTimelineExportRequest {
            project_name: Some("Demo".to_string()),
            width: 1920,
            height: 1080,
            fps: 30.0,
            tracks: vec![
                XgesTimelineTrack {
                    id: "video-top".to_string(),
                    track_type: XgesTrackType::Video,
                    muted: false,
                    order: 1,
                },
                XgesTimelineTrack {
                    id: "audio-main".to_string(),
                    track_type: XgesTrackType::Audio,
                    muted: true,
                    order: 0,
                },
            ],
            clips: vec![
                XgesTimelineClip {
                    id: "clip-a".to_string(),
                    track_id: "video-top".to_string(),
                    input_path: env!("CARGO_MANIFEST_DIR").to_string(),
                    name: Some("Hero Clip".to_string()),
                    start_ms: 1000.0,
                    duration_ms: 750.0,
                    trim_start_ms: Some(250.0),
                    mute: None,
                    crop: None,
                },
                XgesTimelineClip {
                    id: "clip-b".to_string(),
                    track_id: "audio-main".to_string(),
                    input_path: env!("CARGO_MANIFEST_DIR").to_string(),
                    name: Some("Audio".to_string()),
                    start_ms: 0.0,
                    duration_ms: 500.0,
                    trim_start_ms: None,
                    mute: None,
                    crop: None,
                },
            ],
        };

        let output_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-save.xges");
        let args = build_save_args(&request, &output_path).expect("args should build");

        assert!(args.iter().any(|arg| arg == "--no-interactive"));
        assert!(args.iter().any(|arg| arg.contains("--save-only=")));
        assert!(args.iter().any(|arg| arg == "video"));
        assert!(args.iter().any(|arg| arg == "audio"));
        assert!(args.iter().any(|arg| arg == "track-types=video"));
        assert!(args.iter().any(|arg| arg == "track-types=audio"));
        assert!(args.iter().any(|arg| arg == "layer=0"));
        assert!(args.iter().any(|arg| arg == "start=1.000000"));
        assert!(args.iter().any(|arg| arg == "duration=0.750000"));
        assert!(args.iter().any(|arg| arg == "inpoint=0.250000"));
        assert!(args.iter().any(|arg| arg == "set-volume"));
    }

    #[test]
    fn parse_xges_project_builds_importable_timeline() {
        let xges = r#"
            <ges version='0.7'>
              <project properties='properties, name=(string)Import Demo;' metadatas='metadatas;'>
                <ressources>
                  <asset id='file:///C:/media/hero.png' extractable-type-name='GESUriClip' properties='properties, supported-formats=(int)4;' metadatas='metadatas;'>
                    <stream-info extractable-type-name='GESVideoUriSource' properties='properties, track-type=(int)4;' metadatas='metadatas;' caps='image/png, width=(int)512, height=(int)512'/>
                  </asset>
                  <asset id='file:///C:/media/voice.wav' extractable-type-name='GESUriClip' properties='properties, supported-formats=(int)2, duration=(guint64)2000000000;' metadatas='metadatas;'>
                    <stream-info extractable-type-name='GESAudioUriSource' properties='properties, track-type=(int)2;' metadatas='metadatas;' caps='audio/x-wav'/>
                  </asset>
                </ressources>
                <timeline properties='properties, auto-transition=(boolean)true;' metadatas='metadatas, duration=(guint64)2000000000;'>
                  <track caps='video/x-raw(ANY)' track-type='4' track-id='0' properties='properties, restriction-caps=(string)&quot;video/x-raw\,\ width\=\(int\)1920\,\ height\=\(int\)1080\,\ framerate\=\(fraction\)30000/1001&quot;;' metadatas='metadatas;'/>
                  <track caps='audio/x-raw(ANY)' track-type='2' track-id='1' properties='properties, restriction-caps=(string)&quot;audio/x-raw\,\ channels\=\(int\)2\,\ rate\=\(int\)44100&quot;;' metadatas='metadatas;'/>
                  <layer priority='0' properties='properties, auto-transition=(boolean)true;' metadatas='metadatas;'>
                    <clip id='0' asset-id='file:///C:/media/hero.png' type-name='GESUriClip' layer-priority='0' track-types='4' start='0' duration='1000000000' inpoint='0' rate='0' properties='properties, name=(string)Hero;' metadatas='metadatas;'>
                      <effect asset-id='videocrop' clip-id='0' type-name='GESEffect' track-type='4' track-id='0' properties='properties, track-type=(int)4;' metadatas='metadatas;' children-properties='properties, GstVideoCrop::bottom=(int)40, GstVideoCrop::left=(int)10, GstVideoCrop::right=(int)20, GstVideoCrop::top=(int)30;'>
                      </effect>
                      <source track-id='0' properties='properties, track-type=(int)4;' metadatas='metadatas;' children-properties='properties;'>
                      </source>
                    </clip>
                  </layer>
                  <layer priority='1' properties='properties, auto-transition=(boolean)true;' metadatas='metadatas;'>
                    <clip id='1' asset-id='file:///C:/media/hero.png' type-name='GESUriClip' layer-priority='1' track-types='4' start='500000000' duration='1000000000' inpoint='250000000' rate='0' properties='properties, name=(string)Overlay;' metadatas='metadatas;'>
                      <source track-id='0' properties='properties, track-type=(int)4;' metadatas='metadatas;' children-properties='properties;'>
                      </source>
                    </clip>
                    <clip id='2' asset-id='file:///C:/media/voice.wav' type-name='GESUriClip' layer-priority='1' track-types='2' start='0' duration='2000000000' inpoint='0' rate='0' properties='properties, name=(string)Voice;' metadatas='metadatas;'>
                      <source track-id='1' properties='properties, track-type=(int)2;' metadatas='metadatas;' children-properties='properties, GstVolume::mute=(boolean)false, GstVolume::volume=(double)1;'>
                      </source>
                    </clip>
                  </layer>
                </timeline>
              </project>
            </ges>
        "#;

        let parsed = parse_xges_project(xges).expect("xges should parse");

        assert_eq!(parsed.project_name, "Import Demo");
        assert_eq!(parsed.width, 1920);
        assert_eq!(parsed.height, 1080);
        assert!((parsed.fps - 29.97002997002997).abs() < 0.0001);
        assert_eq!(parsed.assets.len(), 2);
        assert_eq!(parsed.tracks.len(), 3);
        assert_eq!(parsed.total_duration, 2000.0);

        let top_video_track = parsed
            .tracks
            .iter()
            .find(|track| track.track_type == XgesTrackType::Video && track.order == 1)
            .expect("top video track");
        assert!(!top_video_track.muted);
        assert_eq!(top_video_track.fragments.len(), 1);
        assert_eq!(top_video_track.fragments[0].name, "Hero");
        let crop = top_video_track.fragments[0]
            .crop
            .as_ref()
            .expect("video crop should import");
        assert!((crop.x - (10.0 / 512.0)).abs() < 0.0001);
        assert!((crop.y - (30.0 / 512.0)).abs() < 0.0001);

        let bottom_video_track = parsed
            .tracks
            .iter()
            .find(|track| track.track_type == XgesTrackType::Video && track.order == 0)
            .expect("bottom video track");
        assert!(!bottom_video_track.muted);
        assert_eq!(bottom_video_track.fragments[0].trim_start, Some(250.0));

        let audio_track = parsed
            .tracks
            .iter()
            .find(|track| track.track_type == XgesTrackType::Audio)
            .expect("audio track");
        assert!(!audio_track.muted);
        assert_eq!(audio_track.order, 0);
        assert_eq!(audio_track.fragments[0].duration, 2000.0);
        assert_eq!(parsed.warnings.len(), 0);
    }

    #[test]
    fn parse_xges_project_preserves_track_mute_and_warns_on_partial_clip_mute() {
        let xges = r#"
            <ges version='0.7'>
              <project properties='properties, name=(string)Mute Demo;' metadatas='metadatas;'>
                <ressources>
                  <asset id='file:///C:/media/voice.wav' extractable-type-name='GESUriClip' properties='properties, supported-formats=(int)2, duration=(guint64)2000000000;' metadatas='metadatas;'>
                    <stream-info extractable-type-name='GESAudioUriSource' properties='properties, track-type=(int)2;' metadatas='metadatas;' caps='audio/x-wav'/>
                  </asset>
                </ressources>
                <timeline>
                  <track caps='audio/x-raw(ANY)' track-type='2' track-id='1' properties='properties;' metadatas='metadatas;'/>
                  <layer priority='0'>
                    <clip id='0' asset-id='file:///C:/media/voice.wav' type-name='GESUriClip' layer-priority='0' track-types='2' start='0' duration='1000000000' inpoint='0' rate='0' properties='properties, name=(string)Muted A;' metadatas='metadatas;'>
                      <source track-id='1' properties='properties, track-type=(int)2;' metadatas='metadatas;' children-properties='properties, GstVolume::mute=(boolean)true, GstVolume::volume=(double)0;'>
                      </source>
                    </clip>
                    <clip id='1' asset-id='file:///C:/media/voice.wav' type-name='GESUriClip' layer-priority='0' track-types='2' start='1000000000' duration='1000000000' inpoint='0' rate='0' properties='properties, name=(string)Muted B;' metadatas='metadatas;'>
                      <source track-id='1' properties='properties, track-type=(int)2;' metadatas='metadatas;' children-properties='properties, GstVolume::mute=(boolean)true, GstVolume::volume=(double)0;'>
                      </source>
                    </clip>
                  </layer>
                  <layer priority='1'>
                    <clip id='2' asset-id='file:///C:/media/voice.wav' type-name='GESUriClip' layer-priority='1' track-types='2' start='0' duration='1000000000' inpoint='0' rate='0' properties='properties, name=(string)Muted Partial;' metadatas='metadatas;'>
                      <source track-id='1' properties='properties, track-type=(int)2;' metadatas='metadatas;' children-properties='properties, GstVolume::mute=(boolean)true, GstVolume::volume=(double)0;'>
                      </source>
                    </clip>
                    <clip id='3' asset-id='file:///C:/media/voice.wav' type-name='GESUriClip' layer-priority='1' track-types='2' start='1000000000' duration='1000000000' inpoint='0' rate='0' properties='properties, name=(string)Audible Partial;' metadatas='metadatas;'>
                      <source track-id='1' properties='properties, track-type=(int)2;' metadatas='metadatas;' children-properties='properties, GstVolume::mute=(boolean)false, GstVolume::volume=(double)1;'>
                      </source>
                    </clip>
                  </layer>
                </timeline>
              </project>
            </ges>
        "#;

        let parsed = parse_xges_project(xges).expect("xges should parse");

        let fully_muted_track = parsed
            .tracks
            .iter()
            .find(|track| track.track_type == XgesTrackType::Audio && track.order == 0)
            .expect("fully muted audio track");
        assert!(fully_muted_track.muted);

        let partially_muted_track = parsed
            .tracks
            .iter()
            .find(|track| track.track_type == XgesTrackType::Audio && track.order == 1)
            .expect("partially muted audio track");
        assert!(!partially_muted_track.muted);

        assert_eq!(parsed.warnings.len(), 1);
        assert_eq!(parsed.warnings[0].code, "unsupported_partial_audio_mute");
    }

    #[test]
    fn parse_xges_project_reports_unsupported_and_missing_features() {
        let xges = r#"
            <ges version='0.7'>
              <project properties='properties, name=(string)Warning Demo;' metadatas='metadatas;'>
                <ressources>
                  <asset id='https://example.com/hero.mp4' extractable-type-name='GESUriClip' properties='properties, supported-formats=(int)4, duration=(guint64)1000000000;' metadatas='metadatas;'>
                    <stream-info extractable-type-name='GESVideoUriSource' properties='properties, track-type=(int)4;' metadatas='metadatas;' caps='video/x-h264, width=(int)1280, height=(int)720'/>
                  </asset>
                </ressources>
                <timeline>
                  <track caps='video/x-raw(ANY)' track-type='4' track-id='0' properties='properties, restriction-caps=(string)video/x-raw,width=(int)1280,height=(int)720,framerate=(fraction)30/1;' metadatas='metadatas;'/>
                  <layer priority='0'>
                    <clip id='0' asset-id='https://example.com/hero.mp4' type-name='GESUriClip' layer-priority='0' track-types='4' start='0' duration='1000000000' inpoint='0' rate='0' properties='properties, name=(string)Effect Clip;' metadatas='metadatas;'>
                      <effect asset-id='agingtv' clip-id='0' type-name='GESEffect' track-type='4' track-id='0' properties='properties;' metadatas='metadatas;' children-properties='properties, scratch-lines=(uint)7;'/>
                    </clip>
                  </layer>
                  <layer priority='1'>
                    <clip id='1' asset-id='file:///C:/media/missing.wav' type-name='GESUriClip' layer-priority='1' track-types='2' start='0' duration='500000000' inpoint='0' rate='0' properties='properties, name=(string)Missing Asset;' metadatas='metadatas;'/>
                  </layer>
                  <layer priority='2'>
                    <clip id='2' asset-id='file:///C:/media/unknown.bin' type-name='GESUriClip' layer-priority='2' track-types='abc' start='0' duration='500000000' inpoint='0' rate='0' properties='properties, name=(string)Unknown Type;' metadatas='metadatas;'/>
                  </layer>
                  <layer priority='3'>
                    <clip id='3' asset-id='file:///C:/media/zero.wav' type-name='GESUriClip' layer-priority='3' track-types='2' start='0' duration='0' inpoint='0' rate='0' properties='properties, name=(string)Zero Duration;' metadatas='metadatas;'/>
                  </layer>
                </timeline>
              </project>
            </ges>
        "#;

        let parsed = parse_xges_project(xges).expect("xges should parse");
        let warning_codes: Vec<_> = parsed
            .warnings
            .iter()
            .map(|warning| warning.code.as_str())
            .collect();

        assert!(warning_codes.contains(&"non_file_asset_uri"));
        assert!(warning_codes.contains(&"unsupported_clip_effect"));
        assert!(warning_codes.contains(&"missing_asset_reference"));
        assert!(warning_codes.contains(&"unknown_clip_track_type"));
        assert!(warning_codes.contains(&"non_positive_clip_duration"));

        assert_eq!(parsed.assets.len(), 1);
        assert_eq!(parsed.assets[0].local_path, "https://example.com/hero.mp4");
        assert_eq!(parsed.tracks.len(), 2);
    }

    #[test]
    #[ignore = "requires a local GStreamer runtime"]
    fn exported_xges_round_trips_through_parser() {
        let case_dir = unique_temp_dir("round-trip");
        let output_path = case_dir.join("timeline.xges");
        let image_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join("icon.png");

        let request = XgesTimelineExportRequest {
            project_name: Some("Round Trip Demo".to_string()),
            width: 1280,
            height: 720,
            fps: 25.0,
            tracks: vec![
                XgesTimelineTrack {
                    id: "video-bottom".to_string(),
                    track_type: XgesTrackType::Video,
                    muted: false,
                    order: 0,
                },
                XgesTimelineTrack {
                    id: "video-top".to_string(),
                    track_type: XgesTrackType::Video,
                    muted: false,
                    order: 1,
                },
            ],
            clips: vec![
                XgesTimelineClip {
                    id: "clip-bottom".to_string(),
                    track_id: "video-bottom".to_string(),
                    input_path: image_path.to_string_lossy().to_string(),
                    name: Some("Bottom".to_string()),
                    start_ms: 0.0,
                    duration_ms: 1500.0,
                    trim_start_ms: None,
                    mute: None,
                    crop: None,
                },
                XgesTimelineClip {
                    id: "clip-top".to_string(),
                    track_id: "video-top".to_string(),
                    input_path: image_path.to_string_lossy().to_string(),
                    name: Some("Top".to_string()),
                    start_ms: 500.0,
                    duration_ms: 1000.0,
                    trim_start_ms: None,
                    mute: None,
                    crop: None,
                },
            ],
        };

        export_timeline_to_xges(&request, &output_path).expect("xges should export");
        let contents = fs::read_to_string(&output_path).expect("xges output should exist");
        let parsed = parse_xges_project(&contents).expect("generated xges should parse");

        assert_eq!(parsed.project_name, "Round Trip Demo");
        assert_eq!(parsed.width, 1280);
        assert_eq!(parsed.height, 720);
        assert!((parsed.fps - 25.0).abs() < 0.0001);
        assert_eq!(parsed.assets.len(), 1);
        assert_eq!(parsed.tracks.len(), 2);

        let top_track = parsed
            .tracks
            .iter()
            .find(|track| track.track_type == XgesTrackType::Video && track.order == 1)
            .expect("top track");
        let bottom_track = parsed
            .tracks
            .iter()
            .find(|track| track.track_type == XgesTrackType::Video && track.order == 0)
            .expect("bottom track");

        assert_eq!(top_track.fragments.len(), 1);
        assert_eq!(top_track.fragments[0].name, "Top");
        assert_eq!(top_track.fragments[0].start, 500.0);
        assert_eq!(top_track.fragments[0].duration, 1000.0);

        assert_eq!(bottom_track.fragments.len(), 1);
        assert_eq!(bottom_track.fragments[0].name, "Bottom");
        assert_eq!(bottom_track.fragments[0].start, 0.0);
        assert_eq!(bottom_track.fragments[0].duration, 1500.0);
    }
}
