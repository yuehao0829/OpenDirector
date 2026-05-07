#![allow(dead_code)]

use std::path::PathBuf;

use super::bootstrap::BootstrapReport;

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
pub fn check_required_plugins(
    bootstrap: &BootstrapReport,
    environment_error: Option<&str>,
) -> PluginCheckReport {
    PluginCheckReport {
        search_paths: bootstrap.plugin_search_paths.clone(),
        missing_elements: Vec::new(),
    }
}

#[cfg(not(test))]
pub fn check_required_plugins(
    bootstrap: &BootstrapReport,
    environment_error: Option<&str>,
) -> PluginCheckReport {
    let missing_elements =
        if bootstrap.runtime_root.is_none() || bootstrap.plugin_search_paths.is_empty() {
            REQUIRED_ELEMENT_GROUPS
                .iter()
                .map(|requirement| requirement.label.to_string())
                .collect()
        } else if let Some(error) = environment_error {
            vec![format!("GStreamer environment ({error})")]
        } else if let Err(error) = gst::init() {
            vec![format!("GStreamer init ({error})")]
        } else {
            REQUIRED_ELEMENT_GROUPS
                .iter()
                .filter_map(|requirement| {
                    if inspect_any_element(requirement.candidates) {
                        None
                    } else {
                        Some(requirement.label.to_string())
                    }
                })
                .collect()
        };

    PluginCheckReport {
        search_paths: bootstrap.plugin_search_paths.clone(),
        missing_elements,
    }
}

#[cfg(not(test))]
fn inspect_element(element: &str) -> bool {
    gst::ElementFactory::find(element).is_some()
}

#[cfg(not(test))]
fn inspect_any_element(elements: &[&str]) -> bool {
    elements.iter().any(|element| inspect_element(element))
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
