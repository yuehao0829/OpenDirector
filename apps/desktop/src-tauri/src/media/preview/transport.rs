pub fn normalize_rate(rate: f64) -> f64 {
    if !rate.is_finite() {
        return 1.0;
    }

    rate.clamp(0.1, 16.0)
}

pub fn clamp_position(position_ms: f64, duration_ms: f64) -> f64 {
    let duration_ms = duration_ms.max(0.0);
    position_ms.clamp(0.0, duration_ms)
}
