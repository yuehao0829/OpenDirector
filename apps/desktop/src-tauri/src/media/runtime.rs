#![cfg_attr(test, allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::error::MediaResult;
use super::gstreamer::command::preferred_plugin_feature_rank;
use super::gstreamer::{bootstrap, plugin_check};

static MEDIA_RUNTIME: OnceLock<MediaRuntimeState> = OnceLock::new();
static GSTREAMER_PROCESS_ENVIRONMENT: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct MediaRuntimeState {
    pub gstreamer: GstreamerRuntimeState,
}

#[derive(Debug, Clone)]
pub struct GstreamerRuntimeState {
    pub compiled: bool,
    pub bootstrap: bootstrap::BootstrapReport,
    pub plugin_check: plugin_check::PluginCheckReport,
}

impl GstreamerRuntimeState {
    pub fn is_ready(&self) -> bool {
        self.compiled
            && self.bootstrap.runtime_root.is_some()
            && self.bootstrap.gst_discoverer_path.is_some()
            && self.bootstrap.ges_launch_path.is_some()
            && self.plugin_check.missing_elements.is_empty()
    }

    pub fn is_preview_ready(&self) -> bool {
        self.compiled && self.bootstrap.runtime_root.is_some()
    }

    fn base_reason(&self) -> Option<String> {
        if !self.compiled {
            return Some("binary was built without the gstreamer-runtime feature".to_string());
        }

        if self.bootstrap.runtime_root.is_none() {
            return Some(
                self.bootstrap
                    .diagnostics
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "GStreamer runtime was not discovered".to_string()),
            );
        }

        None
    }

    pub fn reason(&self) -> String {
        if let Some(reason) = self.base_reason() {
            return reason;
        }

        if self.bootstrap.gst_discoverer_path.is_none() {
            return "gst-discoverer-1.0 is missing from the runtime".to_string();
        }

        if self.bootstrap.ges_launch_path.is_none() {
            return "ges-launch-1.0 is missing from the runtime".to_string();
        }

        if !self.plugin_check.missing_elements.is_empty() {
            return format!(
                "missing required plugin hints: {}",
                self.plugin_check.missing_elements.join(", ")
            );
        }

        "unknown runtime bootstrap state".to_string()
    }

    pub fn preview_reason(&self) -> String {
        self.base_reason()
            .unwrap_or_else(|| "unknown preview runtime bootstrap state".to_string())
    }
}

pub fn initialize() -> &'static MediaRuntimeState {
    MEDIA_RUNTIME.get_or_init(|| {
        let bootstrap = bootstrap::bootstrap(detect_gstreamer_candidates());
        let plugin_check = plugin_check::check_required_plugins(&bootstrap);

        if let Some(message) = bootstrap.startup_message() {
            eprintln!("[Media] {message}");
        }

        MediaRuntimeState {
            gstreamer: GstreamerRuntimeState {
                compiled: cfg!(feature = "gstreamer-runtime"),
                bootstrap,
                plugin_check,
            },
        }
    })
}

pub fn require_gstreamer_runtime() -> MediaResult<&'static GstreamerRuntimeState> {
    let runtime = initialize();
    if runtime.gstreamer.is_ready() {
        Ok(&runtime.gstreamer)
    } else {
        Err(runtime.gstreamer.reason())
    }
}

pub fn require_gstreamer_preview_runtime() -> MediaResult<&'static GstreamerRuntimeState> {
    let runtime = initialize();
    if runtime.gstreamer.is_preview_ready() {
        Ok(&runtime.gstreamer)
    } else {
        Err(runtime.gstreamer.preview_reason())
    }
}

pub fn prepare_gstreamer_process_environment() -> MediaResult<()> {
    let runtime = require_gstreamer_preview_runtime()?;
    GSTREAMER_PROCESS_ENVIRONMENT
        .get_or_init(|| configure_gstreamer_process_environment(&runtime.bootstrap))
        .clone()
}

