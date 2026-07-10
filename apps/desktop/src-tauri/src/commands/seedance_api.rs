use super::provider_key::get_credentials_internal;
use super::util::{enforce_https, extract_origin, MAX_DOWNLOAD_SIZE};
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HmacSha256 = Hmac<Sha256>;

/// Tauri managed state holding the HTTP client.
pub struct SeedanceState {
    pub http: Client,
}

impl SeedanceState {
    pub fn new() -> Self {
        Self {
            http: Client::new(),
        }
    }
}

const DEFAULT_ARK_BASE_URL: &str = "https://ark.cn-beijing.volces.com";

#[derive(Serialize, Clone, Debug)]
pub struct ApiError {
    pub code: i32,
    pub message: String,
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> String {
        serde_json::to_string(&e).unwrap_or_else(|_| e.message.clone())
    }
}

// ---------------------------------------------------------------------------
// Tauri command parameter / return types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SeedanceContentItem {
    #[serde(rename = "type")]
    pub item_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<ImageUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_url: Option<ImageUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<ImageUrl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

impl SeedanceContentItem {
    /// Returns the URL field reference regardless of content type (image/video/audio).
    pub fn url_field(&self) -> Option<&ImageUrl> {
        match self.item_type.as_str() {
            "image_url" => self.image_url.as_ref(),
            "video_url" => self.video_url.as_ref(),
            "audio_url" => self.audio_url.as_ref(),
            _ => None,
        }
    }

