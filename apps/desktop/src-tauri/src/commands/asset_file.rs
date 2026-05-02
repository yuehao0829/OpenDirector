use std::path::Path;

#[derive(serde::Serialize)]
pub struct CopyAssetFileResult {
    pub file_size: u64,
}

#[tauri::command]
pub async fn copy_asset_file(
    from_path: String,
    to_path: String,
) -> Result<CopyAssetFileResult, String> {
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = Path::new(&to_path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        let bytes = std::fs::copy(&from_path, &to_path)
            .map_err(|e| format!("Failed to copy file: {}", e))?;
        Ok(CopyAssetFileResult { file_size: bytes })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
