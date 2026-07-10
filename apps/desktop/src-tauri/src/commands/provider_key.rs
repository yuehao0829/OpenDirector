use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Credentials stored encrypted in a local file, one per provider.
///
/// Pure key-value bag: the storage layer is completely field-name-agnostic.
/// Each provider declares its own credential fields via a type definition,
/// and consumers read them with [`require`], [`get_or_empty`], or
/// [`get_field`]. Unknown keys are preserved as-is (transparent map), so
/// adding a provider never requires a backend change — there is no typed
/// struct to extend, no alias, no migration.
///
/// All values are strings. The frontend builds the credentials object from
/// its declarative field state, so a serialized credentials JSON is always a
/// flat `{"key": "value", ...}` object that round-trips through this map.
///
/// [`require`]: Credentials::require
/// [`get_or_empty`]: Credentials::get_or_empty
/// [`get_field`]: Credentials::get_field
#[derive(Serialize, Clone, Debug, Default)]
pub struct Credentials(HashMap<String, String>);

// Manual Deserialize (instead of `#[serde(transparent)]`) so legacy `.enc`
// files written by the pre-KV typed `Credentials` struct parse cleanly: that
// struct serialized absent `Option<String>` fields as JSON `null`, which a
// pure `HashMap<String, String>` rejects. Coerce `null` → `""` (and stringify
// any non-string scalar) so old stores migrate transparently instead of
// erroring — see `legacy_typed_enc_with_null_option_fields_parses`.
impl<'de> Deserialize<'de> for Credentials {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let map = HashMap::<String, serde_json::Value>::deserialize(deserializer)?;
        let creds = map
            .into_iter()
            .map(|(key, value)| {
                let string_value = match value {
                    serde_json::Value::String(s) => s,
                    serde_json::Value::Null => String::new(),
                    other => other.to_string(),
                };
                (key, string_value)
            })
            .collect();
        Ok(Credentials(creds))
    }
}

impl Credentials {
    /// Returns a non-empty (trimmed) value for `key`, or an error naming the
    /// missing field. Use for required credentials.
    pub fn require(&self, key: &str) -> Result<String, String> {
        self.0
            .get(key)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Missing required credential: {}", key))
    }

    /// Returns the value for `key`, or an empty string when absent.
    /// Use for optional credentials.
    pub fn get_or_empty(&self, key: &str) -> String {
        self.0.get(key).cloned().unwrap_or_default()
    }

    /// Returns `true` if `key` is present and non-empty after trimming — the
    /// same predicate [`require`] checks, but as a borrowed bool with no
    /// allocation. Use when you only need to validate presence, not the value.
    ///
    /// [`require`]: Credentials::require
    pub fn is_present(&self, key: &str) -> bool {
        self.0.get(key).map(|s| !s.trim().is_empty()).unwrap_or(false)
    }

    /// Returns a reference to the value for `key`, or `None` when absent.
    pub fn get_field(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(|s| s.as_str())
    }