    /// Returns a mutable reference to the URL field.
    pub fn url_field_mut(&mut self) -> Option<&mut ImageUrl> {
        match self.item_type.as_str() {
            "image_url" => self.image_url.as_mut(),
            "video_url" => self.video_url.as_mut(),
            "audio_url" => self.audio_url.as_mut(),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageUrl {
    pub url: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct CreateTaskParams {
    pub content: Vec<SeedanceContentItem>,
    pub model: String,
    pub resolution: String,
    pub ratio: String,
    pub duration: i32,
    pub generate_audio: bool,
    pub return_last_frame: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CreateTaskResult {
    pub task_id: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct TaskStatusResult {
    pub task_id: String,
    pub status: String,
    pub result_url: Option<String>,
    pub last_frame_url: Option<String>,
    pub error: Option<serde_json::Value>,
}

#[derive(Serialize, Clone, Debug)]
pub struct UploadResult {
    pub file_id: String,
    pub base64: String,
    pub filename: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct AssetGroup {
    pub group_id: String,
    pub name: String,
    pub description: String,
    pub group_type: String,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AssetItem {
    pub asset_id: String,
    pub group_id: String,
    pub url: String,
    pub asset_type: String,
    pub project_name: String,
    pub name: Option<String>,
    pub created_at: String,
    pub status: String,
    pub error_message: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AssetGroupListResult {
    pub total: i32,
    pub groups: Vec<AssetGroup>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AssetListResult {
    pub total: i32,
    pub assets: Vec<AssetItem>,
}

// ---------------------------------------------------------------------------
// Helper: resolve a provider's API key + base_url
// ---------------------------------------------------------------------------

/// Decrypt a provider's credentials and verify the `api_key` is non-empty.
/// Shared by all API-key providers (Seedance / MiniMax / GPT-Image) so the
/// "not configured" error message stays consistent. Returns the full
/// `Credentials` so callers that need `base_url` / `auth_mode` / etc. can
/// read them without a second decrypt.
pub(crate) fn get_api_key_checked(
    provider_id: &str,
    password: &str,
) -> Result<crate::commands::provider_key::Credentials, String> {
    let creds = get_credentials_internal(provider_id, password)?;
    // Validate presence without allocating: callers that need the owned
    // `api_key` call `creds.require("api_key")` themselves, so this only
    // needs the borrowed `is_present` predicate (mirrors `require`).
    if !creds.is_present("api_key") {
        return Err(format!(
            "API key not configured for provider '{}'. Please re-enter your API key in Settings → Providers.",
            provider_id
        ));
    }
    Ok(creds)
}

/// Resolve a provider's API key and origin base URL (scheme://host, path stripped).
/// `default_base_url` is used when the provider config has no base_url.
pub(crate) fn get_api_key_and_base_url(
    provider_id: &str,
    password: &str,
    default_base_url: &str,
) -> Result<(String, String), String> {
    let creds = get_api_key_checked(provider_id, password)?;
    let raw_url = creds.get_field("base_url").unwrap_or(default_base_url);
    let base_url = enforce_https(raw_url)?;
    let origin = extract_origin(&base_url);
    Ok((creds.require("api_key")?, origin))
}

/// Get the ARK API key and base URL for a provider.
pub(crate) fn get_ark_api_key_and_base_url(
    provider_id: &str,
    password: &str,
) -> Result<(String, String), String> {
    get_api_key_and_base_url(provider_id, password, DEFAULT_ARK_BASE_URL)
}

// ---------------------------------------------------------------------------
// Ark API HMAC-SHA256 V4 signing
// ---------------------------------------------------------------------------

const ARK_SERVICE: &str = "ark";
const DEFAULT_ARK_HOST: &str = "ark.cn-beijing.volcengineapi.com";
const ARK_CONTENT_TYPE: &str = "application/json";
const ARK_PATH: &str = "/";
const ARK_VERSION: &str = "2024-01-01";

fn hash_sha256(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

fn hmac_sha256(key: &[u8], content: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
    mac.update(content.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// URL-encode a query value (like Python's urllib.parse.quote with safe="-_.~").
pub(crate) fn url_encode_query(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char)
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

/// Normalize query params: sort by key, URL-encode, join with &.
fn norm_query(params: &HashMap<String, String>) -> String {
    let mut keys: Vec<&String> = params.keys().collect();
    keys.sort();
    let parts: Vec<String> = keys
        .iter()
        .map(|k| format!("{}={}", url_encode_query(k), url_encode_query(&params[*k])))
        .collect();
    parts.join("&")
}

/// Sign and send a request to the Ark API (HMAC-SHA256 V4).
pub(crate) async fn ark_signed_request(
    client: &Client,
    provider_id: &str,
    password: &str,
    action: &str,
    method: &str,
    extra_query: Option<HashMap<String, String>>,
    body: &str,
) -> Result<serde_json::Value, String> {
    let creds = get_credentials_internal(provider_id, password)?;

    let signing_ak = creds.require("ak")?;
    let signing_sk = creds.require("sk")?;
    let region = creds.get_or("region", super::util::DEFAULT_REGION);

    let ark_host = creds
        .get_field("asset_endpoint")
        .map(super::util::strip_url_scheme)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT_ARK_HOST.to_string());

    let now = Utc::now();
    let x_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = x_date[..8].to_string();
    let x_content_sha256 = hash_sha256(body);

    // Build query params
    let mut query = HashMap::new();
    query.insert("Action".to_string(), action.to_string());
    query.insert("Version".to_string(), ARK_VERSION.to_string());
    if let Some(extra) = extra_query {
        for (k, v) in extra {
            query.insert(k, v);
        }
    }

    let canonical_query = norm_query(&query);

    // Canonical request
    let signed_headers = "content-type;host;x-content-sha256;x-date";
    let canonical_headers = format!(
        "content-type:{}\nhost:{}\nx-content-sha256:{}\nx-date:{}\n",
        ARK_CONTENT_TYPE, ark_host, x_content_sha256, x_date
    );
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        ARK_PATH,
        canonical_query,
        canonical_headers,
        signed_headers,
        x_content_sha256
    );

    let hashed_canonical = hash_sha256(&canonical_request);
    let credential_scope = format!("{}/{}/{}/request", short_date, region, ARK_SERVICE);

    // String to sign
    let string_to_sign = format!(
        "HMAC-SHA256\n{}\n{}\n{}",
        x_date, credential_scope, hashed_canonical
    );

    // Signing key chain
    let k_date = hmac_sha256(signing_sk.as_bytes(), &short_date);
    let k_region = hmac_sha256(&k_date, &region);
    let k_service = hmac_sha256(&k_region, ARK_SERVICE);
    let k_signing = hmac_sha256(&k_service, "request");
    let signature = hex::encode(hmac_sha256(&k_signing, &string_to_sign));

    // Authorization header
    let authorization = format!(
        "HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        signing_ak, credential_scope, signed_headers, signature
    );

    // Build URL with query params
    let url = format!("https://{}{}", ark_host, ARK_PATH);
    let mut req_builder = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    req_builder = req_builder
        .query(&query)
        .header("Host", &ark_host)
        .header("X-Content-Sha256", &x_content_sha256)
        .header("X-Date", &x_date)
        .header("Content-Type", ARK_CONTENT_TYPE)
        .header("Authorization", &authorization);

    if !body.is_empty() {
        req_builder = req_builder.body(body.to_string());
    }

    let resp = req_builder
        .send()
        .await
        .map_err(|e| format!("Ark API request failed: {}", e))?;

    let status = resp.status();
    let resp_body = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("Ark API error {}: {}", status, resp_body));
    }

    serde_json::from_str(&resp_body)
        .map_err(|e| format!("Invalid JSON response from Ark API: {}", e))
}

// ---------------------------------------------------------------------------
// Tauri commands: Video generation
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn seedance_create_task(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    params: CreateTaskParams,
) -> Result<CreateTaskResult, String> {
    let (api_key, base_url) = get_ark_api_key_and_base_url(&provider_id, &password)?;

    let mut payload = serde_json::json!({
        "model": params.model,
        "content": params.content,
        "resolution": params.resolution,
        "ratio": params.ratio,
        "duration": params.duration,
        "generate_audio": params.generate_audio
    });

    if let Some(return_last_frame) = params.return_last_frame {
        payload["return_last_frame"] = serde_json::json!(return_last_frame);
    }

    let resp = state
        .http
        .post(format!("{}/api/v3/contents/generations/tasks", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("API error {}: {}", status, body));
    }

    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(CreateTaskResult {
        task_id: data
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        status: data
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        created_at: data
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

#[tauri::command]
pub async fn seedance_get_task_status(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    task_id: String,
) -> Result<TaskStatusResult, String> {
    let (api_key, base_url) = get_ark_api_key_and_base_url(&provider_id, &password)?;

    let resp = state
        .http
        .get(format!(
            "{}/api/v3/contents/generations/tasks/{}",
            base_url, task_id
        ))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("API error {}: {}", status, body));
    }

    parse_task_status_response(&body, &task_id)
}

pub fn parse_single_task_status_from_value(
    data: &serde_json::Value,
    task_id: &str,
) -> TaskStatusResult {
    let status = data
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let result_url = data
        .get("content")
        .and_then(|c| c.get("video_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Extract last frame URL from content
    let last_frame_url = data
        .get("content")
        .and_then(|c| c.get("last_frame_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let error = data.get("error").cloned();

    TaskStatusResult {
        task_id: task_id.to_string(),
        status,
        result_url,
        last_frame_url,
        error,
    }
}

pub fn parse_task_status_response(body: &str, task_id: &str) -> Result<TaskStatusResult, String> {
    let data: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    Ok(parse_single_task_status_from_value(&data, task_id))
}

// ---------------------------------------------------------------------------
// Tauri commands: File upload (base64 conversion, local only)
// ---------------------------------------------------------------------------

/// Compute SHA-256 hex digest.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Compute SHA-256 hex digest of a file by streaming (avoids loading entire file into memory).
pub fn sha256_hex_file(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut reader = std::io::BufReader::new(file);
    let mut buf = [0u8; 8192];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Infer content type from file extension.
pub fn infer_content_type(path: &str) -> &'static str {
    match path.to_lowercase().rsplit('.').next() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("mp4") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Tauri commands: Asset Groups (HMAC-signed Ark API)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn seedance_create_asset_group(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    name: String,
    description: Option<String>,
    group_type: Option<String>,
    project_name: Option<String>,
) -> Result<AssetGroup, String> {
    let desc = description.unwrap_or_default();
    let gt = group_type.unwrap_or_else(|| "AIGC".to_string());
    let pn = project_name.unwrap_or_else(|| "default".to_string());

    let body = serde_json::json!({
        "Name": name,
        "Description": desc,
        "GroupType": gt,
        "ProjectName": pn,
    })
    .to_string();

    let resp = ark_signed_request(
        &state.http,
        &provider_id,
        &password,
        "CreateAssetGroup",
        "POST",
        None,
        &body,
    )
    .await?;
    let result = resp.get("Result").cloned().unwrap_or_default();

    Ok(AssetGroup {
        group_id: result
            .get("Id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        name,
        description: desc,
        group_type: gt,
        created_at: Utc::now().to_rfc3339(),
        updated_at: None,
    })
}

#[tauri::command]
pub async fn seedance_list_asset_groups(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    project_name: Option<String>,
) -> Result<AssetGroupListResult, String> {
    let pn = project_name.unwrap_or_else(|| "default".to_string());
    let body = serde_json::json!({
        "Filter": { "GroupType": "AIGC" },
        "PageNumber": 1,
        "PageSize": 100,
        "ProjectName": pn
    })
    .to_string();

    let resp = ark_signed_request(
        &state.http,
        &provider_id,
        &password,
        "ListAssetGroups",
        "POST",
        None,
        &body,
    )
    .await?;
    let items = resp
        .get("Result")
        .and_then(|r| r.get("Items"))
        .and_then(|i| i.as_array())
        .cloned()
        .unwrap_or_default();

    let groups: Vec<AssetGroup> = items
        .iter()
        .map(|item| AssetGroup {
            group_id: item
                .get("Id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            name: item
                .get("Name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            description: item
                .get("Description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            group_type: item
                .get("GroupType")
                .and_then(|v| v.as_str())
                .unwrap_or("AIGC")
                .to_string(),
            created_at: item
                .get("CreateTime")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            updated_at: item
                .get("UpdateTime")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        })
        .collect();

    Ok(AssetGroupListResult {
        total: groups.len() as i32,
        groups,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands: Assets (HMAC-signed Ark API)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn seedance_list_assets(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    group_id: String,
    asset_type: Option<String>,
    project_name: Option<String>,
) -> Result<AssetListResult, String> {
    let pn = project_name.unwrap_or_else(|| "default".to_string());
    let mut filter = serde_json::json!({
        "GroupIds": [group_id],
        "GroupType": "AIGC"
    });
    if let Some(at) = asset_type {
        filter["AssetType"] = serde_json::json!(at);
    }

    let body = serde_json::json!({
        "Filter": filter,
        "PageNumber": 1,
        "PageSize": 100,
        "ProjectName": pn
    })
    .to_string();

    let resp = ark_signed_request(
        &state.http,
        &provider_id,
        &password,
        "ListAssets",
        "POST",
        None,
        &body,
    )
    .await?;
    let items = resp
        .get("Result")
        .and_then(|r| r.get("Items"))
        .and_then(|i| i.as_array())
        .cloned()
        .unwrap_or_default();

    let mut assets: Vec<AssetItem> = Vec::new();

    for item in &items {
        assets.push(AssetItem {
            asset_id: item
                .get("Id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            group_id: item
                .get("GroupId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            url: item
                .get("URL")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            asset_type: item
                .get("AssetType")
                .and_then(|v| v.as_str())
                .unwrap_or("Image")
                .to_string(),
            project_name: item
                .get("ProjectName")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string(),
            name: item
                .get("Name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            created_at: item
                .get("CreateTime")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            status: item
                .get("Status")
                .and_then(|v| v.as_str())
                .unwrap_or("Processing")
                .to_string(),
            error_message: item
                .get("Error")
                .and_then(|e| e.get("Message"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }

    Ok(AssetListResult {
        total: assets.len() as i32,
        assets,
    })
}

#[tauri::command]
pub async fn seedance_get_asset(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    asset_id: String,
    project_name: Option<String>,
) -> Result<AssetItem, String> {
    let pn = project_name.unwrap_or_else(|| "default".to_string());
    get_asset_detail(&state.http, &provider_id, &password, &asset_id, &pn).await
}

pub(crate) async fn get_asset_detail(
    client: &Client,
    provider_id: &str,
    password: &str,
    asset_id: &str,
    project_name: &str,
) -> Result<AssetItem, String> {
    let body = serde_json::json!({ "Id": asset_id, "ProjectName": project_name }).to_string();
    let resp = ark_signed_request(
        client,
        provider_id,
        password,
        "GetAsset",
        "POST",
        None,
        &body,
    )
    .await?;
    let result = resp.get("Result").cloned().unwrap_or_default();

    let error_msg = result
        .get("Error")
        .and_then(|e| e.get("Message"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(AssetItem {
        asset_id: result
            .get("Id")
            .and_then(|v| v.as_str())
            .unwrap_or(asset_id)
            .to_string(),
        group_id: result
            .get("GroupId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        url: result
            .get("URL")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        asset_type: result
            .get("AssetType")
            .and_then(|v| v.as_str())
            .unwrap_or("Image")
            .to_string(),
        project_name: result
            .get("ProjectName")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string(),
        name: result
            .get("Name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        created_at: result
            .get("CreateTime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        status: result
            .get("Status")
            .and_then(|v| v.as_str())
            .unwrap_or("Processing")
            .to_string(),
        error_message: error_msg,
    })
}

#[tauri::command]
pub async fn seedance_delete_asset(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    asset_id: String,
    project_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let pn = project_name.unwrap_or_else(|| "default".to_string());
    let body = serde_json::json!({ "Id": asset_id, "ProjectName": pn }).to_string();
    let _resp = ark_signed_request(
        &state.http,
        &provider_id,
        &password,
        "DeleteAsset",
        "POST",
        None,
        &body,
    )
    .await?;
    Ok(serde_json::json!({ "success": true, "message": "Deleted" }))
}

// ---------------------------------------------------------------------------
// Tauri command: Create Asset (HMAC-signed Ark API)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct CreateAssetResult {
    pub asset_id: String,
    pub status: String,
}

#[tauri::command]
pub async fn seedance_create_asset(
    state: tauri::State<'_, SeedanceState>,
    provider_id: String,
    password: String,
    group_id: String,
    url: String,
    asset_type: String,
    project_name: Option<String>,
) -> Result<CreateAssetResult, String> {
    let pname = project_name.unwrap_or_else(|| "default".to_string());

    let body = serde_json::json!({
        "GroupId": group_id,
        "URL": url,
        "AssetType": asset_type,
        "ProjectName": pname,
    })
    .to_string();

    let resp = ark_signed_request(
        &state.http,
        &provider_id,
        &password,
        "CreateAsset",
        "POST",
        None,
        &body,
    )
    .await?;
    let result = resp.get("Result").cloned().unwrap_or_default();

    let asset_id = result
        .get("Id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let status = result
        .get("Status")
        .and_then(|v| v.as_str())
        .unwrap_or("Processing")
        .to_string();

    Ok(CreateAssetResult { asset_id, status })
}

// ---------------------------------------------------------------------------
// Tauri command: Download generation video to project directory
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct DownloadResult {
    pub file_path: String,
    pub file_size: u64,
}

#[tauri::command]
pub async fn download_generation_video(
    state: tauri::State<'_, SeedanceState>,
    url: String,
    project_path: String,
    generation_id: String,
) -> Result<DownloadResult, String> {
    if !url.starts_with("https://") {
        return Err(format!("Only HTTPS URLs are allowed: {}", url));
    }

    let output_dir = std::path::Path::new(&project_path)
        .join("Generated")
        .join("Video");
    let output_path = output_dir.join(format!("{}.mp4", generation_id));

    let response = state
        .http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Download failed with status {}: {}",
            status,
            response.text().await.unwrap_or_default()
        ));
    }

    // Check content-length before downloading
    if let Some(len) = response.content_length() {
        if len > MAX_DOWNLOAD_SIZE {
            return Err(format!(
                "Video too large: {} bytes (max {} MB)",
                len,
                MAX_DOWNLOAD_SIZE / 1024 / 1024
            ));
        }
    }

    // Stream download + mkdir + write in a single spawn_blocking call
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if bytes.len() as u64 > MAX_DOWNLOAD_SIZE {
        return Err(format!(
            "Video too large: {} bytes (max {} MB)",
            bytes.len(),
            MAX_DOWNLOAD_SIZE / 1024 / 1024
        ));
    }

    let file_size = bytes.len() as u64;
    let output_path_clone = output_path.clone();
    let output_dir_clone = output_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&output_dir_clone)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
        std::fs::write(&output_path_clone, &bytes)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(DownloadResult {
        file_path: output_path.to_string_lossy().to_string(),
        file_size,
    })
}

// ---------------------------------------------------------------------------
// Tauri command: Download generation image to project directory
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn download_generation_image(
    state: tauri::State<'_, SeedanceState>,
    url: String,
    project_path: String,
    generation_id: String,
) -> Result<DownloadResult, String> {
    if !url.starts_with("https://") {
        return Err(format!("Only HTTPS URLs are allowed: {}", url));
    }

    let output_dir = std::path::Path::new(&project_path)
        .join("Generated")
        .join("Image");
    let output_path = output_dir.join(format!("{}.jpg", generation_id));

    let response = state
        .http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Download failed with status {}: {}",
            status,
            response.text().await.unwrap_or_default()
        ));
    }

    // Check content-length before downloading
    if let Some(len) = response.content_length() {
        if len > MAX_DOWNLOAD_SIZE {
            return Err(format!(
                "Image too large: {} bytes (max {} MB)",
                len,
                MAX_DOWNLOAD_SIZE / 1024 / 1024
            ));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if bytes.len() as u64 > MAX_DOWNLOAD_SIZE {
        return Err(format!(
            "Image too large: {} bytes (max {} MB)",
            bytes.len(),
            MAX_DOWNLOAD_SIZE / 1024 / 1024
        ));
    }

    let file_size = bytes.len() as u64;
    let output_path_clone = output_path.clone();
    let output_dir_clone = output_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&output_dir_clone)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
        std::fs::write(&output_path_clone, &bytes)
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(DownloadResult {
        file_path: output_path.to_string_lossy().to_string(),
        file_size,
    })
}
