use serde::{Deserialize, Serialize};

// Input types (Deserialize, rename_all = "camelCase")

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub id: String,
    pub name: String,
    pub folder_path: String,
    pub settings_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAssetInput {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub source: String,
    pub relative_path: String,
    pub file_size: i64,
    pub mime_type: String,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub thumbnail_path: Option<String>,
    pub tags_json: String,
    pub favorite: bool,
    pub usage_count: i64,
    pub generation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGenerationInput {
    pub id: String,
    pub project_id: String,
    pub fragment_id: Option<String>,
    pub fragment_name: Option<String>,
    pub prompt_text: String,
    pub references_json: String,
    pub provider_instance_id: String,
    pub provider_display_name: String,
    pub provider_params_json: String,
    pub output_type: String,
    pub result_asset_id: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub queued_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub credits_used: Option<f64>,
    pub user_rating: Option<i64>,
    pub is_selected: bool,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGenerationInput {
    pub id: String,
    pub updates: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddToLibraryInput {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub source: String,
    pub source_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub tags_json: String,
    pub favorite: bool,
    pub usage_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryQuery {
    #[serde(rename = "type")]
    pub asset_type: Option<String>,
    pub source: Option<String>,
    pub search: Option<String>,
    pub favorite: Option<bool>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

// Output types (Serialize, rename_all = "camelCase")

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub folder_path: Option<String>,
    pub settings_json: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}

/// Lightweight project row for list views (omits settings_json)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListRow {
    pub id: String,
    pub name: String,
    pub folder_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub source: String,
    pub relative_path: String,
    pub file_size: i64,
    pub mime_type: String,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub thumbnail_path: Option<String>,
    pub tags_json: String,
    pub favorite: bool,
    pub usage_count: i64,
    pub generation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRow {
    pub id: String,
    pub project_id: String,
    pub fragment_id: Option<String>,
    pub fragment_name: Option<String>,
    pub prompt_text: String,
    pub references_json: String,
    pub provider_instance_id: String,
    pub provider_display_name: String,
    pub provider_params_json: String,
    pub output_type: String,
    pub result_asset_id: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub queued_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub credits_used: Option<f64>,
    pub user_rating: Option<i64>,
    pub is_selected: bool,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveRow {
    pub id: String,
    pub project_id: String,
    pub saved_at: String,
    pub trigger: String,
    pub file_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAssetRow {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub source: String,
    pub source_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub tags_json: String,
    pub favorite: bool,
    pub usage_count: i64,
    pub created_at: String,
    pub updated_at: String,
}
