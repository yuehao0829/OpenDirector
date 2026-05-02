use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::commands::provider_key::get_credentials_internal;
use crate::crypto;

/// Multi-provider export file (format_version 2 or 3).
#[derive(Serialize, Clone, Debug)]
pub struct MultiProviderExportFile {
    pub format_version: u32,
    pub format_name: String,
    pub providers: Vec<ProviderExportEntry>,
    pub exported_at: String,
}

/// A single provider entry inside a multi-provider export (v3).
#[derive(Serialize, Clone, Debug)]
pub struct ProviderExportEntry {
    pub provider_id: String,
    pub type_id: String,
    pub provider_name: String,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub config: HashMap<String, String>,
    pub encrypted_credentials: crypto::EncryptedPayload,
}

/// A single provider entry inside a multi-provider export (v2).
#[derive(Deserialize, Clone, Debug)]
pub struct ProviderExportEntryV2 {
    pub provider_id: String,
    pub type_id: String,
    pub provider_name: String,
    pub config: Option<serde_json::Value>,
    #[serde(default)]
    pub extra_config: HashMap<String, String>,
    pub encrypted_credentials: crypto::EncryptedPayload,
}

/// Request to export one provider (from the frontend).
#[derive(Deserialize, Clone, Debug)]
pub struct ProviderExportRequest {
    pub provider_id: String,
    pub master_password: String,
    pub type_id: String,
    pub display_name: String,
    #[serde(default)]
    pub config: HashMap<String, String>,
}

/// Preview of a multi-provider export file.
#[derive(Serialize, Clone, Debug)]
pub struct MultiProviderExportPreview {
    pub format_version: u32,
    pub providers: Vec<ProviderExportFilePreview>,
    pub exported_at: String,
}

/// Preview of an export file (no secrets exposed).
#[derive(Serialize, Clone, Debug)]
pub struct ProviderExportFilePreview {
    pub format_version: u32,
    pub provider_id: String,
    pub type_id: String,
    pub provider_name: String,
    pub config: HashMap<String, String>,
    pub exported_at: String,
}

/// Result of importing a provider config.
#[derive(Serialize, Clone, Debug)]
pub struct ProviderImportResult {
    pub success: bool,
    pub provider_id: String,
    pub type_id: String,
    pub provider_name: String,
    pub credentials_saved: bool,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, String>>,
}

/// Request to import a specific provider from a multi-provider file.
#[derive(Deserialize, Clone, Debug)]
pub struct ImportEntry {
    pub provider_index: usize,
    pub master_password: String,
    pub save: bool,
    /// The local instance ID to save the .enc file under.
    /// If empty, falls back to the provider_id from the export file.
    #[serde(default)]
    pub target_provider_id: String,
}

/// Intermediate representation that handles both v2 and v3 formats.
#[derive(Deserialize, Clone, Debug)]
struct MultiProviderExportFileRaw {
    pub format_version: u32,
    #[allow(dead_code)]
    #[serde(default = "default_format_name")]
    pub format_name: String,
    pub providers: Vec<ProviderExportEntryV2>,
    pub exported_at: String,
}

fn default_format_name() -> String {
    "OpenDirector Provider Config".to_string()
}

/// Determine provider display name from provider_id.
fn provider_display_name(provider_id: &str) -> String {
    match provider_id {
        "seedance" => "Seedance 2.0".to_string(),
        other => other.to_string(),
    }
}

/// Merge v2 `config` (ProviderPublicConfig) and `extra_config` into a single HashMap.
fn merge_v2_config(
    config_val: &Option<serde_json::Value>,
    extra_config: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut merged = HashMap::new();

    if let Some(config) = config_val {
        if let Some(obj) = config.as_object() {
            for (key, val) in obj {
                match val {
                    serde_json::Value::String(s) if !s.is_empty() => {
                        merged.insert(key.clone(), s.clone());
                    }
                    _ => {} // skip null, numbers, booleans
                }
            }
        }
    }

    // extra_config takes precedence
    for (key, val) in extra_config {
        if !val.is_empty() {
            merged.insert(key.clone(), val.clone());
        }
    }

    merged
}