    /// Returns the value for `key`, or `default` (as an owned `String`) when
    /// the key is absent or empty. Use for optional credentials with a fallback.
    pub fn get_or(&self, key: &str, default: &str) -> String {
        let value = self.get_or_empty(key);
        if value.is_empty() {
            default.to_string()
        } else {
            value
        }
    }
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
    // save_provider_credentials). The pure-KV map accepts any object whose
    // values are strings; this catches malformed JSON or non-string values
    // from a bad update before re-encrypting.
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
    fn kv_round_trip() {
        // transparent → serializes as a bare object, not a named wrapper.
        let mut map = HashMap::new();
        map.insert("api_key".to_string(), "sk-test".to_string());
        map.insert("base_url".to_string(), "https://example.com".to_string());
        let creds = Credentials(map);

        let json = serde_json::to_string(&creds).expect("serialize");
        assert!(json.starts_with('{'), "transparent map emits a bare object");
        assert!(!json.contains("map"), "no wrapper key leaked: {}", json);

        let back: Credentials = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.require("api_key").unwrap(), "sk-test");
        assert_eq!(back.get_or_empty("base_url"), "https://example.com");
    }

    #[test]
    fn require_missing_field_errors() {
        let creds = Credentials::default();
        let err = creds.require("api_key").unwrap_err();
        assert!(err.contains("api_key"), "error names the field: {}", err);

        // A whitespace-only value is treated as missing (require trims).
        let mut map = HashMap::new();
        map.insert("api_key".to_string(), "   ".to_string());
        let creds = Credentials(map);
        assert!(creds.require("api_key").is_err());
    }

    #[test]
    fn is_present_mirrors_require_predicate() {
        // `is_present` is the non-allocating "present after trim" check that
        // `get_api_key_checked` uses in place of `require` (which would
        // allocate a `String` only to discard it). It must agree with
        // `require` on every input so validation is unchanged.
        let mut map = HashMap::new();
        map.insert("api_key".to_string(), "sk-test".to_string());
        map.insert("blank".to_string(), "   ".to_string());
        let creds = Credentials(map);

        assert!(creds.is_present("api_key"));
        assert!(!creds.is_present("blank"), "whitespace-only is not present");
        assert!(!creds.is_present("missing"));

        // `require` agrees on every case.
        assert!(creds.require("api_key").is_ok());
        assert!(creds.require("blank").is_err());
        assert!(creds.require("missing").is_err());
    }

    #[test]
    fn extra_fields_preserved() {
        // Storage is field-name-agnostic: unknown keys survive a round trip.
        let json = r#"{"api_key":"sk","custom_field":"value","another":"x"}"#;
        let creds: Credentials = serde_json::from_str(json).expect("parse");
        assert_eq!(creds.get_field("custom_field"), Some("value"));
        assert_eq!(creds.get_or_empty("another"), "x");

        let out = serde_json::to_string(&creds).expect("serialize");
        assert!(out.contains("custom_field"), "unknown key preserved on write");
    }

    #[test]
    fn legacy_typed_enc_with_null_option_fields_parses() {
        // A pre-KV `.enc` stored the typed Credentials struct, whose
        // `Option<String>` fields (`endpoint_id`, `tos_endpoint`, `base_url`,
        // ...) serialized as JSON `null` when absent (no `skip_serializing_if`).
        // The pure-KV Credentials must tolerate these nulls (coercing to "")
        // instead of failing "invalid type: null, expected a string" — which
        // is what made `update_provider_credentials` reject an old seedance
        // instance and surface as "保存凭证失败" in the Edit dialog.
        let json = r#"{"api_key":"sk","base_url":"https://ark.cn-beijing.volces.com","ak":"","sk":"","region":"","endpoint_id":null,"tos_endpoint":null,"tos_bucket":null,"asset_endpoint":null,"asset_project":null,"asset_group_name":null,"asset_group_id":null}"#;
        let creds: Credentials =
            serde_json::from_str(json).expect("legacy .enc with nulls must parse");
        assert_eq!(creds.require("api_key").unwrap(), "sk");
        assert_eq!(
            creds.get_or_empty("base_url"),
            "https://ark.cn-beijing.volces.com"
        );
        // null-coerced fields are empty strings, not errors.
        assert_eq!(creds.get_or_empty("endpoint_id"), "");
        assert_eq!(creds.get_or_empty("tos_endpoint"), "");

        // Re-serializing stays a flat string map (no null leaks back out).
        let out = serde_json::to_string(&creds).expect("serialize");
        assert!(!out.contains("null"), "null must not leak back: {}", out);
        assert!(out.contains(r#""endpoint_id":""#), "null coerced to empty string");
    }

    #[test]
    fn update_merge_preserves_all_keys() {
        // Mirrors update_provider_credentials: shallow-merge a JSON object,
        // then parse the merged result. Untouched keys must survive.
        let mut existing: serde_json::Value = serde_json::json!({
            "api_key": "old-key",
            "base_url": "https://old.example.com",
            "ak": "old-ak"
        });
        let updates: serde_json::Value = serde_json::json!({ "base_url": "https://new.example.com" });
        if let (Some(obj), Some(upd)) = (existing.as_object_mut(), updates.as_object()) {
            for (k, v) in upd {
                obj.insert(k.clone(), v.clone());
            }
        }

        let merged_str = serde_json::to_string(&existing).unwrap();
        let creds: Credentials = serde_json::from_str(&merged_str).expect("parse merged");
        assert_eq!(creds.require("api_key").unwrap(), "old-key");
        assert_eq!(creds.get_or_empty("base_url"), "https://new.example.com");
        assert_eq!(creds.get_or_empty("ak"), "old-ak");
    }
}
