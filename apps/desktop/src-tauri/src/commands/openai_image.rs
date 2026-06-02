use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::provider_key::get_credentials_internal;
use super::util::{AuthMode, resolve_auth_query_key, MAX_DOWNLOAD_SIZE};

const DEFAULT_OPENAI_IMAGE_ENDPOINT: &str = "https://api.openai.com/v1/images/generations";

#[derive(Deserialize, Debug)]
pub struct OpenAiImageGenerationParams {
    pub provider_id: String,
    pub password: String,
    pub task_id: String,
    pub project_path: String,
    pub model: String,
    pub prompt: String,
    pub n: Option<u8>,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub output_format: Option<String>,
    pub background: Option<String>,
    pub moderation: Option<String>,
    pub output_compression: Option<u8>,
    pub user: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct OpenAiImageGenerationResult {
    pub file_path: String,
    pub file_size: u64,
    pub mime_type: String,
    pub output_format: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created: Option<i64>,
    pub usage: Option<serde_json::Value>,
    pub revised_prompt: Option<String>,
}

#[derive(Deserialize)]
struct ImagesResponse {
    created: Option<i64>,
    data: Option<Vec<ImageItem>>,
    usage: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ImageItem {
    b64_json: Option<String>,
    revised_prompt: Option<String>,
}

#[tauri::command]
pub async fn openai_generate_image(
    state: tauri::State<'_, super::seedance_api::SeedanceState>,
    params: OpenAiImageGenerationParams,
) -> Result<OpenAiImageGenerationResult, String> {
    generate_image(&state.http, params).await
}

async fn generate_image(
    client: &Client,
    params: OpenAiImageGenerationParams,
) -> Result<OpenAiImageGenerationResult, String> {
    let creds = get_credentials_internal(&params.provider_id, &params.password)?;

    let auth_mode = creds.auth_mode.unwrap_or_default();
    let use_query_auth = auth_mode == AuthMode::QueryParam;

    let api_key = creds.ark_api_key;
    if api_key.trim().is_empty() {
        return Err("OpenAI API key is empty".to_string());
    }

    let endpoint = normalize_images_endpoint(creds.base_url.as_deref())?;

    let output_format = params
        .output_format
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let extension = output_format_to_extension(&output_format)?;

    let mut payload = serde_json::json!({
        "model": params.model,
        "prompt": params.prompt,
        "n": params.n.unwrap_or(1),
    });

    insert_string(&mut payload, "size", params.size.as_deref());
    insert_string(&mut payload, "quality", params.quality.as_deref());
    insert_string(&mut payload, "output_format", Some(&output_format));
    insert_string(&mut payload, "background", params.background.as_deref());
    insert_string(&mut payload, "moderation", params.moderation.as_deref());
    insert_string(&mut payload, "user", params.user.as_deref());
    if let Some(compression) = params.output_compression {
        payload["output_compression"] = serde_json::json!(compression);
    }

    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json");

    if use_query_auth {
        let query_key = resolve_auth_query_key(creds.auth_query_key.as_deref());
        req = req.query(&[(query_key, &api_key)]);
    } else {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let resp = req
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("OpenAI image request failed: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OpenAI image API error {}: {}", status, body));
    }

    let parsed: ImagesResponse =
        serde_json::from_str(&body).map_err(|e| format!("Invalid OpenAI image response: {}", e))?;
    let image = parsed
        .data
        .as_ref()
        .and_then(|items| items.first())
        .ok_or_else(|| "OpenAI image response did not include image data".to_string())?;
    let b64 = image
        .b64_json
        .as_deref()
        .ok_or_else(|| "OpenAI image response did not include b64_json".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Failed to decode generated image: {}", e))?;

    if bytes.len() as u64 > MAX_DOWNLOAD_SIZE {
        return Err(format!(
            "Image too large: {} bytes (max {} MB)",
            bytes.len(),
            MAX_DOWNLOAD_SIZE / 1024 / 1024
        ));
    }

    let output_dir = PathBuf::from(&params.project_path)
        .join("Generated")
        .join("Image");
    let output_path = output_dir.join(format!("{}.{}", params.task_id, extension));

    let dimensions = image_dimensions_from_memory(&bytes);
    let file_size = bytes.len() as u64;

    let output_path_clone = output_path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create image directory: {}", e))?;
        std::fs::write(&output_path_clone, &bytes)
            .map_err(|e| format!("Failed to write generated image: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(OpenAiImageGenerationResult {
        file_path: output_path.to_string_lossy().to_string(),
        file_size,
        mime_type: output_format_to_mime(&output_format).to_string(),
        output_format,
        width: dimensions.map(|(w, _)| w),
        height: dimensions.map(|(_, h)| h),
        created: parsed.created,
        usage: parsed.usage,
        revised_prompt: image.revised_prompt.clone(),
    })
}

fn normalize_images_endpoint(raw: Option<&str>) -> Result<String, String> {
    let value = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_OPENAI_IMAGE_ENDPOINT);
    let with_scheme = if value.starts_with("https://") {
        value.to_string()
    } else if value.starts_with("http://") {
        return Err(format!("HTTP URLs are not allowed for security reasons: {}", value));
    } else {
        format!("https://{}", value)
    };

    let trimmed = with_scheme.trim_end_matches('/');

    if trimmed.ends_with("/images/generations") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{}/images/generations", trimmed))
    }
}

fn insert_string(payload: &mut serde_json::Value, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|s| !s.is_empty()) {
        payload[key] = serde_json::json!(value);
    }
}

fn output_format_to_extension(format: &str) -> Result<&'static str, String> {
    match format {
        "png" => Ok("png"),
        "jpeg" => Ok("jpg"),
        "webp" => Ok("webp"),
        other => Err(format!("Unsupported image output format: {}", other)),
    }
}

fn output_format_to_mime(format: &str) -> &'static str {
    match format {
        "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn image_dimensions_from_memory(bytes: &[u8]) -> Option<(u32, u32)> {
    use std::io::Cursor;
    let cursor = Cursor::new(bytes);
    image::ImageReader::new(cursor)
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}