/// Export multiple provider configs to a single .odprovider file.
#[tauri::command]
pub async fn export_multi_provider_config(
    providers: Vec<ProviderExportRequest>,
    password: String,
    file_path: String,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("Export password is required".to_string());
    }

    let entries = tokio::task::spawn_blocking(move || {
        // Derive key once for all providers (PBKDF2 is the bottleneck)
        let (shared_salt, shared_key) = crypto::generate_and_derive(&password);

        let mut entries = Vec::new();
        for req in &providers {
            let creds = get_credentials_internal(&req.provider_id, &req.master_password)?;
            let creds_json = serde_json::to_string(&creds).map_err(|e| e.to_string())?;
            let mut encrypted = crypto::encrypt_with_key(&shared_key, creds_json.as_bytes())?;
            encrypted.salt = shared_salt.clone();
            entries.push(ProviderExportEntry {
                provider_id: req.provider_id.clone(),
                type_id: req.type_id.clone(),
                provider_name: if req.display_name.is_empty() {
                    provider_display_name(&req.provider_id)
                } else {
                    req.display_name.clone()
                },
                config: req.config.clone(),
                encrypted_credentials: encrypted,
            });
        }
        Result::<Vec<ProviderExportEntry>, String>::Ok(entries)
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))??;

    let export = MultiProviderExportFile {
        format_version: 3,
        format_name: default_format_name(),
        providers: entries,
        exported_at: Utc::now().to_rfc3339(),
    };

    let json = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        std::fs::write(&file_path, json).map_err(|e| format!("Failed to write file: {}", e))
    })
    .await
    .map_err(|e| format!("Write task panicked: {}", e))?
}

/// Verify a multi-provider export file — returns preview without decrypting.
#[tauri::command]
pub async fn verify_multi_provider_config(
    file_path: String,
) -> Result<MultiProviderExportPreview, String> {
    let contents = tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))
    })
    .await
    .map_err(|e| format!("Read task panicked: {}", e))??;

    let raw: MultiProviderExportFileRaw = serde_json::from_str(&contents)
        .map_err(|e| format!("Invalid export file format: {}", e))?;

    let providers: Vec<ProviderExportFilePreview> = raw
        .providers
        .iter()
        .map(|p| {
            let config = merge_v2_config(&p.config, &p.extra_config);
            ProviderExportFilePreview {
                format_version: raw.format_version,
                provider_id: p.provider_id.clone(),
                type_id: p.type_id.clone(),
                provider_name: p.provider_name.clone(),
                config,
                exported_at: raw.exported_at.clone(),
            }
        })
        .collect();

    Ok(MultiProviderExportPreview {
        format_version: raw.format_version,
        providers,
        exported_at: raw.exported_at,
    })
}

