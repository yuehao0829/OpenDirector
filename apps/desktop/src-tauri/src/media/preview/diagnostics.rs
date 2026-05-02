use crate::media::model::{PreviewSessionMetrics, PreviewSessionMetricsEvent, PreviewSessionState};

#[derive(Debug, Clone, Default)]
pub struct SessionMetrics {
    pub timeline_updates: u64,
    pub seek_count: u64,
    pub warm_seek_count: u64,
    pub cold_seek_count: u64,
    pub step_count: u64,
    pub play_count: u64,
    pub pause_count: u64,
    pub viewport_updates: u64,
    pub seek_burst_count: u64,
    pub max_seek_burst_count: u64,
    pub last_seek_latency_ms: f64,
    pub max_seek_latency_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeekKind {
    Warm,
    Cold,
}

impl SessionMetrics {
    pub fn record_seek(&mut self, kind: SeekKind, latency_ms: f64, burst_count: u64) {
        self.seek_count += 1;
        match kind {
            SeekKind::Warm => {
                self.warm_seek_count += 1;
            }
            SeekKind::Cold => {
                self.cold_seek_count += 1;
            }
        }
        self.seek_burst_count = burst_count;
        self.max_seek_burst_count = self.max_seek_burst_count.max(burst_count);
        self.last_seek_latency_ms = latency_ms.max(0.0);
        self.max_seek_latency_ms = self.max_seek_latency_ms.max(self.last_seek_latency_ms);
    }

    pub fn as_model(&self) -> PreviewSessionMetrics {
        PreviewSessionMetrics {
            timeline_updates: self.timeline_updates,
            seek_count: self.seek_count,
            warm_seek_count: self.warm_seek_count,
            cold_seek_count: self.cold_seek_count,
            step_count: self.step_count,
            play_count: self.play_count,
            pause_count: self.pause_count,
            viewport_updates: self.viewport_updates,
            seek_burst_count: self.seek_burst_count,
            max_seek_burst_count: self.max_seek_burst_count,
            last_seek_latency_ms: self.last_seek_latency_ms,
            max_seek_latency_ms: self.max_seek_latency_ms,
        }
    }

    pub fn as_event(
        &self,
        session_id: String,
        state: PreviewSessionState,
    ) -> PreviewSessionMetricsEvent {
        PreviewSessionMetricsEvent {
            session_id,
            state,
            metrics: self.as_model(),
        }
    }
}
