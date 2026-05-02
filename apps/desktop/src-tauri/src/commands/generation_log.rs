use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Log level
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum LogLevel {
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "warn")]
    Warn,
    #[serde(rename = "error")]
    Error,
}

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GenerationLogEntry {
    /// ISO 8601 UTC timestamp with microseconds
    pub ts: String,
    /// info | warn | error
    pub level: LogLevel,
    /// "rust" | "js"
    pub source: String,
    /// Optional task ID for correlation
    pub task_id: Option<String>,
    /// Semantic phase name (e.g. "api_create_task", "download_success")
    pub phase: String,
    /// Human-readable message
    pub msg: String,
    /// Duration in milliseconds, if relevant
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Arbitrary structured data (fragment_id, provider_id, error, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Per-project logger
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024; // 10 MiB
const MAX_ROTATED_FILES: u16 = 5;
const FLUSH_INTERVAL_ENTRIES: u64 = 10;

struct GenerationLogger {
    file: std::io::BufWriter<std::fs::File>,
    log_dir: PathBuf,
    /// Approximate byte count of the current log file (avoids metadata syscall per write)
    approx_bytes: u64,
    /// Number of entries written since last flush
    entries_since_flush: u64,
}

impl GenerationLogger {
    fn new(project_path: &str) -> Result<Self, String> {
        let log_dir = PathBuf::from(project_path).join("Logs");
        std::fs::create_dir_all(&log_dir).map_err(|e| format!("Cannot create log dir: {}", e))?;

        let log_path = log_dir.join("generation.log");
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("Cannot open log file: {}", e))?;

        // Seed the approximate byte count from the actual file size at open time
        let approx_bytes = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);

        Ok(Self {
            file: std::io::BufWriter::new(f),
            log_dir,
            approx_bytes,
            entries_since_flush: 0,
        })
    }

    fn write_entry(&mut self, entry: &GenerationLogEntry) -> Result<(), String> {
        let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        line.push('\n');
        let line_bytes = line.len() as u64;

        self.file
            .write_all(line.as_bytes())
            .map_err(|e| format!("Log write failed: {}", e))?;

        self.approx_bytes += line_bytes;
        self.entries_since_flush += 1;

        // Periodic flush — every FLUSH_INTERVAL_ENTRIES entries
        if self.entries_since_flush >= FLUSH_INTERVAL_ENTRIES {
            self.file
                .flush()
                .map_err(|e| format!("Log flush failed: {}", e))?;
            self.entries_since_flush = 0;
        }

        self.maybe_rotate()
    }

    /// Flush any buffered data to disk.
    fn flush(&mut self) -> Result<(), String> {
        if self.entries_since_flush > 0 {
            self.file
                .flush()
                .map_err(|e| format!("Log flush failed: {}", e))?;
            self.entries_since_flush = 0;
        }
        Ok(())
    }

    /// Rotate log files when the current file exceeds `MAX_FILE_BYTES`.
    ///
    /// 1. Flush + drop the BufWriter (closes the file handle)
    /// 2. Delete `generation.log.5` if it exists
    /// 3. Rename .4 -> .5, .3 -> .4, .2 -> .3, .1 -> .2
    /// 4. Rename `generation.log` -> `generation.log.1`
    /// 5. Open a fresh `generation.log` in append mode
    fn maybe_rotate(&mut self) -> Result<(), String> {
        if self.approx_bytes < MAX_FILE_BYTES {
            return Ok(());
        }

        let log_path = self.log_dir.join("generation.log");

        // Flush before dropping
        let _ = self.flush();

        // Drop the BufWriter to close the file handle — Windows refuses rename
        // while any handle to the file is open.
        self.file = Self::open_dummy_writer()?;

        // Delete oldest rotated file
        let oldest = self
            .log_dir
            .join(format!("generation.log.{}", MAX_ROTATED_FILES));
        let _ = std::fs::remove_file(&oldest);

        // Rename chain: .4 -> .5, .3 -> .4, ..., .1 -> .2
        for i in (2..=MAX_ROTATED_FILES).rev() {
            let src = self.log_dir.join(format!("generation.log.{}", i - 1));
            let dst = self.log_dir.join(format!("generation.log.{}", i));
            if src.exists() {
                let _ = std::fs::rename(&src, &dst);
            }
        }

        // Rename current -> .1
        let rotated = self.log_dir.join("generation.log.1");
        let _ = std::fs::rename(&log_path, &rotated);

        // Open fresh log file
        self.file = Self::open_append(&log_path)?;
        self.approx_bytes = 0;
        self.entries_since_flush = 0;

        Ok(())
    }

    /// Create a no-op BufWriter that discards all output.
    /// Used as a temporary placeholder while rotating (to release the real file handle).
    fn open_dummy_writer() -> Result<std::io::BufWriter<std::fs::File>, String> {
        // Write to the platform null device (discards all output).
        #[cfg(target_os = "windows")]
        let path = "NUL";
        #[cfg(not(target_os = "windows"))]
        let path = "/dev/null";

        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| format!("Cannot open null device: {}", e))?;
        Ok(std::io::BufWriter::new(f))
    }

    fn open_append(path: &PathBuf) -> Result<std::io::BufWriter<std::fs::File>, String> {
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("Cannot open log file: {}", e))?;
        Ok(std::io::BufWriter::new(f))
    }
}

