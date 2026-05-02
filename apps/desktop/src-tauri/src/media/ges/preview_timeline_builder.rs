#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use super::super::error::MediaResult;
use super::super::model::{
    TimelinePreviewFragment, TimelinePreviewSnapshot, TimelinePreviewTrack, TimelineTrackType,
};
use super::args::{fps_fraction, sanitize_clip_token};
use super::clip_modifiers::{
    build_cli_modifier_args, resolve_clip_modifier_plan, GesClipModifierPlan, ResolvedCrop,
    ResolvedTransform,
};
use crate::media::gstreamer::command::{canonicalize_media_path, file_uri};

#[derive(Debug, Clone)]
pub struct GesPreviewTimeline {
    pub duration_ms: f64,
    pub fps: f64,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub has_video: bool,
    pub has_audio: bool,
    pub tracks: Vec<GesPreviewTrackPlan>,
    pub clips: Vec<GesPreviewClipPlan>,
}

#[derive(Debug, Clone)]
pub struct GesPreviewTrackPlan {
    pub id: String,
    pub track_type: TimelineTrackType,
    pub muted: bool,
    pub order: i32,
    pub layer: usize,
}

#[derive(Debug, Clone)]
pub struct GesPreviewClipPlan {
    pub id: String,
    pub track_id: String,
    pub track_type: TimelineTrackType,
    pub uri: String,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub inpoint_ms: f64,
    pub layer: usize,
    pub visible: bool,
    pub volume: f64,
    pub crop: Option<ResolvedCrop>,
    pub transform: Option<ResolvedTransform>,
}

