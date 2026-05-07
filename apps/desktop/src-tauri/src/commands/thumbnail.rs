use std::path::Path;

use crate::media::audio::{decode_audio_samples, downmix_to_mono};
use image::imageops::FilterType;

#[tauri::command(rename_all = "camelCase")]
pub async fn generate_video_thumbnail(
    video_path: String,
    output_path: String,
    time_sec: Option<f64>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        ensure_parent_dir(&output_path)?;
        crate::media::gstreamer::thumbnail::render_video_thumbnail(
            &video_path,
            &output_path,
            time_sec.unwrap_or(1.0),
        )?;
        Ok(output_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn generate_image_thumbnail(
    image_path: String,
    max_size: Option<u32>,
    output_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        ensure_parent_dir(&output_path)?;

        let max = max_size.unwrap_or(512);
        let image = image::open(&image_path)
            .map_err(|err| format!("failed to open image {}: {}", image_path, err))?;
        let thumbnail = image.resize(max, max, FilterType::Lanczos3);

        thumbnail
            .save(&output_path)
            .map_err(|err| format!("failed to save thumbnail: {}", err))?;

        Ok(output_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn generate_audio_peakdata(
    audio_path: String,
    output_path: String,
    peaks: Option<u32>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let peak_count = peaks.unwrap_or(4096);
        ensure_parent_dir(&output_path)?;

        let decoded = decode_audio_samples(&audio_path)?;
        if decoded.samples.is_empty() {
            return Err("no audio samples decoded".to_string());
        }

        let samples = downmix_to_mono(decoded.samples, decoded.channels)?;
        let samples_per_bucket = samples.len() as f64 / peak_count as f64;

        let mut mins = Vec::with_capacity(peak_count as usize);
        let mut maxs = Vec::with_capacity(peak_count as usize);

        for i in 0..peak_count as usize {
            let start = (i as f64 * samples_per_bucket) as usize;
            let end = std::cmp::min(
                ((i as f64 + 1.0) * samples_per_bucket).ceil() as usize,
                samples.len(),
            );
            if start >= samples.len() {
                mins.push(0.0_f32);
                maxs.push(0.0_f32);
                continue;
            }

            let mut bucket_min = f32::MAX;
            let mut bucket_max = f32::MIN;
            for &sample in &samples[start..end] {
                if sample < bucket_min {
                    bucket_min = sample;
                }
                if sample > bucket_max {
                    bucket_max = sample;
                }
            }
            mins.push(bucket_min);
            maxs.push(bucket_max);
        }

        let mut buffer = Vec::with_capacity(4 + peak_count as usize * 8);
        buffer.extend_from_slice(&peak_count.to_le_bytes());
        for value in &mins {
            buffer.extend_from_slice(&value.to_le_bytes());
        }
        for value in &maxs {
            buffer.extend_from_slice(&value.to_le_bytes());
        }

        std::fs::write(&output_path, &buffer)
            .map_err(|err| format!("failed to write peak data: {}", err))?;

        Ok(output_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn ensure_parent_dir(path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create output directory: {}", err))?;
    }
    Ok(())
}
