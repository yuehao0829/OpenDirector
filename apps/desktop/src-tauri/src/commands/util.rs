/// Default region for Volcengine APIs.
pub(crate) const DEFAULT_REGION: &str = "cn-beijing";

/// Maximum download size for generated videos (500 MB).
pub(crate) const MAX_DOWNLOAD_SIZE: u64 = 500 * 1024 * 1024;

/// Authentication mode for API requests.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum AuthMode {
    #[default]
    #[serde(rename = "bearer")]
    Bearer,
    #[serde(rename = "query_param")]
    QueryParam,
}

/// Strip `https://` or `http://` scheme prefix from a URL, returning the host+path portion.
pub(crate) fn strip_url_scheme(url: &str) -> &str {
    url.strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url)
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
