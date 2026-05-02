fn main() {
    if std::env::var_os("CARGO_FEATURE_GSTREAMER_RUNTIME").is_some() {
        check_gstreamer_dev();
    }

    tauri_build::build()
}

fn check_gstreamer_dev() {
    use std::path::{Path, PathBuf};

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let manifest_path = Path::new(&manifest_dir);
    let local_runtime_dir = manifest_path.join("gstreamer-dev");
    let local_bundle_dir = manifest_path.join("gstreamer-runtime");

    println!("cargo:rerun-if-env-changed=GSTREAMER_1_0_ROOT_MSVC_X86_64");
    println!("cargo:rerun-if-env-changed=GSTREAMER_1_0_ROOT_X86_64");
    println!("cargo:rerun-if-env-changed=GST_PLUGIN_PATH");
    println!("cargo:rerun-if-env-changed=GST_PLUGIN_SYSTEM_PATH");

    let runtime_root = std::env::var_os("GSTREAMER_1_0_ROOT_MSVC_X86_64")
        .or_else(|| std::env::var_os("GSTREAMER_1_0_ROOT_X86_64"))
        .map(PathBuf::from);
    let path_runtime_root = infer_runtime_root_from_path();

    let has_local_runtime = local_runtime_dir.exists() || local_bundle_dir.exists();
    let has_runtime_root = runtime_root.as_ref().is_some_and(|path| path.exists());
    let has_path_runtime = path_runtime_root.as_ref().is_some_and(|path| path.exists());

    if !has_local_runtime && !has_runtime_root && !has_path_runtime {
        println!("cargo:warning=GStreamer runtime feature enabled, but no local gstreamer-dev/ runtime, GSTREAMER_1_0_ROOT_* environment variable, or PATH-discoverable runtime was found.");
        println!("cargo:warning=Run from the repo root: pnpm setup:gstreamer");
    }
}

fn infer_runtime_root_from_path() -> Option<std::path::PathBuf> {
    let path_value = std::env::var_os("PATH")?;
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
                return entry.parent().map(|parent| parent.to_path_buf());
            }
        }
    }

    None
}