fn detect_gstreamer_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    push_existing_candidate(
        &mut candidates,
        std::env::var_os("GSTREAMER_1_0_ROOT_MSVC_X86_64").map(PathBuf::from),
    );
    push_existing_candidate(
        &mut candidates,
        std::env::var_os("GSTREAMER_1_0_ROOT_X86_64").map(PathBuf::from),
    );

    if cfg!(feature = "custom-protocol") {
        // 生产构建：相对于可执行文件路径
        if let Some(exe_dir) = exe_parent_dir() {
            #[cfg(target_os = "macos")]
            {
                // exe: Contents/MacOS/OpenDirector -> Contents/Resources/gstreamer-runtime
                push_existing_candidate(
                    &mut candidates,
                    Some(exe_dir.join("../Resources/gstreamer-runtime")),
                );
            }
            #[cfg(target_os = "windows")]
            {
                // exe: install-dir/OpenDirector.exe -> install-dir/gstreamer-runtime
                push_existing_candidate(&mut candidates, Some(exe_dir.join("gstreamer-runtime")));
            }
        }
    } else {
        // 开发模式：用 CARGO_MANIFEST_DIR
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        push_existing_candidate(&mut candidates, Some(manifest_dir.join("gstreamer-dev")));
        push_existing_candidate(&mut candidates, Some(manifest_dir.join("gstreamer-runtime")));
        push_existing_candidate(
            &mut candidates,
            Some(manifest_dir.join("binaries").join("gstreamer")),
        );
    }

    push_existing_candidate(
        &mut candidates,
        bootstrap::infer_runtime_root_from_path(std::env::var_os("PATH")),
    );

    #[cfg(target_os = "macos")]
    {
        for prefix in ["/opt/homebrew", "/usr/local", "/opt/local"] {
            push_existing_tool_candidate(&mut candidates, Some(PathBuf::from(prefix)));
        }
    }

    candidates
}

fn exe_parent_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
}

fn push_existing_candidate(candidates: &mut Vec<PathBuf>, candidate: Option<PathBuf>) {
    let Some(candidate) = candidate else {
        return;
    };

    let normalized = normalize_candidate(candidate);
    if normalized.exists() && !candidates.iter().any(|existing| existing == &normalized) {
        candidates.push(normalized);
    }
}

#[cfg(target_os = "macos")]
fn push_existing_tool_candidate(candidates: &mut Vec<PathBuf>, candidate: Option<PathBuf>) {
    let Some(candidate) = candidate else {
        return;
    };

    let normalized = normalize_candidate(candidate);
    if !candidate_contains_required_gstreamer_tools(normalized.as_path()) {
        return;
    }

    if !candidates.iter().any(|existing| existing == &normalized) {
        candidates.push(normalized);
    }
}

fn normalize_candidate(candidate: PathBuf) -> PathBuf {
    if candidate.is_absolute() {
        candidate
    } else if cfg!(feature = "custom-protocol") {
        exe_parent_dir()
            .map(|exe_dir| exe_dir.join(candidate))
            .unwrap_or(candidate)
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(candidate)
    }
}

fn candidate_contains_required_gstreamer_tools(candidate: &Path) -> bool {
    if !candidate.exists() {
        return false;
    }

    [
        "gst-discoverer-1.0",
        "gst-inspect-1.0",
        "ges-launch-1.0",
    ]
    .into_iter()
    .map(gstreamer_executable_name)
    .all(|executable| {
        candidate.join("bin").join(&executable).exists() || candidate.join(&executable).exists()
    })
}

fn gstreamer_executable_name(base_name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    }
}

