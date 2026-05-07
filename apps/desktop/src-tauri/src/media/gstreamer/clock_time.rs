pub fn clock_time_to_ms(value: gst::ClockTime) -> f64 {
    value.nseconds() as f64 / 1_000_000.0
}

pub fn clock_time_from_ms(value_ms: f64) -> gst::ClockTime {
    let clamped = if value_ms.is_finite() {
        value_ms.max(0.0)
    } else {
        0.0
    };
    gst::ClockTime::from_nseconds((clamped * 1_000_000.0).round() as u64)
}
