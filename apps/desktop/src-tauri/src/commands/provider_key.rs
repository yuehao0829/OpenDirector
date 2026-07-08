use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::util::AuthMode;

/// Credentials stored encrypted in local file per provider.
///
/// `#[serde(default)]` at the struct level means every field uses its
/// `Default::default()` when missing from the JSON. This lets legacy `.enc`
/// files written before a field existed (e.g. `api_key` absent from the
/// original Volcengine-only saves) parse cleanly instead of failing with
/// "missing field". Missing strings default to `""`, and the API-key
/// consumers (`get_api_key_and_base_url`) treat an empty key as a clear
/// "not configured" error rather than a parse failure.
///
/// `api_key` carries an `alias = "ark_api_key"` so `.enc` files written by
/// the previous app version (which serialized this field as `ark_api_key`)
/// deserialize correctly — without the alias the rename would silently
/// discard every existing user's saved API key.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Credentials {
    /// Provider API key used as Bearer token (or query-param value) for the
    /// provider's generation APIs. Shared across all API-key providers
    /// (Seedance / MiniMax / GPT-Image). Volcengine leaves this empty and
    /// authenticates via the ak/sk signing fields below.
    #[serde(alias = "ark_api_key")]
    pub api_key: String,
    /// Access Key ID for HMAC-SHA256 signing of asset library APIs.
    pub ak: String,
    /// Secret Access Key for HMAC-SHA256 signing of asset library APIs.
    pub sk: String,
    pub region: String,
    pub endpoint_id: Option<String>,
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<AuthMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_query_key: Option<String>,
    pub tos_endpoint: Option<String>,
    pub tos_bucket: Option<String>,
    pub asset_endpoint: Option<String>,
    pub asset_project: Option<String>,
    pub asset_group_name: Option<String>,
    pub asset_group_id: Option<String>,
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

    // Validate the merged result parses as Credentials (symmetric with
    // save_provider_credentials). With `#[serde(default)]` on the struct,
    // missing fields no longer fail here — they default to "" / None and are
    // caught later by `get_api_key_checked` when the api_key is empty. This
    // check still catches type mismatches or malformed JSON from a bad update.
    let _creds: Credentials = serde_json::from_str(&merged_json)
        .map_err(|e| format!("Failed to parse merged credentials: {}", e))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_ark_api_key_alias_deserializes_into_api_key() {
        // A .enc file written by the previous app version serialized the key
        // as `ark_api_key`. The rename to `api_key` must not silently discard
        // it — the serde alias should map the old name onto the new field.
        let json = r#"{"ark_api_key":"sk-legacy","ak":"","sk":"","region":""}"#;
        let creds: Credentials = serde_json::from_str(json).expect("legacy .enc must parse");
        assert_eq!(creds.api_key, "sk-legacy");
    }

    #[test]
    fn missing_api_key_defaults_to_empty() {
        // A Volcengine-only .enc file (no api_key) must parse with api_key = "".
        let json = r#"{"ak":"ak1","sk":"sk1","region":"cn-beijing"}"#;
        let creds: Credentials = serde_json::from_str(json).expect("volcengine .enc must parse");
        assert_eq!(creds.api_key, "");
        assert_eq!(creds.ak, "ak1");
    }

    #[test]
    fn new_api_key_field_deserializes_directly() {
        let json = r#"{"api_key":"sk-new","ak":"","sk":"","region":""}"#;
        let creds: Credentials = serde_json::from_str(json).expect("new .enc must parse");
        assert_eq!(creds.api_key, "sk-new");
    }
}
