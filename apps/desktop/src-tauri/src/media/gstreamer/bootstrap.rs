use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct BootstrapReport {
    pub runtime_root: Option<PathBuf>,
    pub plugin_search_paths: Vec<PathBuf>,
    pub gst_discoverer_path: Option<PathBuf>,
    pub gst_inspect_path: Option<PathBuf>,
    pub ges_launch_path: Option<PathBuf>,
    pub diagnostics: Vec<String>,
}

impl BootstrapReport {
    pub fn startup_message(&self) -> Option<String> {
        if let Some(root) = &self.runtime_root {
            return Some(format!(
                "discovered GStreamer runtime candidate at {}",
                root.display()
            ));
        }

        self.diagnostics
            .first()
            .map(|message| format!("GStreamer runtime bootstrap pending: {message}"))
    }
}

pub fn bootstrap(candidates: Vec<PathBuf>) -> BootstrapReport {
    let resolved = resolve_runtime_candidate(candidates);
    let runtime_root = resolved.as_ref().map(|candidate| candidate.runtime_root.clone());
    let gst_discoverer_path = resolved
        .as_ref()
        .and_then(|candidate| candidate.gst_discoverer_path.clone());
    let gst_inspect_path = resolved
        .as_ref()
        .and_then(|candidate| candidate.gst_inspect_path.clone());
    let ges_launch_path = resolved
        .as_ref()
        .and_then(|candidate| candidate.ges_launch_path.clone());
    let plugin_search_paths = runtime_root
        .as_ref()
        .map(resolve_plugin_search_paths)
        .unwrap_or_default();

    let mut diagnostics = Vec::new();
    if runtime_root.is_none() {
        diagnostics.push(
            "run `pnpm setup:gstreamer`, set GSTREAMER_1_0_ROOT_*, or make gst-discoverer-1.0 / gst-inspect-1.0 / ges-launch-1.0 discoverable on PATH".to_string(),
        );
    } else {
        if gst_discoverer_path.is_none() {
            diagnostics.push("gst-discoverer-1.0 was not found in the runtime".to_string());
        }
        if gst_inspect_path.is_none() {
            diagnostics.push("gst-inspect-1.0 was not found in the runtime".to_string());
        }
        if ges_launch_path.is_none() {
            diagnostics.push("ges-launch-1.0 was not found in the runtime".to_string());
        }
    }

    BootstrapReport {
        runtime_root,
        plugin_search_paths,
        gst_discoverer_path,
        gst_inspect_path,
        ges_launch_path,
        diagnostics,
    }
}

#[derive(Debug, Clone)]
struct RuntimeCandidate {
    runtime_root: PathBuf,
    gst_discoverer_path: Option<PathBuf>,
    gst_inspect_path: Option<PathBuf>,
    ges_launch_path: Option<PathBuf>,
}

impl RuntimeCandidate {
    fn from_root(runtime_root: PathBuf) -> Self {
        Self {
            gst_discoverer_path: resolve_tool_path(&runtime_root, "gst-discoverer-1.0"),
            gst_inspect_path: resolve_tool_path(&runtime_root, "gst-inspect-1.0"),
            ges_launch_path: resolve_tool_path(&runtime_root, "ges-launch-1.0"),
            runtime_root,
        }
    }

    fn is_preview_ready(&self) -> bool {
        self.gst_discoverer_path.is_some() && self.gst_inspect_path.is_some()
    }

    fn is_runtime_ready(&self) -> bool {
        self.is_preview_ready() && self.ges_launch_path.is_some()
    }
}

fn resolve_runtime_candidate(candidates: Vec<PathBuf>) -> Option<RuntimeCandidate> {
    let mut first_preview_candidate = None;
    let mut first_existing_candidate = None;

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }

        let resolved = RuntimeCandidate::from_root(candidate);
        if resolved.is_runtime_ready() {
            return Some(resolved);
        }
        if first_preview_candidate.is_none() && resolved.is_preview_ready() {
            first_preview_candidate = Some(resolved.clone());
        }
        if first_existing_candidate.is_none() {
            first_existing_candidate = Some(resolved);
        }
    }

    first_preview_candidate.or(first_existing_candidate)
}

