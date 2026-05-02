#![allow(dead_code)]

use super::super::error::{backend_unavailable, MediaResult};

pub fn generate_waveform(_input_path: &str) -> MediaResult<()> {
    Err(backend_unavailable("gstreamerGes waveform"))
}
