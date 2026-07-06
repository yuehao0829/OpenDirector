use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::{Mutex, RwLock};

use crate::media::model::{
    PreviewDiagnostics, PreviewSessionInfo, PreviewSessionState, PreviewViewport,
    TimelinePreviewSnapshot,
};

use super::session::{PreviewRebuild, PreviewSession};
use super::sink;

/// A session plus its rebuild revision counter. The counter lives alongside the session Arc (not
/// inside the locked session) so `set_timeline` can allocate/compare revisions without the session
/// lock, letting a newer snapshot's build win even if an older one finishes later.
#[derive(Clone)]
struct SessionSlot {
    session: Arc<Mutex<PreviewSession>>,
    rebuild_revision: Arc<AtomicU64>,
}

impl SessionSlot {
    fn new(session: PreviewSession) -> Self {
        Self {
            session: Arc::new(Mutex::new(session)),
            rebuild_revision: Arc::new(AtomicU64::new(0)),
        }
    }
}

struct PreviewManagerState {
    sessions: HashMap<String, SessionSlot>,
    window_sessions: HashMap<String, String>,
}

pub struct PreviewSessionManager {
    app_handle: AppHandle,
    next_session_id: AtomicU64,
    state: Arc<RwLock<PreviewManagerState>>,
}

impl PreviewSessionManager {
    pub fn new(app_handle: AppHandle) -> Self {
        let state = Arc::new(RwLock::new(PreviewManagerState {
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

    async fn session_slot(&self, session_id: &str) -> Result<SessionSlot, String> {
        let state = self.state.read().await;
        state
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("Preview session not found: {}", session_id))
    }

    async fn session_arc(&self, session_id: &str) -> Result<Arc<Mutex<PreviewSession>>, String> {
        Ok(self.session_slot(session_id).await?.session)
    }

    pub async fn create_session(
        &self,
        window_label: Option<String>,
    ) -> Result<PreviewSessionInfo, String> {
        let window_label = window_label
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "main".to_string());

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

        // Swap the map entries under a short write guard, then tear the replaced session down
        // OUTSIDE the map lock — its shutdown can block on GStreamer for seconds, and holding the
        // write lock across that would stall the pump and every other session (invariant I5).
        let replaced = {
            let mut state = self.state.write().await;
            let replaced = state
                .window_sessions
                .remove(&window_label)
                .and_then(|existing_id| state.sessions.remove(&existing_id));
            state
                .window_sessions
                .insert(window_label, session_id.clone());
            state.sessions.insert(session_id, SessionSlot::new(session));
            replaced
        };

        if let Some(replaced) = replaced {
            let mut existing = replaced.session.lock().await;
            let _ = existing.destroy();
            let _ = existing.emit_state(&self.app_handle, Some("session-replaced".to_string()));
            let _ = existing.emit_metrics(&self.app_handle);
        }

        Ok(info)
    }

    pub async fn destroy_session(&self, session_id: &str) -> Result<(), String> {
        let slot = {
            let mut state = self.state.write().await;
            state
                .window_sessions
                .retain(|_, existing_session_id| existing_session_id != session_id);
            state.sessions.remove(session_id)
        };

        let Some(slot) = slot else {
            return Ok(());
        };

        let mut session = slot.session.lock().await;
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
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;
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
                self.emit_command_failure(&session, "surface-attach-failed", false)?;
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
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.set_viewport(viewport, surface_sync_revision) {
            Ok(()) => {
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(&session, "viewport-update-failed", false)?;
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
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.set_surface_presenting(presenting, surface_sync_revision) {
            Ok(()) => {
                session.emit_metrics(&self.app_handle)?;
                Ok(())
            }
            Err(error) => {
                self.emit_command_failure(&session, "surface-presenting-update-failed", false)?;
                Err(error)
            }
        }
    }

    pub async fn set_timeline(
        &self,
        session_id: &str,
        snapshot: TimelinePreviewSnapshot,
    ) -> Result<(), String> {
        let slot = self.session_slot(session_id).await?;

        // Allocate this rebuild's revision at command entry (invoke arrival order matches the
        // frontend's dispatch order) so apply order follows dispatch order, not build-completion
        // order — a newer snapshot that builds faster must not be overwritten by an older one.
        let revision = slot.rebuild_revision.fetch_add(1, Ordering::SeqCst) + 1;

        // Asset discovery + GES/pipeline construction run off any session lock so slow or failing
        // discovery never stalls other sessions or the position pump. Failure is surfaced as Err.
        let rebuild = tokio::task::spawn_blocking(move || PreviewRebuild::build(snapshot))
            .await
            .map_err(|error| format!("Failed to run preview timeline build: {error}"))?;

        let mut session = slot.session.lock().await;

        // A newer set_timeline finished and installed while this one was building; discard this
        // stale rebuild (shutting down its pipeline) and return Ok so the frontend records no
        // error — the newer snapshot is already applied.
        if slot.rebuild_revision.load(Ordering::SeqCst) != revision {
            if let Ok(rebuild) = rebuild {
                rebuild.shutdown();
            }
            return Ok(());
        }

        match rebuild {
            Ok(rebuild) => match session.install_rebuilt_timeline(rebuild) {
                Ok(()) => {
                    session.emit_state(&self.app_handle, Some("timeline-attached".to_string()))?;
                    session.emit_position(&self.app_handle)?;
                    session.emit_metrics(&self.app_handle)?;
                    Ok(())
                }
                Err(error) => {
                    // install bails without touching the pipeline when the session was destroyed
                    // mid-build; do not resurrect a torn-down session by emitting on it.
                    if !matches!(session.state, PreviewSessionState::Destroyed) {
                        self.emit_error_if_needed(&session)?;
                        session.emit_state(
                            &self.app_handle,
                            Some("timeline-attach-failed".to_string()),
                        )?;
                        session.emit_metrics(&self.app_handle)?;
                    }
                    Err(error)
                }
            },
            Err(error) => {
                // Discovery/validation failed before touching the pipeline; the session keeps its
                // existing player and stays usable (unless it was destroyed during the build).
                if !matches!(session.state, PreviewSessionState::Destroyed) {
                    session.set_error(error.clone(), None);
                    self.emit_error_if_needed(&session)?;
                    session
                        .emit_state(&self.app_handle, Some("timeline-attach-failed".to_string()))?;
                    session.emit_metrics(&self.app_handle)?;
                }
                Err(error)
            }
        }
    }

    pub async fn play(&self, session_id: &str, epoch: u64) -> Result<(), String> {
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.play(epoch) {
            Ok(()) => self.emit_command_success(&session, true),
            Err(error) => {
                self.emit_command_failure(&session, "play-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn play_from(&self, session_id: &str, time_ms: f64, epoch: u64) -> Result<(), String> {
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.play_from(time_ms, epoch) {
            Ok(()) => self.emit_command_success(&session, true),
            Err(error) => {
                self.emit_command_failure(&session, "play-from-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn pause(&self, session_id: &str, epoch: u64) -> Result<(), String> {
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.pause(epoch) {
            Ok(()) => self.emit_command_success(&session, false),
            Err(error) => {
                self.emit_command_failure(&session, "pause-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn seek(&self, session_id: &str, time_ms: f64, epoch: u64) -> Result<(), String> {
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.seek(time_ms, epoch) {
            Ok(()) => self.emit_command_success(&session, false),
            Err(error) => {
                self.emit_command_failure(&session, "seek-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn step_frame(
        &self,
        session_id: &str,
        direction: i32,
        epoch: u64,
    ) -> Result<(), String> {
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.step_frame(direction, epoch) {
            Ok(()) => self.emit_command_success(&session, false),
            Err(error) => {
                self.emit_command_failure(&session, "step-frame-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn set_rate(&self, session_id: &str, rate: f64, epoch: u64) -> Result<(), String> {
        let session_arc = self.session_arc(session_id).await?;
        let mut session = session_arc.lock().await;

        match session.set_rate(rate, epoch) {
            Ok(()) => self.emit_command_success(&session, true),
            Err(error) => {
                self.emit_command_failure(&session, "rate-update-failed", true)?;
                Err(error)
            }
        }
    }

    pub async fn get_diagnostics(&self, session_id: &str) -> Result<PreviewDiagnostics, String> {
        let session_arc = self.session_arc(session_id).await?;
        let session = session_arc.lock().await;
        Ok(session.diagnostics())
    }

    fn emit_error_if_needed(&self, session: &PreviewSession) -> Result<(), String> {
        if let Some(last_error) = &session.last_error {
            session.emit_error(&self.app_handle, last_error.clone(), None)?;
        }

        Ok(())
    }

    // Post-transport-command event set. `emit_error` preserves each command's existing
    // behavior: play/play_from/set_rate surface a lingering session error on success,
    // pause/seek/step_frame do not.
    fn emit_command_success(
        &self,
        session: &PreviewSession,
        emit_error: bool,
    ) -> Result<(), String> {
        if emit_error {
            self.emit_error_if_needed(session)?;
        }
        session.emit_state(&self.app_handle, None)?;
        session.emit_position(&self.app_handle)?;
        session.emit_metrics(&self.app_handle)?;
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

fn spawn_position_pump(app_handle: AppHandle, state: Arc<RwLock<PreviewManagerState>>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;

            let sessions: Vec<Arc<Mutex<PreviewSession>>> = {
                let state = state.read().await;
                state
                    .sessions
                    .values()
                    .map(|slot| slot.session.clone())
                    .collect()
            };

            for session_arc in sessions {
                // Skip any session busy servicing a transport command this tick.
                let Ok(mut session) = session_arc.try_lock() else {
                    continue;
                };
                match session.tick() {
                    Ok(tick) => {
                        if tick.position_changed {
                            if tick.position_source_is_frame_timestamp {
                                let _ = session.emit_frame_timestamp(&app_handle);
                            } else {
                                let _ = session.emit_position(&app_handle);
                            }
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
