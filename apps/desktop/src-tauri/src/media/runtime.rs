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
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();

    push_existing_candidate(
        &mut candidates,
        std::env::var_os("GSTREAMER_1_0_ROOT_MSVC_X86_64").map(PathBuf::from),
    );
    push_existing_candidate(
        &mut candidates,
        std::env::var_os("GSTREAMER_1_0_ROOT_X86_64").map(PathBuf::from),
    );
    push_existing_candidate(&mut candidates, Some(manifest_dir.join("gstreamer-dev")));
    push_existing_candidate(
        &mut candidates,
        Some(manifest_dir.join("gstreamer-runtime")),
    );
    push_existing_candidate(
        &mut candidates,
        Some(manifest_dir.join("binaries").join("gstreamer")),
    );

    candidates
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

fn normalize_candidate(candidate: PathBuf) -> PathBuf {
    if candidate.is_absolute() {
        candidate
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(candidate)
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
