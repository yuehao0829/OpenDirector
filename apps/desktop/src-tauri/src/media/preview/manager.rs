use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::media::model::{
    PreviewDiagnostics, PreviewSessionInfo, PreviewViewport, TimelinePreviewSnapshot,
};

use super::session::PreviewSession;
use super::sink;

struct PreviewManagerState {
    sessions: HashMap<String, PreviewSession>,
    window_sessions: HashMap<String, String>,
}

pub struct PreviewSessionManager {
    app_handle: AppHandle,
    next_session_id: AtomicU64,
    state: Arc<Mutex<PreviewManagerState>>,
}

impl PreviewSessionManager {
    pub fn new(app_handle: AppHandle) -> Self {
        let state = Arc::new(Mutex::new(PreviewManagerState {
            sessions: HashMap::new(),
            window_sessions: HashMap::new(),
        }));
        spawn_position_pump(app_handle.clone(), state.clone());

        Self {
            app_handle,
            next_session_id: AtomicU64::new(1),
            state,
        }
    }

    pub async fn create_session(
        &self,
        window_label: Option<String>,
    ) -> Result<PreviewSessionInfo, String> {
        let window_label = window_label
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "main".to_string());

        let mut state = self.state.lock().await;
        if let Some(existing_id) = state.window_sessions.remove(&window_label) {
            if let Some(mut existing) = state.sessions.remove(&existing_id) {
                let _ = existing.destroy();
                let _ = existing.emit_state(&self.app_handle, Some("session-replaced".to_string()));
                let _ = existing.emit_metrics(&self.app_handle);
            }
        }

        let session_id = format!(
            "preview-session-{}",
            self.next_session_id.fetch_add(1, Ordering::SeqCst)
        );
        let session = PreviewSession::new(
            session_id.clone(),
            window_label.clone(),
            sink::native_surface_supported(),
        );
        let info = session.info();
        session.emit_state(&self.app_handle, Some("session-created".to_string()))?;
        session.emit_metrics(&self.app_handle)?;

        state
            .window_sessions
            .insert(window_label, session_id.clone());
        state.sessions.insert(session_id, session);

