#![allow(dead_code)]

use std::path::PathBuf;

use super::bootstrap::BootstrapReport;
use super::command::{run_tool, GstreamerTool};

struct RequiredElementGroup {
    label: &'static str,
    candidates: &'static [&'static str],
}

const REQUIRED_ELEMENT_GROUPS: &[RequiredElementGroup] = &[
    RequiredElementGroup {
        label: "playbin",
        candidates: &["playbin"],
    },
    RequiredElementGroup {
        label: "decodebin",
        candidates: &["decodebin"],
    },
    RequiredElementGroup {
        label: "videoconvert",
        candidates: &["videoconvert"],
    },
    RequiredElementGroup {
        label: "videoscale",
        candidates: &["videoscale"],
    },
    RequiredElementGroup {
        label: "videocrop",
        candidates: &["videocrop"],
    },
    RequiredElementGroup {
        label: "audioconvert",
        candidates: &["audioconvert"],
    },
    RequiredElementGroup {
        label: "audioresample",
        candidates: &["audioresample"],
    },
    RequiredElementGroup {
        label: "audiomixer",
        candidates: &["audiomixer"],
    },
    RequiredElementGroup {
        label: "x264enc",
        candidates: &["x264enc"],
    },
    RequiredElementGroup {
        label: "aac encoder",
        candidates: &["voaacenc", "avenc_aac", "fdkaacenc", "faac"],
    },
    RequiredElementGroup {
        label: "mp4mux",
        candidates: &["mp4mux"],
    },
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
            REQUIRED_ELEMENT_GROUPS
                .iter()
                .map(|requirement| requirement.label.to_string())
                .collect()
        } else if bootstrap.gst_inspect_path.is_none() {
            vec!["gst-inspect-1.0".to_string()]
        } else {
            REQUIRED_ELEMENT_GROUPS
                .iter()
                .filter_map(|requirement| {
                    match inspect_any_element(bootstrap, requirement.candidates) {
                        Ok(true) => None,
                        Ok(false) => Some(requirement.label.to_string()),
                        Err(_) => Some(requirement.label.to_string()),
                    }
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

fn inspect_any_element(bootstrap: &BootstrapReport, elements: &[&str]) -> Result<bool, String> {
    for element in elements {
        if inspect_element(bootstrap, element)? {
            return Ok(true);
        }
    }

    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aac_requirement_accepts_any_supported_encoder() {
        let group = REQUIRED_ELEMENT_GROUPS
            .iter()
            .find(|group| group.label == "aac encoder")
            .expect("aac encoder group should exist");

        assert!(group.candidates.contains(&"voaacenc"));
        assert!(group.candidates.contains(&"avenc_aac"));
        assert!(group.candidates.contains(&"fdkaacenc"));
    }
}
