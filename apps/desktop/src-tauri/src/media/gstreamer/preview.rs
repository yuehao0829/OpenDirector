#![allow(dead_code)]

use super::super::error::{backend_unavailable, MediaResult};

pub fn start_preview_session(_input_path: &str) -> MediaResult<()> {
    Err(backend_unavailable("gstreamerGes preview"))
}
