#![allow(dead_code)]

use super::super::model::AssetProcessRequest;

#[derive(Debug, Clone)]
pub struct CropEffectDescriptor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn extract_crop_effect(request: &AssetProcessRequest) -> Option<CropEffectDescriptor> {
    match (
        request.crop_x,
        request.crop_y,
        request.crop_w,
        request.crop_h,
    ) {
        (Some(x), Some(y), Some(width), Some(height)) => Some(CropEffectDescriptor {
            x,
            y,
            width,
            height,
        }),
        _ => None,
    }
}