/// Import multiple providers from a multi-provider export file.
#[tauri::command]
pub async fn import_multi_provider_config(
    file_path: String,
    password: String,
    entries: Vec<ImportEntry>,
) -> Result<Vec<ProviderImportResult>, String> {
    let results = tokio::task::spawn_blocking(move || {
        let contents = std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read file: {}", e))?;

        let raw: MultiProviderExportFileRaw = serde_json::from_str(&contents)
            .map_err(|e| format!("Invalid export file format: {}", e))?;

        // Derive key once from the first entry's salt
        let shared_key = if let Some(first) = raw.providers.first() {
            crypto::derive_key_from_b64(&password, &first.encrypted_credentials.salt)?
        } else {
            return Err("No providers in export file".to_string());
        };

        let mut results = Vec::new();
        for entry in &entries {
            let provider_entry = match raw.providers.get(entry.provider_index) {
                Some(p) => p,
                None => {
                    results.push(ProviderImportResult {
                        success: false,
                        provider_id: String::new(),
                        type_id: String::new(),
                        provider_name: String::new(),
                        credentials_saved: false,
                        error: Some(format!(
                            "Provider index {} out of range",
                            entry.provider_index
                        )),
                        config: None,
                    });
                    continue;
                }
            };

            let config = {
                let merged = merge_v2_config(&provider_entry.config, &provider_entry.extra_config);
                if merged.is_empty() {
                    None
                } else {
                    Some(merged)
                }
            };

            // Use target_provider_id if provided (to match the local instance ID),
            // otherwise fall back to the provider_id from the export file.
            let save_id = if entry.target_provider_id.is_empty() {
                &provider_entry.provider_id
            } else {
                &entry.target_provider_id
            };

            let result = import_single_provider(
                &shared_key,
                &provider_entry.encrypted_credentials,
                &entry.master_password,
                entry.save,
                save_id,
                &provider_entry.type_id,
                &provider_entry.provider_name,
                config,
            );
            results.push(result);
        }

        Result::<Vec<ProviderImportResult>, String>::Ok(results)
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))??;

    Ok(results)
}

/// Helper: decrypt with pre-derived key and optionally save.
fn import_single_provider(
    shared_key: &[u8],
    encrypted: &crypto::EncryptedPayload,
    master_password: &str,
    save: bool,
    provider_id: &str,
    type_id: &str,
    provider_name: &str,
    config: Option<HashMap<String, String>>,
) -> ProviderImportResult {
    let decrypted = match crypto::decrypt_with_key(shared_key, encrypted) {
        Ok(d) => d,
        Err(e) => {
            return ProviderImportResult {
                success: false,
                provider_id: provider_id.to_string(),
                type_id: type_id.to_string(),
                provider_name: provider_name.to_string(),
                credentials_saved: false,
                error: Some(format!("Decryption failed: {}", e)),
                config: None,
            };
        }
    };

    let _creds: crate::commands::provider_key::Credentials =
        match serde_json::from_slice(&decrypted) {
            Ok(c) => c,
            Err(e) => {
                return ProviderImportResult {
                    success: false,
                    provider_id: provider_id.to_string(),
                    type_id: type_id.to_string(),
                    provider_name: provider_name.to_string(),
                    credentials_saved: false,
                    error: Some(format!("Failed to parse credentials: {}", e)),
                    config: None,
                };
            }
        };

    if save {
        let creds_str = match String::from_utf8(decrypted) {
            Ok(s) => s,
            Err(e) => {
                return ProviderImportResult {
                    success: false,
                    provider_id: provider_id.to_string(),
                    type_id: type_id.to_string(),
                    provider_name: provider_name.to_string(),
                    credentials_saved: false,
                    error: Some(format!("Invalid UTF-8 in credentials: {}", e)),
                    config: None,
                };
            }
        };

        match crate::commands::provider_key::save_provider_credentials(
            provider_id.to_string(),
            creds_str,
            master_password.to_string(),
        ) {
            Ok(()) => ProviderImportResult {
                success: true,
                provider_id: provider_id.to_string(),
                type_id: type_id.to_string(),
                provider_name: provider_name.to_string(),
                credentials_saved: true,
                error: None,
                config,
            },
            Err(e) => ProviderImportResult {
                success: false,
                provider_id: provider_id.to_string(),
                type_id: type_id.to_string(),
                provider_name: provider_name.to_string(),
                credentials_saved: false,
                error: Some(format!("Failed to save credentials: {}", e)),
                config: None,
            },
        }
    } else {
        ProviderImportResult {
            success: true,
            provider_id: provider_id.to_string(),
            type_id: type_id.to_string(),
            provider_name: provider_name.to_string(),
            credentials_saved: false,
            error: None,
            config,
        }
    }
}
