/// Shared GES CLI argument utilities used by preview_timeline_builder, render, and xges.

pub fn fps_fraction(fps: f64) -> String {
    let scaled = (fps * 1000.0).round() as u64;
    let denominator = 1000u64;
    let divisor = gcd(scaled, denominator).max(1);
    format!("{}/{}", scaled / divisor, denominator / divisor)
}

pub fn gcd(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

pub fn sanitize_clip_token(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "clip".to_string();
    }

    trimmed
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => ch,
            _ => '_',
        })
        .collect()
}