pub(crate) fn infer_runtime_root_from_path(path_value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path_value = path_value?;
    let executable_names = if cfg!(target_os = "windows") {
        [
            "gst-discoverer-1.0.exe",
            "gst-inspect-1.0.exe",
            "ges-launch-1.0.exe",
        ]
    } else {
        ["gst-discoverer-1.0", "gst-inspect-1.0", "ges-launch-1.0"]
    };

    for entry in std::env::split_paths(&path_value) {
        for executable_name in executable_names {
            if entry.join(executable_name).exists() {
                if let Some(parent) = entry.parent() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }

    None
}

fn resolve_plugin_search_paths(runtime_root: &PathBuf) -> Vec<PathBuf> {
    let candidates = [
        runtime_root.join("lib").join("gstreamer-1.0"),
        runtime_root.join("bin").join("gstreamer-1.0"),
        runtime_root.join("plugins"),
    ];

    candidates
        .into_iter()
        .filter(|candidate| candidate.exists())
        .collect()
}

fn resolve_tool_path(runtime_root: &PathBuf, base_name: &str) -> Option<PathBuf> {
    let executable_name = if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    };

    let candidates = [
        runtime_root.join("bin").join(&executable_name),
        runtime_root.join(&executable_name),
    ];

    candidates.into_iter().find(|candidate| candidate.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(case_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("genline-bootstrap-{case_name}-{unique}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn executable_name(base_name: &str) -> String {
        if cfg!(target_os = "windows") {
            format!("{base_name}.exe")
        } else {
            base_name.to_string()
        }
    }

    #[test]
    fn infer_runtime_root_from_path_finds_parent_of_bin_directory() {
        let runtime_root = unique_temp_dir("path");
        let bin_dir = runtime_root.join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        fs::write(bin_dir.join(executable_name("gst-inspect-1.0")), []).expect("tool");

        let path_value = std::env::join_paths([bin_dir]).expect("path");
        let detected = infer_runtime_root_from_path(Some(OsString::from(path_value)));

        assert_eq!(detected.as_deref(), Some(runtime_root.as_path()));
    }

    #[test]
    fn bootstrap_reports_ready_tools_for_existing_runtime_root() {
        let runtime_root = unique_temp_dir("root");
        let bin_dir = runtime_root.join("bin");
        let plugin_dir = runtime_root.join("lib").join("gstreamer-1.0");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        fs::create_dir_all(&plugin_dir).expect("plugin dir");

        for tool_name in ["gst-discoverer-1.0", "gst-inspect-1.0", "ges-launch-1.0"] {
            fs::write(bin_dir.join(executable_name(tool_name)), []).expect("tool");
        }

        let report = bootstrap(vec![runtime_root.clone()]);

        assert_eq!(report.runtime_root.as_deref(), Some(runtime_root.as_path()));
        assert_eq!(report.plugin_search_paths, vec![plugin_dir]);
        assert!(report.diagnostics.is_empty());
    }

    #[test]
    fn bootstrap_prefers_full_runtime_over_earlier_preview_only_candidate() {
        let preview_root = unique_temp_dir("preview-root");
        let preview_bin_dir = preview_root.join("bin");
        fs::create_dir_all(&preview_bin_dir).expect("preview bin dir");
        for tool_name in ["gst-discoverer-1.0", "gst-inspect-1.0"] {
            fs::write(preview_bin_dir.join(executable_name(tool_name)), []).expect("preview tool");
        }

        let full_root = unique_temp_dir("full-root");
        let full_bin_dir = full_root.join("bin");
        fs::create_dir_all(&full_bin_dir).expect("full bin dir");
        for tool_name in ["gst-discoverer-1.0", "gst-inspect-1.0", "ges-launch-1.0"] {
            fs::write(full_bin_dir.join(executable_name(tool_name)), []).expect("full tool");
        }

        let report = bootstrap(vec![preview_root, full_root.clone()]);

        assert_eq!(report.runtime_root.as_deref(), Some(full_root.as_path()));
        assert!(report.gst_discoverer_path.is_some());
        assert!(report.gst_inspect_path.is_some());
        assert!(report.ges_launch_path.is_some());
    }

    #[test]
    fn bootstrap_falls_back_to_preview_runtime_when_ges_is_missing() {
        let preview_root = unique_temp_dir("preview-only-root");
        let preview_bin_dir = preview_root.join("bin");
        fs::create_dir_all(&preview_bin_dir).expect("preview bin dir");
        for tool_name in ["gst-discoverer-1.0", "gst-inspect-1.0"] {
            fs::write(preview_bin_dir.join(executable_name(tool_name)), []).expect("preview tool");
        }

        let report = bootstrap(vec![preview_root.clone()]);

        assert_eq!(report.runtime_root.as_deref(), Some(preview_root.as_path()));
        assert!(report.gst_discoverer_path.is_some());
        assert!(report.gst_inspect_path.is_some());
        assert!(report.ges_launch_path.is_none());
    }
}
