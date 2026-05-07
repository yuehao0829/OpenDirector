use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use super::error::MediaResult;

pub struct DecodedAudio {
    pub samples: Vec<f32>,
    pub channels: usize,
}

pub fn decode_audio_samples(path: &str) -> MediaResult<DecodedAudio> {
    let ext = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "wav" => decode_wav(path),
        _ => decode_symphonia(path),
    }
}

pub fn decode_wav(path: &str) -> MediaResult<DecodedAudio> {
    let reader =
        hound::WavReader::open(path).map_err(|err| format!("failed to open WAV: {err}"))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;

    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .filter_map(Result::ok)
            .collect(),
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            if bits <= 8 {
                reader
                    .into_samples::<i8>()
                    .filter_map(Result::ok)
                    .map(|sample| sample as f32 / 127.0)
                    .collect()
            } else if bits <= 16 {
                reader
                    .into_samples::<i16>()
                    .filter_map(Result::ok)
                    .map(|sample| sample as f32 / i16::MAX as f32)
                    .collect()
            } else if bits <= 24 {
                const PCM_24_MAX: f32 = 8_388_607.0;
                reader
                    .into_samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|sample| (sample as f32 / PCM_24_MAX).clamp(-1.0, 1.0))
                    .collect()
            } else {
                reader
                    .into_samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|sample| sample as f32 / i32::MAX as f32)
                    .collect()
            }
        }
    };

    if channels == 0 {
        return Err("WAV has no channels".to_string());
    }

    let (samples, channels) = if channels <= 2 {
        (samples, channels)
    } else {
        (downmix_to_mono(samples, channels)?, 1)
    };

    Ok(DecodedAudio { samples, channels })
}

pub fn decode_symphonia(path: &str) -> MediaResult<DecodedAudio> {
    let mut hint = Hint::new();
    if let Some(extension) = Path::new(path).extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let source = std::fs::File::open(path).map_err(|err| format!("failed to open file: {err}"))?;
    let stream = MediaSourceStream::new(Box::new(source), Default::default());

    let probe = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|err| format!("unsupported format: {err}"))?;

    let mut format_reader = probe.format;
    let track = format_reader
        .tracks()
        .iter()
        .find(|track| track.codec_params.sample_rate.is_some())
        .or_else(|| {
            format_reader
                .tracks()
                .iter()
                .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or("no audio track found")?;

    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|err| {
            format!(
                "no decoder available for codec {:?}: {err}",
                track.codec_params.codec
            )
        })?;

    let channels = track
        .codec_params
        .channels
        .map(|value| value.count())
        .unwrap_or(1);
    let output_channels = channels.clamp(1, 2);
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut all_samples = Vec::new();

    loop {
        let packet = match format_reader.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => continue,
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(err) => return Err(format!("decode error: {err}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder
            .decode(&packet)
            .map_err(|err| format!("decode error: {err}"))?;
        sample_rate = sample_rate.max(decoded.spec().rate);

        let input_channels = decoded.spec().channels.count();
        let mut sample_buffer =
            SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        sample_buffer.copy_interleaved_ref(decoded);
        let interleaved = sample_buffer.samples();

        match input_channels {
            0 => return Err("no audio channels found".to_string()),
            1 | 2 => all_samples.extend_from_slice(interleaved),
            _ => {
                for frame in interleaved.chunks(input_channels) {
                    if frame.is_empty() {
                        continue;
                    }
                    all_samples.push(frame[0]);
                    if output_channels >= 2 {
                        all_samples.push(*frame.get(1).unwrap_or(&frame[0]));
                    }
                }
            }
        }
    }

    if sample_rate == 0 {
        return Err("audio track has no sample rate".to_string());
    }

    Ok(DecodedAudio {
        samples: all_samples,
        channels: output_channels,
    })
}

pub fn downmix_to_mono(samples: Vec<f32>, channels: usize) -> MediaResult<Vec<f32>> {
    if channels <= 1 {
        return Ok(samples);
    }

    let mono_len = samples.len() / channels;
    let mut mono = Vec::with_capacity(mono_len);

    for frame_index in 0..mono_len {
        let mut sum = 0.0_f32;
        for channel_index in 0..channels {
            let sample_index = frame_index * channels + channel_index;
            if sample_index < samples.len() {
                sum += samples[sample_index];
            }
        }
        mono.push(sum / channels as f32);
    }

    Ok(mono)
}
