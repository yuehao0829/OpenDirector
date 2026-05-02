#![allow(dead_code)]

use std::path::PathBuf;

use super::bootstrap::BootstrapReport;
use super::command::{run_tool, GstreamerTool};

const REQUIRED_ELEMENTS: &[&str] = &[
    "playbin",
    "decodebin",
    "videoconvert",
    "videoscale",
    "videocrop",
    "audioconvert",
    "audioresample",
    "audiomixer",
    "x264enc",
    "voaacenc",
    "mp4mux",
];

#[derive(Debug, Clone)]
pub struct PluginCheckReport {
    pub search_paths: Vec<PathBuf>,
    pub missing_elements: Vec<String>,
}

#[cfg(test)]
pub fn check_required_plugins(bootstrap: &BootstrapReport) -> PluginCheckReport {
    PluginCheckReport {
        search_paths: bootstrap.plugin_search_paths.clone(),
        missing_elements: Vec::new(),
    }
}

#[cfg(not(test))]
pub fn check_required_plugins(bootstrap: &BootstrapReport) -> PluginCheckReport {
    let missing_elements =
        if bootstrap.runtime_root.is_none() || bootstrap.plugin_search_paths.is_empty() {
            REQUIRED_ELEMENTS
                .iter()
                .map(|name| (*name).to_string())
                .collect()
        } else if bootstrap.gst_inspect_path.is_none() {
            vec!["gst-inspect-1.0".to_string()]
        } else {
            REQUIRED_ELEMENTS
                .iter()
                .filter_map(|name| match inspect_element(bootstrap, name) {
                    Ok(true) => None,
                    Ok(false) => Some((*name).to_string()),
                    Err(_) => Some((*name).to_string()),
                })
                .collect()
        };

    PluginCheckReport {
        search_paths: bootstrap.plugin_search_paths.clone(),
        missing_elements,
    }
}

fn inspect_element(bootstrap: &BootstrapReport, element: &str) -> Result<bool, String> {
    let args = vec!["--exists".to_string(), element.to_string()];
    let output = run_tool(bootstrap, GstreamerTool::GstInspect, &args)?;
    Ok(output.status.success())
}
