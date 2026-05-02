use crate::commands::db_types::*;
use crate::db::DbState;
use rusqlite::params;
use tauri::State;

fn optional_row<T>(result: Result<T, rusqlite::Error>) -> Result<Option<T>, String> {
    match result {
        Ok(val) => Ok(Some(val)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

const ASSET_COLUMNS: &str = "id, project_id, name, type, source, relative_path, file_size, mime_type, duration, width, height, thumbnail_path, tags_json, favorite, usage_count, generation_id, created_at, updated_at";
const GENERATION_COLUMNS: &str = "id, project_id, fragment_id, fragment_name, prompt_text, references_json, provider_instance_id, provider_display_name, provider_params_json, output_type, result_asset_id, status, error_message, queued_at, started_at, completed_at, credits_used, user_rating, is_selected, created_at";
const LIBRARY_COLUMNS: &str = "id, name, type, source, source_path, thumbnail_path, tags_json, favorite, usage_count, created_at, updated_at";

// Projects

#[tauri::command(rename_all = "camelCase")]
pub async fn db_create_project(
    input: ProjectInput,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO projects (id, name, folder_path, settings_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.id,
                input.name,
                input.folder_path,
                input.settings_json,
                input.created_at,
                input.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_save_project(input: ProjectInput, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO projects (id, name, folder_path, settings_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![input.id, input.name, input.folder_path, input.settings_json, input.created_at, input.updated_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_load_project(
    id: String,
    state: State<'_, DbState>,
) -> Result<Option<ProjectRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, name, folder_path, settings_json, created_at, updated_at, last_opened_at FROM projects WHERE id = ?1",
            params![id],
            |row| {
                Ok(ProjectRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    folder_path: row.get(2)?,
                    settings_json: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    last_opened_at: row.get(6)?,
                })
            },
        );
        optional_row(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_list_projects(state: State<'_, DbState>) -> Result<Vec<ProjectListRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, folder_path, created_at, updated_at, last_opened_at FROM projects ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProjectListRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    folder_path: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    last_opened_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_delete_project(id: String, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Autosaves

#[tauri::command(rename_all = "camelCase")]
pub async fn db_autosave(
    id: String,
    project_id: String,
    saved_at: String,
    trigger: String,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO autosaves (id, project_id, saved_at, trigger) VALUES (?1, ?2, ?3, ?4)",
            params![id, project_id, saved_at, trigger],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_list_autosaves(
    project_id: String,
    state: State<'_, DbState>,
) -> Result<Vec<AutosaveRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, project_id, saved_at, trigger, file_path FROM autosaves WHERE project_id = ?1 ORDER BY saved_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok(AutosaveRow {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    saved_at: row.get(2)?,
                    trigger: row.get(3)?,
                    file_path: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_clear_autosaves(
    project_id: String,
    keep_count: Option<i64>,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let count = keep_count.unwrap_or(20);
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM autosaves WHERE project_id = ?1 AND id NOT IN (
                SELECT id FROM autosaves WHERE project_id = ?1 ORDER BY saved_at DESC LIMIT ?2
            )",
            params![project_id, count],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Preferences

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_preference(
    key: String,
    state: State<'_, DbState>,
) -> Result<Option<String>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT value FROM preferences WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        );
        optional_row(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_set_preference(
    key: String,
    value: String,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Assets

#[tauri::command(rename_all = "camelCase")]
pub async fn db_save_asset(input: SaveAssetInput, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let favorite_i32: i32 = if input.favorite { 1 } else { 0 };
        conn.execute(
            &format!("INSERT OR REPLACE INTO assets ({ASSET_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"),
            params![
                input.id, input.project_id, input.name, input.asset_type, input.source,
                input.relative_path, input.file_size, input.mime_type,
                input.duration, input.width, input.height, input.thumbnail_path,
                input.tags_json, favorite_i32, input.usage_count,
                input.generation_id, input.created_at, input.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn row_to_asset(row: &rusqlite::Row) -> rusqlite::Result<AssetRow> {
    let favorite: i32 = row.get(13)?;
    Ok(AssetRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        asset_type: row.get(3)?,
        source: row.get(4)?,
        relative_path: row.get(5)?,
        file_size: row.get(6)?,
        mime_type: row.get(7)?,
        duration: row.get(8)?,
        width: row.get(9)?,
        height: row.get(10)?,
        thumbnail_path: row.get(11)?,
        tags_json: row.get(12)?,
        favorite: favorite != 0,
        usage_count: row.get(14)?,
        generation_id: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_asset(
    id: String,
    state: State<'_, DbState>,
) -> Result<Option<AssetRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            &format!("SELECT {ASSET_COLUMNS} FROM assets WHERE id = ?1"),
            params![id],
            row_to_asset,
        );
        optional_row(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_assets_by_project(
    project_id: String,
    state: State<'_, DbState>,
) -> Result<Vec<AssetRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ASSET_COLUMNS} FROM assets WHERE project_id = ?1"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_id], row_to_asset)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_assets_by_source(
    project_id: String,
    source: String,
    state: State<'_, DbState>,
) -> Result<Vec<AssetRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ASSET_COLUMNS} FROM assets WHERE project_id = ?1 AND source = ?2"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_id, source], row_to_asset)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_search_assets(
    project_id: String,
    query: String,
    state: State<'_, DbState>,
) -> Result<Vec<AssetRow>, String> {
    let lower_query = format!("%{}%", query.to_lowercase());
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!("SELECT {ASSET_COLUMNS} FROM assets WHERE project_id = ?1 AND (LOWER(name) LIKE ?2 OR tags_json LIKE ?2)"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_id, lower_query], row_to_asset)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_delete_asset(id: String, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM assets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Generations

fn row_to_generation(row: &rusqlite::Row) -> rusqlite::Result<GenerationRow> {
    let is_selected: i32 = row.get(18)?;
    Ok(GenerationRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        fragment_id: row.get(2)?,
        fragment_name: row.get(3)?,
        prompt_text: row.get(4)?,
        references_json: row.get(5)?,
        provider_instance_id: row.get(6)?,
        provider_display_name: row.get(7)?,
        provider_params_json: row.get(8)?,
        output_type: row.get(9)?,
        result_asset_id: row.get(10)?,
        status: row.get(11)?,
        error_message: row.get(12)?,
        queued_at: row.get(13)?,
        started_at: row.get(14)?,
        completed_at: row.get(15)?,
        credits_used: row.get(16)?,
        user_rating: row.get(17)?,
        is_selected: is_selected != 0,
        created_at: row.get(19)?,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_create_generation(
    input: CreateGenerationInput,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let is_selected_i32: i32 = if input.is_selected { 1 } else { 0 };
        conn.execute(
            &format!("INSERT INTO generations ({GENERATION_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"),
            params![
                input.id, input.project_id, input.fragment_id, input.fragment_name,
                input.prompt_text, input.references_json, input.provider_instance_id,
                input.provider_display_name, input.provider_params_json,
                input.output_type, input.result_asset_id, input.status, input.error_message,
                input.queued_at, input.started_at, input.completed_at, input.credits_used,
                input.user_rating, is_selected_i32, input.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

const GENERATION_UPDATE_FIELDS: &[(&str, &str)] = &[
    ("status", "status"),
    ("errorMessage", "error_message"),
    ("resultAssetId", "result_asset_id"),
    ("startedAt", "started_at"),
    ("completedAt", "completed_at"),
    ("creditsUsed", "credits_used"),
    ("userRating", "user_rating"),
    ("isSelected", "is_selected"),
];

#[tauri::command(rename_all = "camelCase")]
pub async fn db_update_generation(
    input: UpdateGenerationInput,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let updates = input.updates;

        let mut set_clauses: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        for (camel_key, snake_key) in GENERATION_UPDATE_FIELDS {
            if let Some(val) = updates.get(*camel_key) {
                set_clauses.push(format!("{} = ?", snake_key));
                if val.is_boolean() {
                    values.push(Box::new(if val.as_bool().unwrap_or(false) {
                        1i32
                    } else {
                        0i32
                    }));
                } else if val.is_string() {
                    values.push(Box::new(val.as_str().unwrap_or("").to_string()));
                } else if val.is_number() {
                    values.push(Box::new(val.as_f64().unwrap_or(0.0)));
                } else if val.is_null() {
                    values.push(Box::new(Option::<String>::None));
                }
            }
        }

        if set_clauses.is_empty() {
            return Ok(());
        }

        let sql = format!(
            "UPDATE generations SET {} WHERE id = ?",
            set_clauses.join(", ")
        );

        values.push(Box::new(input.id));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())
            .map_err(|e| e.to_string())?;

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_generation(
    id: String,
    state: State<'_, DbState>,
) -> Result<Option<GenerationRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            &format!("SELECT {GENERATION_COLUMNS} FROM generations WHERE id = ?1"),
            params![id],
            row_to_generation,
        );
        optional_row(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_generations_by_project(
    project_id: String,
    state: State<'_, DbState>,
) -> Result<Vec<GenerationRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!("SELECT {GENERATION_COLUMNS} FROM generations WHERE project_id = ?1 ORDER BY created_at DESC"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_id], row_to_generation)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_generations_by_fragment(
    fragment_id: String,
    state: State<'_, DbState>,
) -> Result<Vec<GenerationRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!("SELECT {GENERATION_COLUMNS} FROM generations WHERE fragment_id = ?1 ORDER BY created_at DESC"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![fragment_id], row_to_generation)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_delete_generation(id: String, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM generations WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_delete_generations_by_fragment(
    fragment_id: String,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM generations WHERE fragment_id = ?1",
            params![fragment_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Lookup

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_project_by_folder_path(
    folder_path: String,
    state: State<'_, DbState>,
) -> Result<Option<String>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id FROM projects WHERE folder_path = ?1 LIMIT 1",
            params![folder_path],
            |row| row.get::<_, String>(0),
        );
        optional_row(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Library

fn row_to_library_asset(row: &rusqlite::Row) -> rusqlite::Result<LibraryAssetRow> {
    let favorite: i32 = row.get(7)?;
    Ok(LibraryAssetRow {
        id: row.get(0)?,
        name: row.get(1)?,
        asset_type: row.get(2)?,
        source: row.get(3)?,
        source_path: row.get(4)?,
        thumbnail_path: row.get(5)?,
        tags_json: row.get(6)?,
        favorite: favorite != 0,
        usage_count: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_add_to_library(
    input: AddToLibraryInput,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        let favorite_i32: i32 = if input.favorite { 1 } else { 0 };
        conn.execute(
            &format!("INSERT OR REPLACE INTO asset_library ({LIBRARY_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"),
            params![
                input.id, input.name, input.asset_type, input.source,
                input.source_path, input.thumbnail_path, input.tags_json,
                favorite_i32, input.usage_count,
                input.created_at, input.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_library_assets(
    query: LibraryQuery,
    state: State<'_, DbState>,
) -> Result<Vec<LibraryAssetRow>, String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;

        let mut sql = format!("SELECT {LIBRARY_COLUMNS} FROM asset_library WHERE 1=1");
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref asset_type) = query.asset_type {
            sql.push_str(" AND type = ?");
            values.push(Box::new(asset_type.clone()));
        }
        if let Some(ref source) = query.source {
            sql.push_str(" AND source = ?");
            values.push(Box::new(source.clone()));
        }
        if let Some(ref search) = query.search {
            sql.push_str(" AND (LOWER(name) LIKE ? OR tags_json LIKE ?)");
            let pattern = format!("%{}%", search.to_lowercase());
            values.push(Box::new(pattern.clone()));
            values.push(Box::new(pattern));
        }
        if let Some(favorite) = query.favorite {
            sql.push_str(" AND favorite = ?");
            let fav_i32: i32 = if favorite { 1 } else { 0 };
            values.push(Box::new(fav_i32));
        }

        sql.push_str(" ORDER BY created_at DESC");

        if let Some(limit) = query.limit {
            sql.push_str(" LIMIT ?");
            values.push(Box::new(limit));
        }
        if let Some(offset) = query.offset {
            sql.push_str(" OFFSET ?");
            values.push(Box::new(offset));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            values.iter().map(|v| v.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(param_refs.as_slice(), row_to_library_asset)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_remove_from_library(id: String, state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM asset_library WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