fn configure_gstreamer_process_environment(
    bootstrap: &bootstrap::BootstrapReport,
) -> Result<(), String> {
    std::env::set_var(
        "GST_PLUGIN_FEATURE_RANK",
        preferred_plugin_feature_rank().as_str(),
    );

    if !bootstrap.plugin_search_paths.is_empty() {
        let joined = std::env::join_paths(&bootstrap.plugin_search_paths)
            .map_err(|error| format!("failed to join GStreamer plugin search paths: {error}"))?;
        std::env::set_var("GST_PLUGIN_PATH", &joined);
        std::env::set_var("GST_PLUGIN_SYSTEM_PATH", &joined);
    }

    if let Some(runtime_root) = &bootstrap.runtime_root {
        let bin_dir = runtime_root.join("bin");
        if bin_dir.exists() {
            let existing_path_entries = match std::env::var_os("PATH") {
                Some(value) if !value.is_empty() => std::env::split_paths(&value).collect(),
                _ => Vec::new(),
            };
            let path_entries = std::iter::once(bin_dir)
                .chain(existing_path_entries)
                .collect::<Vec<_>>();
            let joined = std::env::join_paths(path_entries)
                .map_err(|error| format!("failed to configure GStreamer runtime PATH: {error}"))?;
            std::env::set_var("PATH", joined);
        }

        #[cfg(target_os = "macos")]
        {
            let lib_dir = runtime_root.join("lib");
            if lib_dir.exists() {
                prepend_env_path("DYLD_LIBRARY_PATH", lib_dir.as_path())?;
                prepend_env_path("DYLD_FALLBACK_LIBRARY_PATH", lib_dir.as_path())?;
            }

            let typelibs_dir = lib_dir.join("girepository-1.0");
            if typelibs_dir.exists() {
                prepend_env_path("GI_TYPELIB_PATH", typelibs_dir.as_path())?;
            }

            if let Some(plugin_scanner_wrapper) =
                ensure_plugin_scanner_wrapper(bootstrap, lib_dir.as_path(), typelibs_dir.as_path())?
            {
                std::env::set_var("GST_PLUGIN_SCANNER", &plugin_scanner_wrapper);
                std::env::set_var("GST_PLUGIN_SCANNER_1_0", plugin_scanner_wrapper);
            }
        }
    }

    Ok(())
}

fn prepend_env_path(key: &str, new_path: &Path) -> Result<(), String> {
    let existing_entries: Vec<PathBuf> = match std::env::var_os(key) {
        Some(value) if !value.is_empty() => std::env::split_paths(&value).collect(),
        _ => Vec::new(),
    };
    let joined =
        std::env::join_paths(std::iter::once(new_path.to_path_buf()).chain(existing_entries))
            .map_err(|error| format!("failed to configure {key}: {error}"))?;
    std::env::set_var(key, joined);
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_plugin_scanner_wrapper(
    bootstrap: &bootstrap::BootstrapReport,
    lib_dir: &Path,
    typelibs_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let Some(scanner_path) = resolve_plugin_scanner_path(bootstrap) else {
        return Ok(None);
    };

    let wrapper_dir = std::env::temp_dir().join("opendirector-gstreamer");
    fs::create_dir_all(&wrapper_dir)
        .map_err(|error| format!("failed to create plugin scanner wrapper dir: {error}"))?;

    let wrapper_path = wrapper_dir.join("gst-plugin-scanner-macos.sh");
    let script = format!(
        "#!/bin/sh\nexport DYLD_LIBRARY_PATH={lib_dir}${{DYLD_LIBRARY_PATH:+\":$DYLD_LIBRARY_PATH\"}}\nexport DYLD_FALLBACK_LIBRARY_PATH={lib_dir}${{DYLD_FALLBACK_LIBRARY_PATH:+\":$DYLD_FALLBACK_LIBRARY_PATH\"}}\nexport GI_TYPELIB_PATH={typelibs_dir}${{GI_TYPELIB_PATH:+\":$GI_TYPELIB_PATH\"}}\nexec {scanner_path} \"$@\"\n",
        lib_dir = shell_single_quote(lib_dir),
        typelibs_dir = shell_single_quote(typelibs_dir),
        scanner_path = shell_single_quote(&scanner_path),
    );

    let should_write = match fs::read_to_string(&wrapper_path) {
        Ok(existing) => existing != script,
        Err(_) => true,
    };
    if should_write {
        fs::write(&wrapper_path, script)
            .map_err(|error| format!("failed to write plugin scanner wrapper: {error}"))?;
        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&wrapper_path, permissions).map_err(|error| {
            format!("failed to mark plugin scanner wrapper executable: {error}")
        })?;
    }

    Ok(Some(wrapper_path))
}