// ---------------------------------------------------------------------------
// Manager (one logger per project path)
// ---------------------------------------------------------------------------

pub struct GenerationLogManager {
    loggers: Arc<tokio::sync::Mutex<HashMap<String, GenerationLogger>>>,
}

impl Clone for GenerationLogManager {
    fn clone(&self) -> Self {
        Self {
            loggers: self.loggers.clone(),
        }
    }
}

impl GenerationLogManager {
    pub fn new() -> Self {
        Self {
            loggers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    pub async fn log(&self, project_path: &str, entry: GenerationLogEntry) {
        let mut loggers = self.loggers.lock().await;

        // Get or create logger for this project
        if !loggers.contains_key(project_path) {
            match GenerationLogger::new(project_path) {
                Ok(logger) => {
                    loggers.insert(project_path.to_string(), logger);
                }
                Err(e) => {
                    eprintln!(
                        "[GenerationLog] Cannot create logger for {}: {}",
                        project_path, e
                    );
                    return;
                }
            }
        }

        if let Some(logger) = loggers.get_mut(project_path) {
            if let Err(e) = logger.write_entry(&entry) {
                eprintln!("[GenerationLog] Write failed: {}", e);
            }
        }
    }

    /// Close and remove the logger for a project path, releasing the file handle.
    #[allow(dead_code)]
    pub async fn close_logger(&self, project_path: &str) {
        let mut loggers = self.loggers.lock().await;
        loggers.remove(project_path);
    }
}

// ---------------------------------------------------------------------------
// Tauri command (JS entry point)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn write_generation_log(
    manager: tauri::State<'_, GenerationLogManager>,
    project_path: String,
    level: LogLevel,
    task_id: Option<String>,
    phase: String,
    msg: String,
    duration_ms: Option<u64>,
    data: Option<serde_json::Value>,
) -> Result<(), String> {
    let entry = GenerationLogEntry {
        ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        level,
        source: "js".to_string(),
        task_id,
        phase,
        msg,
        duration_ms,
        data,
    };
    manager.log(&project_path, entry).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rust-side builder
// ---------------------------------------------------------------------------

/// Context for structured logging from Rust side.
///
/// Carries the log manager and project path so individual call sites
/// only need to specify phase, message, and optional data.
///
/// ```ignore
/// let ctx = LogContext::new(&log_mgr, &project_path);
/// ctx.info("phase_name", "Human message")
///     .task_id(&task_id)
///     .data(json!({ "key": "value" }))
///     .log();
/// ```
pub struct LogContext<'a> {
    manager: &'a Arc<GenerationLogManager>,
    project_path: &'a str,
}

impl<'a> LogContext<'a> {
    pub fn new(manager: &'a Arc<GenerationLogManager>, project_path: &'a str) -> Self {
        Self {
            manager,
            project_path,
        }
    }

    pub fn info(&'a self, phase: &str, msg: &str) -> LogEntryBuilder<'a> {
        LogEntryBuilder {
            manager: self.manager,
            project_path: self.project_path,
            level: LogLevel::Info,
            task_id: None,
            phase: phase.to_string(),
            msg: msg.to_string(),
            duration_ms: None,
            data: None,
        }
    }

    pub fn warn(&'a self, phase: &str, msg: &str) -> LogEntryBuilder<'a> {
        LogEntryBuilder {
            manager: self.manager,
            project_path: self.project_path,
            level: LogLevel::Warn,
            task_id: None,
            phase: phase.to_string(),
            msg: msg.to_string(),
            duration_ms: None,
            data: None,
        }
    }

    pub fn error(&'a self, phase: &str, msg: &str) -> LogEntryBuilder<'a> {
        LogEntryBuilder {
            manager: self.manager,
            project_path: self.project_path,
            level: LogLevel::Error,
            task_id: None,
            phase: phase.to_string(),
            msg: msg.to_string(),
            duration_ms: None,
            data: None,
        }
    }
}

pub struct LogEntryBuilder<'a> {
    manager: &'a Arc<GenerationLogManager>,
    project_path: &'a str,
    level: LogLevel,
    task_id: Option<String>,
    phase: String,
    msg: String,
    duration_ms: Option<u64>,
    data: Option<serde_json::Value>,
}

impl<'a> LogEntryBuilder<'a> {
    pub fn task_id(mut self, id: &str) -> Self {
        self.task_id = Some(id.to_string());
        self
    }

    pub fn duration_ms(mut self, ms: u64) -> Self {
        self.duration_ms = Some(ms);
        self
    }

    pub fn data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    /// Fire-and-forget: spawn a tokio task to write the log entry.
    /// Never blocks the caller. On failure, falls back to eprintln.
    pub fn log(self) {
        let manager = (*self.manager).clone();
        let project_path = self.project_path.to_string();
        let entry = GenerationLogEntry {
            ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            level: self.level,
            source: "rust".to_string(),
            task_id: self.task_id,
            phase: self.phase,
            msg: self.msg,
            duration_ms: self.duration_ms,
            data: self.data,
        };
        tauri::async_runtime::spawn(async move {
            manager.log(&project_path, entry).await;
        });
    }
}
