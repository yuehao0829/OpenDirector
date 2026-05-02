use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use super::bootstrap::BootstrapReport;

#[derive(Debug, Clone, Copy)]
pub enum GstreamerTool {
    GstDiscoverer,
    GstInspect,
    GesLaunch,
}

pub fn tool_label(tool: GstreamerTool) -> &'static str {
    match tool {
        GstreamerTool::GstDiscoverer => "gst-discoverer-1.0",
        GstreamerTool::GstInspect => "gst-inspect-1.0",
        GstreamerTool::GesLaunch => "ges-launch-1.0",
    }
}

pub fn resolve_tool(report: &BootstrapReport, tool: GstreamerTool) -> Option<PathBuf> {
    match tool {
        GstreamerTool::GstDiscoverer => report.gst_discoverer_path.clone(),
        GstreamerTool::GstInspect => report.gst_inspect_path.clone(),
        GstreamerTool::GesLaunch => report.ges_launch_path.clone(),
    }
}

pub fn configure_command(command: &mut Command, report: &BootstrapReport) {
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    command.env(
        "GST_PLUGIN_FEATURE_RANK",
        preferred_plugin_feature_rank().as_str(),
    );

    if !report.plugin_search_paths.is_empty() {
        let joined = std::env::join_paths(&report.plugin_search_paths)
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        command.env("GST_PLUGIN_PATH", &joined);
        command.env("GST_PLUGIN_SYSTEM_PATH", &joined);
    }

    if let Some(runtime_root) = &report.runtime_root {
        let bin_dir = runtime_root.join("bin");
        if bin_dir.exists() {
            if let Ok(joined) = join_env_path_with_prepend(
                std::env::var_os("PATH")
                    .as_ref()
                    .map(|value| value.as_os_str()),
                bin_dir.as_path(),
            ) {
                command.env("PATH", joined);
            }
        }

        #[cfg(target_os = "macos")]
        {
            let lib_dir = runtime_root.join("lib");
            if lib_dir.exists() {
                if let Ok(joined) = join_env_path_with_prepend(
                    std::env::var_os("DYLD_LIBRARY_PATH")
                        .as_ref()
                        .map(|value| value.as_os_str()),
                    lib_dir.as_path(),
                ) {
                    command.env("DYLD_LIBRARY_PATH", joined);
                }

                if let Ok(joined) = join_env_path_with_prepend(
                    std::env::var_os("DYLD_FALLBACK_LIBRARY_PATH")
                        .as_ref()
                        .map(|value| value.as_os_str()),
                    lib_dir.as_path(),
                ) {
                    command.env("DYLD_FALLBACK_LIBRARY_PATH", joined);
                }
            }

            let typelibs_dir = runtime_root.join("lib").join("girepository-1.0");
            if typelibs_dir.exists() {
                if let Ok(joined) = join_env_path_with_prepend(
                    std::env::var_os("GI_TYPELIB_PATH")
                        .as_ref()
                        .map(|value| value.as_os_str()),
                    typelibs_dir.as_path(),
                ) {
                    command.env("GI_TYPELIB_PATH", joined);
                }
            }

            if let Ok(Some(plugin_scanner_wrapper)) =
                ensure_plugin_scanner_wrapper(report, lib_dir.as_path(), typelibs_dir.as_path())
            {
                command.env("GST_PLUGIN_SCANNER", &plugin_scanner_wrapper);
                command.env("GST_PLUGIN_SCANNER_1_0", plugin_scanner_wrapper);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn run_tool(
    report: &BootstrapReport,
    tool: GstreamerTool,
    args: &[String],
) -> Result<Output, String> {
    let executable = resolve_tool(report, tool).ok_or_else(|| {
        format!(
            "{} was not found in the active GStreamer runtime",
            tool_label(tool)
        )
    })?;

    let mut command = Command::new(&executable);
    command.args(args);
    configure_command(&mut command, report);

    command
        .output()
        .map_err(|err| format!("failed to launch {}: {}", executable.display(), err))
}

pub fn canonicalize_media_path(path: &str) -> Result<PathBuf, String> {
    let original = Path::new(path);
    let candidate = if original.is_absolute() {
        original.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|err| format!("failed to resolve current directory: {}", err))?
            .join(original)
    };

    candidate
        .canonicalize()
        .map_err(|err| format!("failed to resolve media path {}: {}", path, err))
}

pub fn portable_path_string(path: &Path) -> String {
    let raw = path.to_string_lossy().into_owned();

    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }

    raw
}

pub fn file_uri(path: &Path) -> String {
    let normalized = portable_path_string(path).replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

pub fn preferred_plugin_feature_rank() -> String {
    let preferences = [
        "x264enc:257",
        "nvh264enc:0",
        "nvautogpuh264enc:0",
        "nvd3d11h264enc:0",
        "d3d12h264enc:0",
        "mfh264enc:0",
        "mfh264device1enc:0",
        "amfh264enc:0",
        "qsvh264enc:0",
    ];

    match std::env::var("GST_PLUGIN_FEATURE_RANK") {
        Ok(existing) if !existing.trim().is_empty() => {
            format!("{existing},{}", preferences.join(","))
        }
        _ => preferences.join(","),
    }
}

fn join_env_path_with_prepend(
    existing: Option<&OsStr>,
    new_path: &Path,
) -> Result<OsString, String> {
    let existing_entries = existing
        .into_iter()
        .filter(|value| !value.is_empty())
        .flat_map(std::env::split_paths);
    std::env::join_paths(std::iter::once(new_path.to_path_buf()).chain(existing_entries))
        .map_err(|error| format!("failed to join environment path entries: {error}"))
}

#[cfg(target_os = "macos")]
fn ensure_plugin_scanner_wrapper(
    report: &BootstrapReport,
    lib_dir: &Path,
    typelibs_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let Some(scanner_path) = resolve_plugin_scanner_path(report) else {
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
fn resolve_plugin_scanner_path(report: &BootstrapReport) -> Option<PathBuf> {
    let tool_candidates = [
        report.gst_inspect_path.as_ref(),
        report.gst_discoverer_path.as_ref(),
        report.ges_launch_path.as_ref(),
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

    report.runtime_root.as_ref().and_then(|runtime_root| {
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
    use std::ffi::{OsStr, OsString};
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{configure_command, BootstrapReport};

    use super::join_env_path_with_prepend;

    #[test]
    fn join_env_path_with_prepend_splits_existing_entries() {
        let existing = std::env::join_paths([
            PathBuf::from("/existing/one"),
            PathBuf::from("/existing/two"),
        ])
        .expect("existing path list should join");

        let joined =
            join_env_path_with_prepend(Some(existing.as_os_str()), PathBuf::from("/new").as_path())
                .expect("joined path list should be valid");

        let entries = std::env::split_paths(&joined).collect::<Vec<_>>();
        assert_eq!(
            entries,
            vec![
                PathBuf::from("/new"),
                PathBuf::from("/existing/one"),
                PathBuf::from("/existing/two"),
            ]
        );
    }

    #[cfg(target_os = "macos")]
    fn unique_temp_dir(case_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("opendirector-gst-command-{case_name}-{unique}"));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[cfg(target_os = "macos")]
    fn command_env_value(command: &Command, key: &str) -> Option<OsString> {
        command
            .get_envs()
            .find_map(|(name, value)| (name == OsStr::new(key)).then(|| value.map(OsString::from)))
            .flatten()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn configure_command_sets_macos_runtime_and_scanner_envs() {
        let runtime_root = unique_temp_dir("configure-command");
        let bin_dir = runtime_root.join("bin");
        let lib_dir = runtime_root.join("lib");
        let typelibs_dir = lib_dir.join("girepository-1.0");
        let scanner_dir = runtime_root.join("libexec").join("gstreamer-1.0");
        std::fs::create_dir_all(&bin_dir).expect("bin dir");
        std::fs::create_dir_all(&typelibs_dir).expect("typelib dir");
        std::fs::create_dir_all(&scanner_dir).expect("scanner dir");
        std::fs::write(bin_dir.join("gst-inspect-1.0"), []).expect("gst-inspect");
        std::fs::write(scanner_dir.join("gst-plugin-scanner"), []).expect("scanner");

        let report = BootstrapReport {
            runtime_root: Some(runtime_root.clone()),
            plugin_search_paths: Vec::new(),
            gst_discoverer_path: None,
            gst_inspect_path: Some(bin_dir.join("gst-inspect-1.0")),
            ges_launch_path: None,
            diagnostics: Vec::new(),
        };

        let mut command = Command::new("true");
        configure_command(&mut command, &report);

        let dyld_library_path = command_env_value(&command, "DYLD_LIBRARY_PATH")
            .expect("DYLD_LIBRARY_PATH should be set");
        let dyld_fallback_library_path = command_env_value(&command, "DYLD_FALLBACK_LIBRARY_PATH")
            .expect("DYLD_FALLBACK_LIBRARY_PATH should be set");
        let gi_typelib_path =
            command_env_value(&command, "GI_TYPELIB_PATH").expect("GI_TYPELIB_PATH should be set");
        let gst_plugin_scanner = command_env_value(&command, "GST_PLUGIN_SCANNER")
            .expect("GST_PLUGIN_SCANNER should be set");
        let gst_plugin_scanner_1_0 = command_env_value(&command, "GST_PLUGIN_SCANNER_1_0")
            .expect("GST_PLUGIN_SCANNER_1_0 should be set");

        let dyld_library_entries = std::env::split_paths(&dyld_library_path).collect::<Vec<_>>();
        let dyld_fallback_entries =
            std::env::split_paths(&dyld_fallback_library_path).collect::<Vec<_>>();
        let typelib_entries = std::env::split_paths(&gi_typelib_path).collect::<Vec<_>>();

        assert_eq!(dyld_library_entries.first(), Some(&lib_dir));
        assert_eq!(dyld_fallback_entries.first(), Some(&lib_dir));
        assert_eq!(typelib_entries.first(), Some(&typelibs_dir));
        assert_eq!(gst_plugin_scanner, gst_plugin_scanner_1_0);
        assert!(PathBuf::from(gst_plugin_scanner).exists());
    }
}