pub fn build_preview_timeline(
    snapshot: &TimelinePreviewSnapshot,
) -> MediaResult<GesPreviewTimeline> {
    let track_by_id = validate_snapshot(snapshot)?;
    let layer_by_track_id = build_preview_layer_map(&snapshot.tracks);

    let mut tracks = snapshot
        .tracks
        .iter()
        .map(|track| GesPreviewTrackPlan {
            id: track.id.clone(),
            track_type: track.track_type.clone(),
            muted: track.muted,
            order: track.order,
            layer: layer_by_track_id
                .get(track.id.as_str())
                .copied()
                .unwrap_or(0),
        })
        .collect::<Vec<_>>();
    tracks.sort_by(|left, right| {
        left.track_type
            .discriminant_order()
            .cmp(&right.track_type.discriminant_order())
            .then_with(|| left.layer.cmp(&right.layer))
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut fragments = snapshot.fragments.clone();
    fragments.sort_by(|left, right| {
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

    let clips = fragments
        .iter()
        .map(|fragment| {
            let track = track_by_id.get(fragment.track_id.as_str()).ok_or_else(|| {
                format!(
                    "timeline preview fragment {} references unknown track {}",
                    fragment.id, fragment.track_id
                )
            })?;

            build_clip_plan(
                track,
                fragment,
                layer_by_track_id[fragment.track_id.as_str()],
            )
        })
        .collect::<MediaResult<Vec<_>>>()?;

    Ok(GesPreviewTimeline {
        duration_ms: snapshot.duration_ms.max(0.0),
        fps: snapshot.fps,
        canvas_width: snapshot.canvas_width,
        canvas_height: snapshot.canvas_height,
        has_video: snapshot
            .tracks
            .iter()
            .any(|track| track.track_type == TimelineTrackType::Video),
        has_audio: snapshot
            .tracks
            .iter()
            .any(|track| track.track_type == TimelineTrackType::Audio),
        tracks,
        clips,
    })
}

pub fn build_preview_launch_args(timeline: &GesPreviewTimeline) -> Vec<String> {
    build_preview_launch_args_at_position(timeline, 0.0)
}

pub fn build_preview_launch_args_at_position(
    timeline: &GesPreviewTimeline,
    position_ms: f64,
) -> Vec<String> {
    let mut args = Vec::new();
    let position_ms = position_ms.clamp(0.0, timeline.duration_ms.max(0.0));

    if timeline.has_video {
        args.extend([
            "+track".to_string(),
            "video".to_string(),
            format!(
                "restrictions=video/x-raw,width={},height={},framerate={},pixel-aspect-ratio=1/1",
                timeline.canvas_width,
                timeline.canvas_height,
                fps_fraction(timeline.fps)
            ),
        ]);
    }

    if timeline.has_audio {
        args.extend([
            "+track".to_string(),
            "audio".to_string(),
            "restrictions=audio/x-raw,channels=2,rate=44100,layout=interleaved".to_string(),
        ]);
    }

    for clip in &timeline.clips {
        let Some(clip) = slice_clip_for_position(clip, position_ms) else {
            continue;
        };

        if clip.track_type == TimelineTrackType::Video && !clip.visible {
            continue;
        }

        args.extend([
            "+clip".to_string(),
            clip.uri.clone(),
            format!("name={}", sanitize_clip_token(&clip.id)),
            format!("layer={}", clip.layer),
            format!("start={:.6}", clip.start_ms / 1000.0),
            format!("duration={:.6}", clip.duration_ms / 1000.0),
            format!(
                "track-types={}",
                match clip.track_type {
                    TimelineTrackType::Video => "video",
                    TimelineTrackType::Audio => "audio",
                }
            ),
        ]);

        if clip.inpoint_ms > 0.0 {
            args.push(format!("inpoint={:.6}", clip.inpoint_ms / 1000.0));
        }

        args.extend(build_cli_modifier_args(&GesClipModifierPlan {
            clip_id: clip.id.clone(),
            track_type: clip.track_type.clone(),
            volume: clip.volume,
            crop: clip.crop.clone(),
            transform: clip.transform.clone(),
        }));
    }

    args
}

fn slice_clip_for_position(
    clip: &GesPreviewClipPlan,
    position_ms: f64,
) -> Option<GesPreviewClipPlan> {
    let clip_end_ms = clip.start_ms + clip.duration_ms;
    if clip_end_ms <= position_ms {
        return None;
    }

    let skipped_ms = (position_ms - clip.start_ms).max(0.0);
    let remaining_duration_ms = (clip.duration_ms - skipped_ms).max(0.0);
    if remaining_duration_ms <= 0.0 {
        return None;
    }

    Some(GesPreviewClipPlan {
        id: clip.id.clone(),
        track_id: clip.track_id.clone(),
        track_type: clip.track_type.clone(),
        uri: clip.uri.clone(),
        start_ms: (clip.start_ms - position_ms).max(0.0),
        duration_ms: remaining_duration_ms,
        inpoint_ms: clip.inpoint_ms + skipped_ms,
        layer: clip.layer,
        visible: clip.visible,
        volume: clip.volume,
        crop: clip.crop.clone(),
        transform: clip.transform.clone(),
    })
}

fn validate_snapshot(
    snapshot: &TimelinePreviewSnapshot,
) -> MediaResult<HashMap<&str, &TimelinePreviewTrack>> {
    if snapshot.project_path.trim().is_empty() {
        return Err("timeline preview requires a project path".to_string());
    }

    if snapshot.canvas_width == 0 || snapshot.canvas_height == 0 {
        return Err("timeline preview requires a positive canvas size".to_string());
    }

    if !snapshot.fps.is_finite() || snapshot.fps <= 0.0 {
        return Err("timeline preview requires a positive fps value".to_string());
    }

    if !snapshot.duration_ms.is_finite() || snapshot.duration_ms < 0.0 {
        return Err("timeline preview requires a finite non-negative duration".to_string());
    }

    if snapshot.tracks.is_empty() {
        return Err("timeline preview requires at least one track".to_string());
    }

    let mut track_ids = HashSet::new();
    for track in &snapshot.tracks {
        if track.id.trim().is_empty() {
            return Err("timeline preview track id cannot be empty".to_string());
        }
        if !track_ids.insert(track.id.as_str()) {
            return Err(format!(
                "timeline preview contains duplicate track {}",
                track.id
            ));
        }
    }

    let track_by_id: HashMap<&str, &TimelinePreviewTrack> = snapshot
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track))
        .collect();
    let mut clip_ids = HashSet::new();
    let mut max_end_ms = 0.0f64;

    for fragment in &snapshot.fragments {
        if fragment.id.trim().is_empty() {
            return Err("timeline preview fragment id cannot be empty".to_string());
        }
        if !clip_ids.insert(fragment.id.as_str()) {
            return Err(format!(
                "timeline preview contains duplicate fragment {}",
                fragment.id
            ));
        }
        if fragment.duration_ms <= 0.0 || !fragment.duration_ms.is_finite() {
            return Err(format!(
                "timeline preview fragment {} has a non-positive duration",
                fragment.id
            ));
        }
        if !fragment.start_ms.is_finite() || fragment.start_ms < 0.0 {
            return Err(format!(
                "timeline preview fragment {} has an invalid start time",
                fragment.id
            ));
        }
        if !fragment.trim_start_ms.is_finite() || fragment.trim_start_ms < 0.0 {
            return Err(format!(
                "timeline preview fragment {} has an invalid trim start",
                fragment.id
            ));
        }
        if let Some(volume) = fragment.volume {
            if !volume.is_finite() || volume < 0.0 {
                return Err(format!(
                    "timeline preview fragment {} has an invalid volume",
                    fragment.id
                ));
            }
        }

        let _track = track_by_id.get(fragment.track_id.as_str()).ok_or_else(|| {
            format!(
                "timeline preview fragment {} references unknown track {}",
                fragment.id, fragment.track_id
            )
        })?;

        max_end_ms = max_end_ms.max(fragment.start_ms + fragment.duration_ms);
    }

    if max_end_ms > snapshot.duration_ms + 0.001 {
        return Err(format!(
            "timeline preview duration {:.3}ms is shorter than fragment coverage {:.3}ms",
            snapshot.duration_ms, max_end_ms
        ));
    }

    Ok(track_by_id)
}

fn build_preview_layer_map(tracks: &[TimelinePreviewTrack]) -> HashMap<&str, usize> {
    let mut map = HashMap::new();

    let mut video_tracks: Vec<&TimelinePreviewTrack> = tracks
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

    let mut audio_tracks: Vec<&TimelinePreviewTrack> = tracks
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

fn build_clip_plan(
    track: &TimelinePreviewTrack,
    fragment: &TimelinePreviewFragment,
    layer: usize,
) -> MediaResult<GesPreviewClipPlan> {
    let input_path = canonicalize_media_path(&fragment.absolute_path)?;
    let visible =
        !(track.track_type == TimelineTrackType::Video && (track.muted || fragment.muted));
    let volume = if track.track_type == TimelineTrackType::Audio {
        if track.muted || fragment.muted {
            0.0
        } else {
            fragment.volume.unwrap_or(1.0)
        }
    } else {
        1.0
    };
    let modifier_plan = resolve_clip_modifier_plan(
        fragment.id.clone(),
        track.track_type.clone(),
        &fragment.absolute_path,
        volume,
        fragment.crop.as_ref(),
        fragment.transform.as_ref(),
    )?;

    Ok(GesPreviewClipPlan {
        id: fragment.id.clone(),
        track_id: fragment.track_id.clone(),
        track_type: track.track_type.clone(),
        uri: file_uri(&input_path),
        start_ms: fragment.start_ms,
        duration_ms: fragment.duration_ms,
        inpoint_ms: fragment.trim_start_ms,
        layer,
        visible,
        volume,
        crop: modifier_plan.crop,
        transform: modifier_plan.transform,
    })
}

trait TimelineTrackTypeSortKey {
    fn discriminant_order(&self) -> u8;
}

impl TimelineTrackTypeSortKey for TimelineTrackType {
    fn discriminant_order(&self) -> u8 {
        match self {
            TimelineTrackType::Video => 0,
            TimelineTrackType::Audio => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::media::model::PreviewTransform;

    fn temp_case_dir(case_name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_millis();
        let dir = std::env::temp_dir().join(format!("genline-preview-{case_name}-{suffix}"));
        fs::create_dir_all(&dir).expect("failed to create temp case dir");
        dir
    }

    fn write_temp_media(path: &PathBuf) {
        fs::write(path, b"preview").expect("failed to write temp media");
    }

    #[test]
    fn build_preview_timeline_prepares_layers_and_clip_state() {
        let case_dir = temp_case_dir("builder");
        let video_path = case_dir.join("clip.mp4");
        let audio_path = case_dir.join("clip.wav");
        write_temp_media(&video_path);
        write_temp_media(&audio_path);

        let timeline = build_preview_timeline(&TimelinePreviewSnapshot {
            project_path: case_dir.to_string_lossy().to_string(),
            duration_ms: 2_500.0,
            fps: 25.0,
            canvas_width: 1280,
            canvas_height: 720,
            tracks: vec![
                TimelinePreviewTrack {
                    id: "video-top".to_string(),
                    track_type: TimelineTrackType::Video,
                    muted: false,
                    order: 2,
                },
                TimelinePreviewTrack {
                    id: "video-bottom".to_string(),
                    track_type: TimelineTrackType::Video,
                    muted: true,
                    order: 0,
                },
                TimelinePreviewTrack {
                    id: "audio-main".to_string(),
                    track_type: TimelineTrackType::Audio,
                    muted: false,
                    order: 0,
                },
            ],
            fragments: vec![
                TimelinePreviewFragment {
                    id: "audio-1".to_string(),
                    track_id: "audio-main".to_string(),
                    absolute_path: audio_path.to_string_lossy().to_string(),
                    start_ms: 0.0,
                    duration_ms: 2_000.0,
                    trim_start_ms: 0.0,
                    muted: false,
                    volume: Some(0.25),
                    crop: None,
                    transform: None,
                },
                TimelinePreviewFragment {
                    id: "video-hidden".to_string(),
                    track_id: "video-bottom".to_string(),
                    absolute_path: video_path.to_string_lossy().to_string(),
                    start_ms: 0.0,
                    duration_ms: 2_500.0,
                    trim_start_ms: 0.0,
                    muted: true,
                    volume: None,
                    crop: None,
                    transform: None,
                },
                TimelinePreviewFragment {
                    id: "video-visible".to_string(),
                    track_id: "video-top".to_string(),
                    absolute_path: video_path.to_string_lossy().to_string(),
                    start_ms: 500.0,
                    duration_ms: 1_500.0,
                    trim_start_ms: 250.0,
                    muted: false,
                    volume: None,
                    crop: None,
                    transform: Some(PreviewTransform {
                        x: Some(12.0),
                        y: None,
                        scale_x: Some(0.8),
                        scale_y: None,
                        rotation_deg: None,
                        opacity: Some(0.9),
                    }),
                },
            ],
        })
        .expect("timeline should build");

        assert_eq!(timeline.tracks.len(), 3);
        assert_eq!(timeline.clips.len(), 3);
        assert!(timeline.has_video);
        assert!(timeline.has_audio);
        assert_eq!(timeline.tracks[0].id, "video-top");
        assert_eq!(timeline.tracks[0].layer, 0);
        assert_eq!(timeline.tracks[1].id, "video-bottom");
        assert_eq!(timeline.tracks[1].layer, 1);
        assert_eq!(timeline.tracks[2].id, "audio-main");

        let hidden_video = timeline
            .clips
            .iter()
            .find(|clip| clip.id == "video-hidden")
            .expect("hidden video clip");
        assert!(!hidden_video.visible);
        assert_eq!(hidden_video.layer, 1);
        assert_eq!(hidden_video.track_id, "video-bottom");
        assert!(hidden_video.uri.starts_with("file://"));

        let audio_clip = timeline
            .clips
            .iter()
            .find(|clip| clip.id == "audio-1")
            .expect("audio clip");
        assert_eq!(audio_clip.volume, 0.25);
        assert_eq!(audio_clip.layer, 0);

        let video_clip = timeline
            .clips
            .iter()
            .find(|clip| clip.id == "video-visible")
            .expect("video clip");
        assert!(video_clip.visible);
        assert_eq!(video_clip.inpoint_ms, 250.0);
        assert!(video_clip.transform.is_some());
    }

    #[test]
    fn build_preview_timeline_rejects_duration_underflow() {
        let case_dir = temp_case_dir("duration");
        let video_path = case_dir.join("clip.mp4");
        write_temp_media(&video_path);

        let error = build_preview_timeline(&TimelinePreviewSnapshot {
            project_path: case_dir.to_string_lossy().to_string(),
            duration_ms: 500.0,
            fps: 30.0,
            canvas_width: 1920,
            canvas_height: 1080,
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
                start_ms: 250.0,
                duration_ms: 750.0,
                trim_start_ms: 0.0,
                muted: false,
                volume: None,
                crop: None,
                transform: None,
            }],
        })
        .expect_err("builder should reject invalid duration");

        assert!(error.contains("shorter than fragment coverage"));
    }

    #[test]
    fn build_preview_launch_args_omits_hidden_video_and_applies_audio_volume() {
        let timeline = GesPreviewTimeline {
            duration_ms: 1_500.0,
            fps: 24.0,
            canvas_width: 1920,
            canvas_height: 1080,
            has_video: true,
            has_audio: true,
            tracks: vec![],
            clips: vec![
                GesPreviewClipPlan {
                    id: "video-hidden".to_string(),
                    track_id: "video-main".to_string(),
                    track_type: TimelineTrackType::Video,
                    uri: "file:///video-hidden.mp4".to_string(),
                    start_ms: 0.0,
                    duration_ms: 1000.0,
                    inpoint_ms: 0.0,
                    layer: 0,
                    visible: false,
                    volume: 1.0,
                    crop: None,
                    transform: None,
                },
                GesPreviewClipPlan {
                    id: "audio-main".to_string(),
                    track_id: "audio-main".to_string(),
                    track_type: TimelineTrackType::Audio,
                    uri: "file:///audio-main.wav".to_string(),
                    start_ms: 0.0,
                    duration_ms: 1500.0,
                    inpoint_ms: 125.0,
                    layer: 0,
                    visible: true,
                    volume: 0.5,
                    crop: None,
                    transform: None,
                },
            ],
        };

        let args = build_preview_launch_args(&timeline);

        assert!(args.iter().any(|arg| arg == "+track"));
        assert!(args.iter().any(|arg| arg == "video"));
        assert!(args.iter().any(|arg| arg == "audio"));
        assert!(args.iter().any(|arg| arg == "file:///audio-main.wav"));
        assert!(!args.iter().any(|arg| arg == "file:///video-hidden.mp4"));
        assert!(args.iter().any(|arg| arg == "set-volume"));
        assert!(args.iter().any(|arg| arg == "0.500000"));
        assert!(args.iter().any(|arg| arg == "inpoint=0.125000"));
    }

    #[test]
    fn build_preview_launch_args_at_position_shifts_clip_timing() {
        let timeline = GesPreviewTimeline {
            duration_ms: 3_000.0,
            fps: 30.0,
            canvas_width: 1280,
            canvas_height: 720,
            has_video: true,
            has_audio: false,
            tracks: vec![],
            clips: vec![
                GesPreviewClipPlan {
                    id: "clip-a".to_string(),
                    track_id: "video-main".to_string(),
                    track_type: TimelineTrackType::Video,
                    uri: "file:///clip-a.mp4".to_string(),
                    start_ms: 0.0,
                    duration_ms: 1_000.0,
                    inpoint_ms: 0.0,
                    layer: 0,
                    visible: true,
                    volume: 1.0,
                    crop: None,
                    transform: None,
                },
                GesPreviewClipPlan {
                    id: "clip-b".to_string(),
                    track_id: "video-main".to_string(),
                    track_type: TimelineTrackType::Video,
                    uri: "file:///clip-b.mp4".to_string(),
                    start_ms: 1_500.0,
                    duration_ms: 1_000.0,
                    inpoint_ms: 250.0,
                    layer: 0,
                    visible: true,
                    volume: 1.0,
                    crop: None,
                    transform: None,
                },
            ],
        };

        let args = build_preview_launch_args_at_position(&timeline, 1_750.0);

        assert!(!args.iter().any(|arg| arg == "file:///clip-a.mp4"));
        assert!(args.iter().any(|arg| arg == "file:///clip-b.mp4"));
        assert!(args.iter().any(|arg| arg == "start=0.000000"));
        assert!(args.iter().any(|arg| arg == "duration=0.750000"));
        assert!(args.iter().any(|arg| arg == "inpoint=0.500000"));
    }
}
