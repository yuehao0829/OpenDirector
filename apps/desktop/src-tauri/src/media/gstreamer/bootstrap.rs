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
    let runtime_root = candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .or_else(|| infer_runtime_root_from_path(std::env::var_os("PATH")));
    let gst_discoverer_path = runtime_root
        .as_ref()
        .and_then(|root| resolve_tool_path(root, "gst-discoverer-1.0"));
    let gst_inspect_path = runtime_root
        .as_ref()
        .and_then(|root| resolve_tool_path(root, "gst-inspect-1.0"));
    let ges_launch_path = runtime_root
        .as_ref()
        .and_then(|root| resolve_tool_path(root, "ges-launch-1.0"));
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
}
