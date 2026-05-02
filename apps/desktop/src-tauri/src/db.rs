use rusqlite::Connection;
use std::sync::Arc;
use std::sync::Mutex;

pub struct DbState {
    pub conn: Arc<Mutex<Connection>>,
}

impl DbState {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open database: {}", e))?;

        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("Failed to set pragmas: {}", e))?;

        let user_version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| format!("Failed to read user_version: {}", e))?;

        if user_version < 1 {
            migrate_v1(&conn)?;
            conn.pragma_update(None, "user_version", 1)
                .map_err(|e| format!("Failed to set user_version: {}", e))?;
        }

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

fn migrate_v1(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            folder_path TEXT,
            settings_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_opened_at TEXT
        );

        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'original',
            relative_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            mime_type TEXT NOT NULL,
            duration REAL,
            width INTEGER,
            height INTEGER,
            thumbnail_path TEXT,
            tags_json TEXT DEFAULT '[]',
            favorite INTEGER DEFAULT 0,
            usage_count INTEGER DEFAULT 0,
            generation_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS generations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            fragment_id TEXT,
            fragment_name TEXT,
            prompt_text TEXT NOT NULL,
            references_json TEXT DEFAULT '[]',
            provider_instance_id TEXT NOT NULL,
            provider_display_name TEXT NOT NULL DEFAULT '',
            provider_params_json TEXT,
            output_type TEXT NOT NULL DEFAULT 'video',
            result_asset_id TEXT,
            status TEXT NOT NULL,
            error_message TEXT,
            queued_at TEXT,
            started_at TEXT,
            completed_at TEXT,
            credits_used REAL,
            user_rating INTEGER,
            is_selected INTEGER DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS autosaves (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            trigger TEXT NOT NULL,
            timeline_snapshot TEXT,
            file_path TEXT
        );

        CREATE TABLE IF NOT EXISTS asset_library (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'original',
            source_path TEXT,
            thumbnail_path TEXT,
            tags_json TEXT DEFAULT '[]',
            favorite INTEGER DEFAULT 0,
            usage_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS preferences (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Migration v1 failed: {}", e))?;

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id);
         CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
         CREATE INDEX IF NOT EXISTS idx_assets_project_source ON assets(project_id, source);
         CREATE INDEX IF NOT EXISTS idx_generations_project_id ON generations(project_id);
         CREATE INDEX IF NOT EXISTS idx_generations_fragment_id ON generations(fragment_id);
         CREATE INDEX IF NOT EXISTS idx_autosaves_project_id ON autosaves(project_id);",
    )
    .map_err(|e| format!("Migration v1 indexes failed: {}", e))?;

    Ok(())
}
