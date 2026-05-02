use std::time::Duration;

/// Adaptive polling interval based on how long a task has been running.
/// Returns increasingly longer intervals as elapsed time grows:
///   < 2 min  → 10 s
///   2–10 min → 20 s
///   10–30 min → 30 s
///   30+ min  → 60 s
pub fn adaptive_poll_interval(elapsed_secs: u64) -> Duration {
    match elapsed_secs {
        0..120 => Duration::from_secs(10),
        120..600 => Duration::from_secs(20),
        600..1800 => Duration::from_secs(30),
        _ => Duration::from_secs(60),
    }
}
