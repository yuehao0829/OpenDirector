/// Default region for Volcengine APIs.
pub(crate) const DEFAULT_REGION: &str = "cn-beijing";

/// Maximum download size for generated videos (500 MB).
pub(crate) const MAX_DOWNLOAD_SIZE: u64 = 500 * 1024 * 1024;

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
