use std::path::{Path, PathBuf};

/// Default region for Volcengine APIs.
pub(crate) const DEFAULT_REGION: &str = "cn-beijing";

/// Maximum download size for generated videos (500 MB).
pub(crate) const MAX_DOWNLOAD_SIZE: u64 = 500 * 1024 * 1024;

/// Truncate a response body for error messages / logs, staying on UTF-8 char
/// boundaries (a mid-codepoint slice would panic when formatted). Shared by
/// the MiniMax and SeedAudio TTS commands.
pub(crate) fn truncate_body(body: &str) -> String {
    const MAX_CHARS: usize = 2000;
    let truncated: String = body.chars().take(MAX_CHARS).collect();
    if truncated.len() < body.len() {
        format!("{}...(truncated, {} bytes total)", truncated, body.len())
    } else {
        truncated
    }
}

/// Strip `https://` or `http://` scheme prefix from a URL, returning the host+path portion.
pub(crate) fn strip_url_scheme(url: &str) -> &str {
    url.strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url)
}

/// Enforce HTTPS on a base URL. Returns an error for `http://` URLs and
/// prepends `https://` when no scheme is present.
pub(crate) fn enforce_https(url: &str) -> Result<String, String> {
    if url.starts_with("https://") {
        Ok(url.to_string())
    } else if url.starts_with("http://") {
        Err(format!(
            "HTTP URLs are not allowed for security reasons: {}",
            url
        ))
    } else {
        Ok(format!("https://{}", url))
    }
}

/// Extract the origin (scheme://host) from a URL, dropping any path segments.
/// e.g. `"https://ark.cn-beijing.volces.com/api/v3/..."` → `"https://ark.cn-beijing.volces.com"`
pub(crate) fn extract_origin(url: &str) -> String {
    match url.find("://") {
        Some(i) => match url[i + 3..].find('/') {
            Some(j) => url[..i + 3 + j].to_string(),
            None => url.to_string(),
        },
        None => url.to_string(),
    }
}

/// Defaults to `"ak"`.
pub(crate) fn resolve_auth_query_key(auth_query_key: Option<&str>) -> &str {
    auth_query_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("ak")
}

/// Validate and canonicalize a file path.
/// Rejects non-absolute paths; returns the resolved `PathBuf`.
pub(crate) fn validate_local_path(file_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(file_path);
    if !path.is_absolute() {
        return Err("File path must be absolute".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    Ok(canonical)
}

/// Whether a directory *name* is a standard user folder (Downloads / Desktop /
/// Documents / Music / Videos / Pictures / Movies). Case-insensitive; matches
/// the English folder names Windows uses for the OS user dirs even under a
/// localized UI (the on-disk name is English; only the shell display is
/// localized via `desktop.ini`).
fn is_standard_user_dir_name(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "Downloads",
        "Desktop",
        "Documents",
        "Music",
        "Videos",
        "Pictures",
        "Movies",
    ];
    NAMES.iter().any(|n| n.eq_ignore_ascii_case(name))
}

/// Build the allowed-directory set for reference-file reads.
///
/// Always includes the standard `dirs::*` user folders + the project dir (all
/// canonicalized). Additionally, for each given reference file path, walks the
/// path's ancestors and adds the *nearest* standard-user-dir ancestor
/// (canonicalized) — so a reference file kept on a non-system drive's user dir
/// (e.g. `D:\Downloads\测试资源\clip.wav`) is accepted. `dirs::*` resolve only
/// the system-drive user dir on Windows (e.g. `C:\Users\<user>\Downloads`), so
/// without the ancestor walk a `D:\Downloads\…` reference is rejected with
/// "File must be in a user directory" before the API is ever called.
///
/// Each entry is canonicalized so the `\\?\`-prefixed canonical file path
/// (Windows) matches via `Path::starts_with` — a non-canonical dir prefix never
/// matches a canonicalized file path on Windows. The nearest-user-dir-walk keeps
/// the allow-list tight: an arbitrary dir like `C:\Windows` is still rejected
/// (its name isn't a standard user folder).
pub(crate) fn build_allowed_dirs(
    project_path: &str,
    reference_file_paths: impl IntoIterator<Item = impl AsRef<str>>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [
        dirs::data_dir(),
        dirs::home_dir(),
        dirs::desktop_dir(),
        dirs::download_dir(),
        Some(std::env::temp_dir()),
    ]
    .into_iter()
    .flatten()
    .map(|d| d.canonicalize().unwrap_or(d))
    .collect();
    // Project dir: canonicalize once (None → excluded, matching the prior
    // `.ok()` semantics). Pushed separately so an already-canonical path
    // isn't re-canonicalized through the `.map` above.
    if let Ok(c) = Path::new(project_path).canonicalize() {
        dirs.push(c);
    }

    for path_str in reference_file_paths.into_iter() {
        for ancestor in Path::new(path_str.as_ref()).ancestors() {
            let is_user_dir = ancestor
                .file_name()
                .and_then(|n| n.to_str())
                .map(is_standard_user_dir_name)
                .unwrap_or(false);
            if is_user_dir {
                if let Ok(c) = ancestor.canonicalize() {
                    if !dirs.iter().any(|d| d == &c) {
                        dirs.push(c);
                    }
                }
                break; // nearest standard-user-dir ancestor is enough
            }
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_standard_user_dir_name ──

    #[test]
    fn is_standard_user_dir_name_matches_known_folders() {
        // The standard user-folder names Windows uses for the OS user dirs even
        // under a localized UI. These let the base64 allowed-dir set accept a
        // reference on a non-system drive (e.g. D:\Downloads\…).
        assert!(is_standard_user_dir_name("Downloads"));
        assert!(is_standard_user_dir_name("Desktop"));
        assert!(is_standard_user_dir_name("Documents"));
        assert!(is_standard_user_dir_name("Music"));
        assert!(is_standard_user_dir_name("Videos"));
        assert!(is_standard_user_dir_name("Pictures"));
        assert!(is_standard_user_dir_name("Movies"));
    }

    #[test]
    fn is_standard_user_dir_name_is_case_insensitive() {
        assert!(is_standard_user_dir_name("downloads"));
        assert!(is_standard_user_dir_name("DESKTOP"));
        assert!(is_standard_user_dir_name("DocuMENTS"));
    }

    #[test]
    fn is_standard_user_dir_name_rejects_non_standard_names() {
        // A localized folder name (中文 "下载"), a project dir, or a system
        // folder must NOT match — this is what keeps the allow-list from
        // accepting arbitrary dirs (e.g. C:\Windows is not a standard user dir).
        assert!(!is_standard_user_dir_name("测试资源"));
        assert!(!is_standard_user_dir_name("下载"));
        assert!(!is_standard_user_dir_name("Windows"));
        assert!(!is_standard_user_dir_name("System32"));
        assert!(!is_standard_user_dir_name("my-project"));
        assert!(!is_standard_user_dir_name(""));
    }
}