        Ok(info)
    }

    pub async fn destroy_session(&self, session_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        state
            .window_sessions
            .retain(|_, existing_session_id| existing_session_id != session_id);

        let Some(mut session) = state.sessions.remove(session_id) else {
            return Ok(());
        };

        session.destroy()?;
        session.emit_state(&self.app_handle, Some("session-destroyed".to_string()))?;
        session.emit_metrics(&self.app_handle)?;
        Ok(())
    }

    pub async fn attach_surface(
        &self,
        session_id: &str,
        surface_id: Option<String>,
        viewport: Option<PreviewViewport>,
        surface_sync_revision: Option<u64>,
    ) -> Result<PreviewSessionInfo, String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;
        let was_attached = session.native_surface_attached();

        match session.attach_surface(
            &self.app_handle,
            surface_id,
            viewport,
            surface_sync_revision,
        ) {
            Ok(()) => {
                let is_attached = session.native_surface_attached();
                if was_attached != is_attached {
                    session.emit_state(
                        &self.app_handle,
                        Some(if is_attached {
                            "surface-attached".to_string()
                        } else {
                            "surface-detached".to_string()
                        }),
                    )?;
                }
                session.emit_metrics(&self.app_handle)?;
                Ok(session.info())
            }
            Err(error) => {
                self.emit_command_failure(session, "surface-attach-failed", false)?;
                Err(error)
            }
        }
    }

    pub async fn set_viewport(
        &self,
        session_id: &str,
        viewport: PreviewViewport,
        surface_sync_revision: Option<u64>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.set_viewport(viewport, surface_sync_revision) {
            Ok(()) => {
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "viewport-update-failed", false)?;
                Err(error)
            }
        }
    }

    pub async fn set_surface_presenting(
        &self,
        session_id: &str,
        presenting: bool,
        surface_sync_revision: Option<u64>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.set_surface_presenting(presenting, surface_sync_revision) {
            Ok(()) => {
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "surface-presenting-update-failed", false)?;
                Err(error)
            }
        }
    }

    pub async fn set_timeline(
        &self,
        session_id: &str,
        snapshot: TimelinePreviewSnapshot,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.set_timeline(snapshot) {
            Ok(()) => {
                session.emit_state(&self.app_handle, Some("timeline-attached".to_string()))?;
                session.emit_position(&self.app_handle)?;
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_error_if_needed(session)?;
                session.emit_state(&self.app_handle, Some("timeline-attach-failed".to_string()))?;
                session.emit_metrics(&self.app_handle)?;
                Err(error)
            }
        }
    }

    pub async fn play(&self, session_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.play() {
            Ok(()) => {
                self.emit_error_if_needed(session)?;
                session.emit_state(&self.app_handle, None)?;
                session.emit_position(&self.app_handle)?;
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "play-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn play_from(&self, session_id: &str, time_ms: f64) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.play_from(time_ms) {
            Ok(()) => {
                self.emit_error_if_needed(session)?;
                session.emit_state(&self.app_handle, None)?;
                session.emit_position(&self.app_handle)?;
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "play-from-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn pause(&self, session_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.pause() {
            Ok(()) => {
                session.emit_state(&self.app_handle, None)?;
                session.emit_position(&self.app_handle)?;
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "pause-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn seek(&self, session_id: &str, time_ms: f64) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.seek(time_ms) {
            Ok(()) => {
                session.emit_state(&self.app_handle, None)?;
                session.emit_position(&self.app_handle)?;
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "seek-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn step_frame(&self, session_id: &str, direction: i32) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.step_frame(direction) {
            Ok(()) => {
                session.emit_state(&self.app_handle, None)?;
                session.emit_position(&self.app_handle)?;
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "step-frame-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn set_rate(&self, session_id: &str, rate: f64) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        match session.set_rate(rate) {
            Ok(()) => {
                self.emit_error_if_needed(session)?;
                session.emit_state(&self.app_handle, None)?;
                session.emit_position(&self.app_handle)?;
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(session, "rate-update-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn get_diagnostics(&self, session_id: &str) -> Result<PreviewDiagnostics, String> {
        let state = self.state.lock().await;
        let session = state
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Preview session not found: {}", session_id))?;

        Ok(session.diagnostics())
    }

    fn emit_error_if_needed(&self, session: &PreviewSession) -> Result<(), String> {
        if let Some(last_error) = &session.last_error {
            session.emit_error(&self.app_handle, last_error.clone(), None)?;
        }

        Ok(())
    }

    fn emit_command_failure(
        &self,
        session: &PreviewSession,
        state_message: &str,
        emit_position: bool,
    ) -> Result<(), String> {
        self.emit_error_if_needed(session)?;
        session.emit_state(&self.app_handle, Some(state_message.to_string()))?;
        if emit_position {
            session.emit_position(&self.app_handle)?;
        }
        session.emit_metrics(&self.app_handle)?;
        Ok(())
    }
}

fn spawn_position_pump(app_handle: AppHandle, state: Arc<Mutex<PreviewManagerState>>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;

            let mut state = state.lock().await;
            for session in state.sessions.values_mut() {
                match session.tick() {
                    Ok(tick) => {
                        if tick.position_changed {
                            let _ = session.emit_position(&app_handle);
                        }
                        if tick.state_changed {
                            let _ = session.emit_state(&app_handle, None);
                            let _ = session.emit_metrics(&app_handle);
                        }
                        if tick.error_emitted {
                            if let Some(last_error) = &session.last_error {
                                let _ = session.emit_error(&app_handle, last_error.clone(), None);
                            }
                            let _ = session.emit_state(&app_handle, None);
                            let _ = session.emit_metrics(&app_handle);
                        }
                    }
                    Err(error) => {
                        session.set_error(error.clone(), None);
                        let _ = session.emit_error(&app_handle, error, None);
                        let _ = session.emit_state(&app_handle, None);
                        let _ = session.emit_metrics(&app_handle);
                    }
                }
            }
        }
    });
}