#[cfg(target_os = "macos")]
fn resolve_plugin_scanner_path(bootstrap: &bootstrap::BootstrapReport) -> Option<PathBuf> {
    let tool_candidates = [
        bootstrap.gst_inspect_path.as_ref(),
        bootstrap.gst_discoverer_path.as_ref(),
        bootstrap.ges_launch_path.as_ref(),
    ];

    for tool_path in tool_candidates.into_iter().flatten() {
        let Ok(canonical) = tool_path.canonicalize() else {
            continue;
        };
        let Some(tool_dir) = canonical.parent() else {
            continue;
        };
        let Some(prefix_dir) = tool_dir.parent() else {
            continue;
        };
        let scanner_path = prefix_dir
            .join("libexec")
            .join("gstreamer-1.0")
            .join("gst-plugin-scanner");
        if scanner_path.exists() {
            return Some(scanner_path);
        }
    }

    bootstrap.runtime_root.as_ref().and_then(|runtime_root| {
        let scanner_path = runtime_root
            .join("libexec")
            .join("gstreamer-1.0")
            .join("gst-plugin-scanner");
        scanner_path.exists().then_some(scanner_path)
    })
}

#[cfg(target_os = "macos")]
fn shell_single_quote(path: &Path) -> String {
    let value = path.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(case_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("opendirector-runtime-{case_name}-{unique}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn candidate_contains_required_gstreamer_tools_rejects_plain_prefix() {
        let prefix = unique_temp_dir("plain-prefix");

        assert!(!candidate_contains_required_gstreamer_tools(prefix.as_path()));
    }

    #[test]
    fn candidate_contains_required_gstreamer_tools_rejects_partial_prefix() {
        let prefix = unique_temp_dir("tool-prefix");
        let bin_dir = prefix.join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        fs::write(
            bin_dir.join(gstreamer_executable_name("gst-inspect-1.0")),
            [],
        )
        .expect("gst-inspect");

        assert!(!candidate_contains_required_gstreamer_tools(prefix.as_path()));
    }

    #[test]
    fn candidate_contains_required_gstreamer_tools_accepts_prefix_with_all_tools_in_bin() {
        let prefix = unique_temp_dir("full-tool-prefix");
        let bin_dir = prefix.join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        for tool_name in ["gst-discoverer-1.0", "gst-inspect-1.0", "ges-launch-1.0"] {
            fs::write(bin_dir.join(gstreamer_executable_name(tool_name)), []).expect("tool");
        }

        assert!(candidate_contains_required_gstreamer_tools(prefix.as_path()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn path_runtime_candidate_precedes_fixed_macos_prefixes() {
        let path_runtime = unique_temp_dir("path-runtime");
        let fallback_prefix = unique_temp_dir("fallback-prefix");

        for root in [&path_runtime, &fallback_prefix] {
            let bin_dir = root.join("bin");
            fs::create_dir_all(&bin_dir).expect("bin dir");
            for tool_name in ["gst-discoverer-1.0", "gst-inspect-1.0", "ges-launch-1.0"] {
                fs::write(bin_dir.join(gstreamer_executable_name(tool_name)), []).expect("tool");
            }
        }

        let mut candidates = Vec::new();
        push_existing_candidate(&mut candidates, Some(path_runtime.clone()));
        push_existing_tool_candidate(&mut candidates, Some(fallback_prefix.clone()));

        assert_eq!(candidates, vec![path_runtime, fallback_prefix]);
    }
}
