use crate::commands::metadata::MediaMetadataResult;

use super::super::error::MediaResult;
use super::super::model::MediaProbeRequest;
use super::super::runtime;
use super::command::{canonicalize_media_path, portable_path_string, run_tool, GstreamerTool};

pub fn probe_media(request: &MediaProbeRequest) -> MediaResult<MediaMetadataResult> {
    let runtime = runtime::require_gstreamer_preview_runtime()?;
    let media_path = canonicalize_media_path(&request.path)?;
    let output = run_tool(
        &runtime.bootstrap,
        GstreamerTool::GstDiscoverer,
        &[portable_path_string(&media_path)],
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gst-discoverer-1.0 failed: {}", stderr.trim()));
    }

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }

    Ok(parse_discoverer_output(&text))
}

fn parse_discoverer_output(text: &str) -> MediaMetadataResult {
    MediaMetadataResult {
        duration_ms: find_keys(text, "Duration")
            .into_iter()
            .filter_map(parse_duration_ms)
            .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)),
        width: find_key(text, "Width").and_then(|value| parse_u32_token(&value)),
        height: find_key(text, "Height").and_then(|value| parse_u32_token(&value)),
        frame_rate: find_key(text, "Frame rate").and_then(parse_fractional_rate),
        channels: find_key(text, "Channels").and_then(|value| parse_u32_token(&value)),
        sample_rate: find_key(text, "Sample rate").and_then(parse_sample_rate),
        codec: find_key(text, "Codec"),
    }
}

fn find_key(text: &str, key: &str) -> Option<String> {
    find_keys(text, key).into_iter().next()
}

fn find_keys(text: &str, key: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (candidate_key, candidate_value) = trimmed.split_once(':')?;
            if candidate_key.trim().eq_ignore_ascii_case(key) {
                Some(candidate_value.trim().to_string())
            } else {
                None
            }
        })
        .collect()
}

fn parse_u32_token(value: &str) -> Option<u32> {
    value
        .split(|c: char| !c.is_ascii_digit())
        .find(|part| !part.is_empty())
        .and_then(|part| part.parse::<u32>().ok())
}

fn parse_sample_rate(value: String) -> Option<u32> {
    let normalized = value.replace("Hz", "").replace("hz", "");
    parse_u32_token(&normalized)
}

fn parse_fractional_rate(value: String) -> Option<f64> {
    if let Some((num, den)) = value.split_once('/') {
        let num = num.trim().parse::<f64>().ok()?;
        let den = den.trim().parse::<f64>().ok()?;
        if den > 0.0 {
            return Some(num / den);
        }
    }

    value.trim().parse::<f64>().ok()
}

fn parse_duration_ms(value: String) -> Option<f64> {
    let trimmed = value.trim();
    let (time_part, fraction_part) = trimmed.split_once('.').unwrap_or((trimmed, "0"));
    let mut units = time_part.split(':');
    let hours = units.next()?.trim().parse::<u64>().ok()?;
    let minutes = units.next()?.trim().parse::<u64>().ok()?;
    let seconds = units.next()?.trim().parse::<u64>().ok()?;

    let nanos_str: String = fraction_part
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    let nanos = nanos_str.parse::<u64>().unwrap_or(0);

    let millis = hours as f64 * 3_600_000.0
        + minutes as f64 * 60_000.0
        + seconds as f64 * 1_000.0
        + nanos as f64 / 1_000_000.0;

    Some(millis)
}

#[cfg(test)]
mod tests {
    use super::parse_discoverer_output;

    #[test]
    fn parse_discoverer_prefers_longest_duration() {
        let text = r#"
Properties:
  Duration: 0:00:00.033333333
  Duration: 0:00:02.033333333
      Width: 1280
      Height: 720
      Frame rate: 30/1
      Channels: 2 (front-left, front-right)
      Sample rate: 44100
"#;

        let metadata = parse_discoverer_output(text);
        assert_eq!(metadata.width, Some(1280));
        assert_eq!(metadata.height, Some(720));
        assert_eq!(metadata.frame_rate, Some(30.0));
        assert_eq!(metadata.channels, Some(2));
        assert_eq!(metadata.sample_rate, Some(44100));
        let duration = metadata.duration_ms.expect("duration should be parsed");
        assert!(
            (duration - 2033.333333).abs() < 0.001,
            "duration={duration}"
        );
    }
}
