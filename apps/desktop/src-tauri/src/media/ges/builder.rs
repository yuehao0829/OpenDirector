#![allow(dead_code)]

use super::super::model::{AssetProcessRequest, MediaConcatRequest};

#[derive(Debug, Clone)]
pub struct GesAssetRenderPlan {
    pub input_path: String,
    pub output_dir: String,
}

#[derive(Debug, Clone)]
pub struct GesConcatPlan {
    pub input_paths: Vec<String>,
    pub output_dir: String,
    pub output_filename: String,
}

pub fn build_asset_render_plan(request: &AssetProcessRequest) -> GesAssetRenderPlan {
    GesAssetRenderPlan {
        input_path: request.input_path.clone(),
        output_dir: request.output_dir.clone(),
    }
}

pub fn build_concat_plan(request: &MediaConcatRequest) -> GesConcatPlan {
    GesConcatPlan {
        input_paths: request.input_paths.clone(),
        output_dir: request.output_dir.clone(),
        output_filename: request.output_filename.clone(),
    }
}
