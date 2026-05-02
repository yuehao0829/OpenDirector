use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Credentials stored encrypted in local file per provider.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Credentials {
    /// Direct ARK API Key used as Bearer token for video generation APIs.
    pub ark_api_key: String,
    /// Access Key ID for HMAC-SHA256 signing of asset library APIs.
    pub ak: String,
    /// Secret Access Key for HMAC-SHA256 signing of asset library APIs.
    pub sk: String,
    pub region: String,
    pub endpoint_id: Option<String>,
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tos_endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tos_bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_project: Option<String>,
    pub asset_group_name: Option<String>,
    pub asset_group_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CredentialValidation {
    pub valid: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Encrypted local file storage (replaces OS keyring)
// ---------------------------------------------------------------------------

/// Returns the directory where encrypted provider credential files are stored.
fn credentials_dir() -> Result<PathBuf, String> {
    Ok(dirs::data_dir()
        .ok_or("Cannot determine data directory")?
        .join("com.opendirector")
        .join("credentials"))
}

/// Ensures the credentials directory exists (called only before writes).
fn ensure_credentials_dir() -> Result<PathBuf, String> {
    let dir = credentials_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create credentials directory: {}", e))?;
    Ok(dir)
}

/// Returns the encrypted credential file path for a given provider.
fn credential_file_path(provider_id: &str) -> Result<PathBuf, String> {
    Ok(credentials_dir()?.join(format!("{}.enc", provider_id)))
}

/// Check if credentials exist for a provider.
#[tauri::command]
pub fn has_provider_credentials(provider_id: String) -> Result<bool, String> {
    let path = credential_file_path(&provider_id)?;
    Ok(path.exists())
}

/// Save credentials encrypted to a local file.
#[tauri::command]
pub fn save_provider_credentials(
    provider_id: String,
    credentials_json: String,
    password: String,
) -> Result<(), String> {
    let _creds: Credentials = serde_json::from_str(&credentials_json)
        .map_err(|e| format!("Invalid credentials JSON: {}", e))?;

    let encrypted = crate::crypto::encrypt(credentials_json.as_bytes(), &password)?;

    ensure_credentials_dir()?;
    let path = credential_file_path(&provider_id)?;
    let json = serde_json::to_string(&encrypted)
        .map_err(|e| format!("Failed to serialize encrypted data: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write credential file: {}", e))
}

/// Read and decrypt credentials from local file (internal use only).
pub fn get_credentials_internal(provider_id: &str, password: &str) -> Result<Credentials, String> {
    let path = credential_file_path(provider_id)?;
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read credential file: {}", e))?;
    let encrypted: crate::crypto::EncryptedPayload = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse encrypted data: {}", e))?;
    let decrypted = crate::crypto::decrypt(&encrypted, password)?;
    serde_json::from_slice(&decrypted).map_err(|e| format!("Failed to parse credentials: {}", e))
}

/// Delete credentials file.
#[tauri::command]
pub fn delete_provider_credentials(provider_id: String) -> Result<(), String> {
    let path = credential_file_path(&provider_id)?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete credential file: {}", e))?;
    }
    Ok(())
}

/// Read and decrypt credentials from local file (internal use only).

/// Validate credentials by testing the ARK API Key with a lightweight API call.
#[tauri::command]
pub async fn validate_provider_credentials(
    provider_id: String,
    password: String,
) -> Result<CredentialValidation, String> {
    let creds = match get_credentials_internal(&provider_id, &password) {
        Ok(c) => c,
        Err(e) => {
            return Ok(CredentialValidation {
                valid: false,
                message: format!("Credentials not found: {}", e),
            });
        }
    };

    let base_url = creds
        .base_url
        .as_deref()
        .unwrap_or("https://ark.cn-beijing.volces.com");

    let client = reqwest::Client::new();
    let result = client
        .get(format!(
            "{}/api/v3/contents/generations/tasks?limit=1",
            base_url
        ))
        .header("Authorization", format!("Bearer {}", creds.ark_api_key))
        .send()
        .await;

    match result {
        Ok(resp) => {
            let status = resp.status();
            // 200 (success) or 404 (empty list but auth worked) both mean valid credentials
            let is_valid = status.as_u16() == 200 || status.as_u16() == 404;
            Ok(CredentialValidation {
                valid: is_valid,
                message: if is_valid {
                    "Credentials valid".to_string()
                } else {
                    format!("Invalid credentials (HTTP {})", status)
                },
            })
        }
        Err(e) => Ok(CredentialValidation {
            valid: false,
            message: format!("Network error: {}", e),
        }),
    }
}

/// Update provider credentials in an existing encrypted credential file.
/// Decrypts with the old password, merges `updates_json` into the credential JSON,
/// then re-encrypts with a new random password and returns it.
#[tauri::command]
pub fn update_provider_credentials(
    provider_id: String,
    password: String,
    updates_json: String,
) -> Result<String, String> {
    let path = credential_file_path(&provider_id)?;
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read credential file: {}", e))?;
    let encrypted: crate::crypto::EncryptedPayload = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse encrypted data: {}", e))?;
    let decrypted = crate::crypto::decrypt(&encrypted, &password)?;

    let mut creds_value: serde_json::Value = serde_json::from_slice(&decrypted)
        .map_err(|e| format!("Failed to parse credentials: {}", e))?;
    let updates: serde_json::Value =
        serde_json::from_str(&updates_json).map_err(|e| format!("Invalid updates JSON: {}", e))?;

    let creds_map = creds_value
        .as_object_mut()
        .ok_or("Credentials JSON is not an object")?;
    let updates_map = updates.as_object().ok_or("Updates JSON is not an object")?;

    for (key, value) in updates_map {
        creds_map.insert(key.clone(), value.clone());
    }
    let merged_json = serde_json::to_string(&creds_value)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

    let new_password = {
        let mut buf = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut buf);
        hex::encode(buf)
    };
    let new_encrypted = crate::crypto::encrypt(merged_json.as_bytes(), &new_password)?;

    let out_json = serde_json::to_string(&new_encrypted)
        .map_err(|e| format!("Failed to serialize encrypted data: {}", e))?;
    std::fs::write(&path, out_json)
        .map_err(|e| format!("Failed to write credential file: {}", e))?;

    Ok(new_password)
}
