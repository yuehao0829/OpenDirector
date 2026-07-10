use super::super::error::MediaResult;
use super::super::model::{
    MediaProbeRequest, PreviewTransform, TimelineRenderCrop, TimelineTrackType,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCrop {
    pub left: u32,
    pub right: u32,
    pub top: u32,
    pub bottom: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedVideoDirection {
    Rotate90Right,
    Rotate180,
    Rotate90Left,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTransform {
    pub posx: Option<i32>,
    pub posy: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub opacity: Option<f64>,
    pub video_direction: Option<ResolvedVideoDirection>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GesClipModifierPlan {
    pub clip_id: String,
    pub track_type: TimelineTrackType,
    pub volume: f64,
    pub crop: Option<ResolvedCrop>,
    pub transform: Option<ResolvedTransform>,
}

pub fn resolve_clip_modifier_plan(
    clip_id: impl Into<String>,
    track_type: TimelineTrackType,
    source_path: &str,
    volume: f64,
    crop: Option<&TimelineRenderCrop>,
    transform: Option<&PreviewTransform>,
) -> MediaResult<GesClipModifierPlan> {
    let (resolved_crop, resolved_transform) =
        resolve_visual_modifiers(track_type.clone(), source_path, crop, transform);

    Ok(GesClipModifierPlan {
        clip_id: clip_id.into(),
        track_type,
        volume,
        crop: resolved_crop,
        transform: resolved_transform,
    })
}

pub fn build_cli_modifier_args(plan: &GesClipModifierPlan) -> Vec<String> {
    let mut args = Vec::new();

    if let Some(crop) = &plan.crop {
        args.extend([
            "+effect".to_string(),
            "videocrop".to_string(),
            "set-left".to_string(),
            crop.left.to_string(),
            "set-right".to_string(),
            crop.right.to_string(),
            "set-top".to_string(),
            crop.top.to_string(),
            "set-bottom".to_string(),
            crop.bottom.to_string(),
        ]);
    }

    if let Some(transform) = &plan.transform {
        if let Some(opacity) = transform.opacity {
            args.extend(["set-alpha".to_string(), format!("{opacity:.6}")]);
        }
        if let Some(posx) = transform.posx {
            args.extend(["set-posx".to_string(), posx.to_string()]);
        }
        if let Some(posy) = transform.posy {
            args.extend(["set-posy".to_string(), posy.to_string()]);
        }
        if let Some(width) = transform.width {
            args.extend(["set-width".to_string(), width.to_string()]);
        }
        if let Some(height) = transform.height {
            args.extend(["set-height".to_string(), height.to_string()]);
        }
        if let Some(video_direction) = transform.video_direction {
            args.extend([
                "set-video-direction".to_string(),
                video_direction.as_cli_value().to_string(),
            ]);
        }
    }

    if plan.track_type == TimelineTrackType::Audio && (plan.volume - 1.0).abs() > 0.000_001 {
        args.extend(["set-volume".to_string(), format!("{:.6}", plan.volume)]);
    }

    args
}

#[cfg(not(test))]
pub fn apply_ges_clip_modifiers(
    ges_clip: &ges::Clip,
    plan: &GesClipModifierPlan,
) -> Result<(), String> {
    use ges::prelude::*;

    if plan.track_type == TimelineTrackType::Audio && (plan.volume - 1.0).abs() > 0.000_001 {
        let effect = ges::Effect::new("volume").map_err(|error| {
            format!(
                "failed to create volume effect for {}: {error}",
                plan.clip_id
            )
        })?;
        ges::prelude::TimelineElementExtManual::set_child_property(&effect, "volume", plan.volume)
            .map_err(|error| {
                format!("failed to set volume effect for {}: {error}", plan.clip_id)
            })?;
        ges_clip.add_top_effect(&effect, 0).map_err(|error| {
            format!(
                "failed to attach volume effect for {}: {error}",
                plan.clip_id
            )
        })?;
    }

    if let Some(crop) = &plan.crop {
        let effect = ges::Effect::new("videocrop").map_err(|error| {
            format!("failed to create crop effect for {}: {error}", plan.clip_id)
        })?;
        ges::prelude::TimelineElementExtManual::set_child_property(
            &effect,
            "left",
            i32::try_from(crop.left).unwrap_or(i32::MAX),
        )
        .map_err(|error| format!("failed to set crop left for {}: {error}", plan.clip_id))?;
        ges::prelude::TimelineElementExtManual::set_child_property(
            &effect,
            "right",
            i32::try_from(crop.right).unwrap_or(i32::MAX),
        )
        .map_err(|error| format!("failed to set crop right for {}: {error}", plan.clip_id))?;
        ges::prelude::TimelineElementExtManual::set_child_property(
            &effect,
            "top",
            i32::try_from(crop.top).unwrap_or(i32::MAX),
        )
        .map_err(|error| format!("failed to set crop top for {}: {error}", plan.clip_id))?;
        ges::prelude::TimelineElementExtManual::set_child_property(
            &effect,
            "bottom",
            i32::try_from(crop.bottom).unwrap_or(i32::MAX),
        )
        .map_err(|error| format!("failed to set crop bottom for {}: {error}", plan.clip_id))?;
        ges_clip.add_top_effect(&effect, 0).map_err(|error| {
            format!("failed to attach crop effect for {}: {error}", plan.clip_id)
        })?;
    }

    if let Some(transform) = &plan.transform {
        if let Some(opacity) = transform.opacity {
            ges::prelude::TimelineElementExtManual::set_child_property(ges_clip, "alpha", opacity)
                .map_err(|error| format!("failed to set alpha for {}: {error}", plan.clip_id))?;
        }
        if let Some(posx) = transform.posx {
            ges::prelude::TimelineElementExtManual::set_child_property(ges_clip, "posx", posx)
                .map_err(|error| format!("failed to set posx for {}: {error}", plan.clip_id))?;
        }
        if let Some(posy) = transform.posy {
            ges::prelude::TimelineElementExtManual::set_child_property(ges_clip, "posy", posy)
                .map_err(|error| format!("failed to set posy for {}: {error}", plan.clip_id))?;
        }
        if let Some(width) = transform.width {
            ges::prelude::TimelineElementExtManual::set_child_property(ges_clip, "width", width)
                .map_err(|error| format!("failed to set width for {}: {error}", plan.clip_id))?;
        }
        if let Some(height) = transform.height {
            ges::prelude::TimelineElementExtManual::set_child_property(ges_clip, "height", height)
                .map_err(|error| format!("failed to set height for {}: {error}", plan.clip_id))?;
        }
        if let Some(video_direction) = transform.video_direction {
            ges::prelude::TimelineElementExtManual::set_child_property(
                ges_clip,
                "video-direction",
                video_direction.as_gst_value(),
            )
            .map_err(|error| {
                format!(
                    "failed to set video direction for {}: {error}",
                    plan.clip_id
                )
            })?;
        }
    }

    Ok(())
}

fn resolve_visual_modifiers(
    track_type: TimelineTrackType,
    source_path: &str,
    crop: Option<&TimelineRenderCrop>,
    transform: Option<&PreviewTransform>,
) -> (Option<ResolvedCrop>, Option<ResolvedTransform>) {
    if track_type != TimelineTrackType::Video {
        return (None, None);
    }

    let dimensions = if crop.is_some() || transform_needs_source_dimensions(transform) {
        probe_source_dimensions(source_path)
    } else {
        None
    };

    (
        crop.and_then(|crop| {
            dimensions.map(|(width, height)| resolve_crop_bounds(crop, width, height))
        }),
        transform.and_then(|transform| resolve_transform(transform, dimensions)),
    )
}

/// Best-effort source-dimension probe for the preview builder.
///
/// Returns `None` when dimensions can't be obtained — whether because the media
/// is unreadable, the probe errored, or GStreamer isn't initialized (e.g. in
/// unit tests, where `gst::init` is never called). The preview degrades the
/// modifier in that case rather than failing the whole build. `catch_unwind`
/// converts the gstreamer crate's "not initialized" assert (a panic, not a
/// `Result`) into a graceful `None`.
fn probe_source_dimensions(source_path: &str) -> Option<(u32, u32)> {
    let metadata = std::panic::catch_unwind(|| {
        crate::media::gstreamer::discoverer::probe_media(&MediaProbeRequest {
            path: source_path.to_string(),
        })
    })
    .ok() // None if GStreamer panicked (not initialized)
    .and_then(|probe_result| probe_result.ok())?; // None if the probe errored

    match (metadata.width, metadata.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Some((width, height)),
        _ => None,
    }
}

fn transform_needs_source_dimensions(transform: Option<&PreviewTransform>) -> bool {
    let Some(transform) = transform else {
        return false;
    };

    scale_component(transform.scale_x) || scale_component(transform.scale_y)
}

fn scale_component(value: Option<f64>) -> bool {
    value
        .filter(|value| value.is_finite())
        .map(|value| value > 0.0 && (value - 1.0).abs() > 0.000_001)
        .unwrap_or(false)
}

fn resolve_transform(
    transform: &PreviewTransform,
    dimensions: Option<(u32, u32)>,
) -> Option<ResolvedTransform> {
    let posx = normalize_position(transform.x);
    let posy = normalize_position(transform.y);
    let width = transform.scale_x.and_then(|scale_x| {
        dimensions.and_then(|(source_width, _)| resolve_scaled_size(source_width, scale_x))
    });
    let height = transform.scale_y.and_then(|scale_y| {
        dimensions.and_then(|(_, source_height)| resolve_scaled_size(source_height, scale_y))
    });
    let opacity = normalize_opacity(transform.opacity);
    let video_direction = resolve_video_direction(transform.rotation_deg);

    if posx.is_none()
        && posy.is_none()
        && width.is_none()
        && height.is_none()
        && opacity.is_none()
        && video_direction.is_none()
    {
        return None;
    }

    Some(ResolvedTransform {
        posx,
        posy,
        width,
        height,
        opacity,
        video_direction,
    })
}

fn normalize_position(value: Option<f64>) -> Option<i32> {
    let value = value?;
    if !value.is_finite() {
        return None;
    }

    Some(value.round().clamp(i32::MIN as f64, i32::MAX as f64) as i32)
}

fn resolve_scaled_size(source_size: u32, scale: f64) -> Option<i32> {
    if !scale.is_finite() || scale <= 0.0 || (scale - 1.0).abs() <= 0.000_001 {
        return None;
    }

    let scaled = (source_size as f64 * scale).round();
    Some(scaled.clamp(1.0, i32::MAX as f64) as i32)
}

fn normalize_opacity(value: Option<f64>) -> Option<f64> {
    let value = value?;
    if !value.is_finite() {
        return None;
    }

    Some(value.clamp(0.0, 1.0))
}

fn resolve_video_direction(rotation_deg: Option<f64>) -> Option<ResolvedVideoDirection> {
    let rotation_deg = rotation_deg?;
    if !rotation_deg.is_finite() {
        return None;
    }

    let normalized = rotation_deg.rem_euclid(360.0);
    if approx_eq(normalized, 0.0) || approx_eq(normalized, 360.0) {
        return None;
    }
    if approx_eq(normalized, 90.0) {
        return Some(ResolvedVideoDirection::Rotate90Right);
    }
    if approx_eq(normalized, 180.0) {
        return Some(ResolvedVideoDirection::Rotate180);
    }
    if approx_eq(normalized, 270.0) {
        return Some(ResolvedVideoDirection::Rotate90Left);
    }

    None
}

fn approx_eq(left: f64, right: f64) -> bool {
    (left - right).abs() <= 0.001
}

pub fn resolve_crop_bounds(crop: &TimelineRenderCrop, width: u32, height: u32) -> ResolvedCrop {
    let left = ((crop.x * width as f64).round() as u32).min(width.saturating_sub(1));
    let top = ((crop.y * height as f64).round() as u32).min(height.saturating_sub(1));
    let crop_width = ((crop.width * width as f64).round() as u32).clamp(1, width - left);
    let crop_height = ((crop.height * height as f64).round() as u32).clamp(1, height - top);

    ResolvedCrop {
        left,
        right: width.saturating_sub(left + crop_width),
        top,
        bottom: height.saturating_sub(top + crop_height),
    }
}

impl ResolvedVideoDirection {
    pub fn as_cli_value(self) -> &'static str {
        match self {
            Self::Rotate90Right => "90r",
            Self::Rotate180 => "180",
            Self::Rotate90Left => "90l",
        }
    }

    #[cfg(not(test))]
    fn as_gst_value(self) -> gst_video::VideoOrientationMethod {
        match self {
            Self::Rotate90Right => gst_video::VideoOrientationMethod::_90r,
            Self::Rotate180 => gst_video::VideoOrientationMethod::_180,
            Self::Rotate90Left => gst_video::VideoOrientationMethod::_90l,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_transform_clamps_and_quantizes_supported_values() {
        let resolved = resolve_transform(
            &PreviewTransform {
                x: Some(12.4),
                y: Some(-7.6),
                scale_x: Some(0.5),
                scale_y: Some(1.5),
                rotation_deg: Some(90.0),
                opacity: Some(1.4),
            },
            Some((1920, 1080)),
        )
        .expect("transform should resolve");

        assert_eq!(resolved.posx, Some(12));
        assert_eq!(resolved.posy, Some(-8));
        assert_eq!(resolved.width, Some(960));
        assert_eq!(resolved.height, Some(1620));
        assert_eq!(resolved.opacity, Some(1.0));
        assert_eq!(
            resolved.video_direction,
            Some(ResolvedVideoDirection::Rotate90Right)
        );
    }

    #[test]
    fn build_cli_modifier_args_emits_crop_transform_and_volume_flags() {
        let args = build_cli_modifier_args(&GesClipModifierPlan {
            clip_id: "clip-1".to_string(),
            track_type: TimelineTrackType::Audio,
            volume: 0.25,
            crop: Some(ResolvedCrop {
                left: 10,
                right: 20,
                top: 30,
                bottom: 40,
            }),
            transform: Some(ResolvedTransform {
                posx: Some(15),
                posy: Some(-5),
                width: Some(640),
                height: Some(360),
                opacity: Some(0.9),
                video_direction: Some(ResolvedVideoDirection::Rotate180),
            }),
        });

        assert!(args.iter().any(|arg| arg == "videocrop"));
        assert!(args.iter().any(|arg| arg == "set-alpha"));
        assert!(args.iter().any(|arg| arg == "0.900000"));
        assert!(args.iter().any(|arg| arg == "set-posx"));
        assert!(args.iter().any(|arg| arg == "15"));
        assert!(args.iter().any(|arg| arg == "set-width"));
        assert!(args.iter().any(|arg| arg == "640"));
        assert!(args.iter().any(|arg| arg == "set-video-direction"));
        assert!(args.iter().any(|arg| arg == "180"));
        assert!(args.iter().any(|arg| arg == "set-volume"));
        assert!(args.iter().any(|arg| arg == "0.250000"));
    }
}
