use crate::media::ges::xges::{
    parse_xges_project, ParsedXgesProject, XgesImportWarning, XgesImportedAsset, XgesImportedTrack,
    XgesTimelineExportRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const OTIO_FILE_NAME: &str = "Timeline.otio.json";
const XGES_FILE_NAME: &str = "Timeline.xges";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaExchangeWarning {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaExchangeSummary {
    pub project_name: Option<String>,
    pub duration_ms: Option<f64>,
    pub track_count: Option<u32>,
    pub clip_count: Option<u32>,
    pub asset_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtioExportRequest {
    pub project_path: String,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtioImportRequest {
    pub file_path: String,
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesExportRequest {
    pub project_path: String,
    pub output_path: Option<String>,
    pub timeline: XgesTimelineExportRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesImportRequest {
    pub file_path: String,
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaExchangeExportResult {
    pub format: String,
    pub output_path: String,
    pub warnings: Vec<MediaExchangeWarning>,
    pub summary: Option<MediaExchangeSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaExchangeImportResult {
    pub format: String,
    pub source_path: String,
    pub warnings: Vec<MediaExchangeWarning>,
    pub summary: Option<MediaExchangeSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XgesImportResult {
    pub format: String,
    pub source_path: String,
    pub project_name: String,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub assets: Vec<XgesImportedAsset>,
    pub tracks: Vec<XgesImportedTrack>,
    pub total_duration: f64,
    pub warnings: Vec<MediaExchangeWarning>,
    pub summary: Option<MediaExchangeSummary>,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn export_otio(request: OtioExportRequest) -> Result<MediaExchangeExportResult, String> {
    let source_path = default_exchange_path(&request.project_path, OTIO_FILE_NAME);
    ensure_file_exists(&source_path, "OTIO source file")?;

    let output_path = match request.output_path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => source_path.clone(),
    };

    if output_path != source_path {
        copy_exchange_file(&source_path, &output_path)?;
    }

    let summary = Some(read_otio_summary(&source_path)?);

    Ok(MediaExchangeExportResult {
        format: "otio".to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        warnings: Vec::new(),
        summary,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn import_otio(request: OtioImportRequest) -> Result<MediaExchangeImportResult, String> {
    let source_path = PathBuf::from(request.file_path);
    ensure_file_exists(&source_path, "OTIO file")?;

    if let Some(project_path) = request
        .project_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        let destination = default_exchange_path(project_path, OTIO_FILE_NAME);
        copy_exchange_file(&source_path, &destination)?;
    }

    let summary = Some(read_otio_summary(&source_path)?);

    Ok(MediaExchangeImportResult {
        format: "otio".to_string(),
        source_path: source_path.to_string_lossy().to_string(),
        warnings: Vec::new(),
        summary,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn export_xges(request: XgesExportRequest) -> Result<MediaExchangeExportResult, String> {
    let source_path = default_exchange_path(&request.project_path, XGES_FILE_NAME);
    crate::media::ges::xges::export_timeline_to_xges(&request.timeline, &source_path)?;

    let output_path = match request.output_path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => source_path.clone(),
    };

    if output_path != source_path {
        copy_exchange_file(&source_path, &output_path)?;
    }

    let summary = Some(read_xges_summary(&source_path)?);

    Ok(MediaExchangeExportResult {
        format: "xges".to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        warnings: Vec::new(),
        summary,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn import_xges(request: XgesImportRequest) -> Result<XgesImportResult, String> {
    let source_path = PathBuf::from(request.file_path);
    ensure_file_exists(&source_path, "XGES file")?;

    if let Some(project_path) = request
        .project_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        let destination = default_exchange_path(project_path, XGES_FILE_NAME);
        copy_exchange_file(&source_path, &destination)?;
    }

    let parsed = read_xges_project(&source_path)?;
    Ok(build_xges_import_result(&source_path, parsed))
}

fn default_exchange_path(project_path: &str, file_name: &str) -> PathBuf {
    Path::new(project_path).join(file_name)
}

fn ensure_file_exists(path: &Path, label: &str) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }

    Err(format!("{label} not found: {}", path.display()))
}

fn copy_exchange_file(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create directory {}: {err}", parent.display()))?;
    }

    fs::copy(source, destination).map_err(|err| {
        format!(
            "Failed to copy exchange file from {} to {}: {err}",
            source.display(),
            destination.display()
        )
    })?;

    Ok(())
}

fn read_otio_summary(path: &Path) -> Result<MediaExchangeSummary, String> {
    let contents = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read OTIO file {}: {err}", path.display()))?;
    parse_otio_summary(&contents)
}

fn read_xges_summary(path: &Path) -> Result<MediaExchangeSummary, String> {
    let parsed = read_xges_project(path)?;
    Ok(summarize_xges_project(&parsed))
}

fn read_xges_project(path: &Path) -> Result<ParsedXgesProject, String> {
    let contents = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read XGES file {}: {err}", path.display()))?;
    parse_xges_project(&contents)
}

fn parse_otio_summary(contents: &str) -> Result<MediaExchangeSummary, String> {
    let root: Value = serde_json::from_str(contents)
        .map_err(|err| format!("Failed to parse OTIO JSON: {err}"))?;

    let tracks = root
        .get("tracks")
        .and_then(Value::as_object)
        .and_then(|tracks| tracks.get("children"))
        .and_then(Value::as_array);

    let mut clip_count = 0u32;
    let mut asset_urls = HashSet::new();
    let mut total_duration_ms = 0.0_f64;

    if let Some(track_entries) = tracks {
        for track in track_entries {
            let mut track_duration_ms = 0.0_f64;
            let children = track
                .get("children")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            for item in children {
                if let Some(schema) = item.get("OTIO_SCHEMA").and_then(Value::as_str) {
                    match schema {
                        "Gap.1" | "Clip.1" => {
                            track_duration_ms += otio_duration_ms(&item);
                            if schema == "Clip.1" {
                                clip_count += 1;
                                if let Some(target_url) = item
                                    .get("media_reference")
                                    .and_then(Value::as_object)
                                    .and_then(|reference| reference.get("target_url"))
                                    .and_then(Value::as_str)
                                {
                                    asset_urls.insert(target_url.to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }

            total_duration_ms = total_duration_ms.max(track_duration_ms);
        }
    }

    Ok(MediaExchangeSummary {
        project_name: root
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        duration_ms: if total_duration_ms > 0.0 {
            Some(total_duration_ms)
        } else {
            None
        },
        track_count: tracks.map(|entries| entries.len() as u32),
        clip_count: Some(clip_count),
        asset_count: Some(asset_urls.len() as u32),
    })
}

fn otio_duration_ms(item: &Value) -> f64 {
    let duration = item
        .get("source_range")
        .and_then(Value::as_object)
        .and_then(|range| range.get("duration"))
        .and_then(Value::as_object);

    let value = duration
        .and_then(|duration| duration.get("value"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let rate = duration
        .and_then(|duration| duration.get("rate"))
        .and_then(Value::as_f64)
        .filter(|rate| *rate > 0.0)
        .unwrap_or(30.0);

    (value / rate) * 1000.0
}

fn summarize_xges_project(project: &ParsedXgesProject) -> MediaExchangeSummary {
    MediaExchangeSummary {
        project_name: Some(project.project_name.clone()),
        duration_ms: Some(project.total_duration),
        track_count: Some(project.tracks.len() as u32),
        clip_count: Some(
            project
                .tracks
                .iter()
                .map(|track| track.fragments.len() as u32)
                .sum(),
        ),
        asset_count: Some(project.assets.len() as u32),
    }
}

fn build_xges_import_result(source_path: &Path, project: ParsedXgesProject) -> XgesImportResult {
    let ParsedXgesProject {
        project_name,
        fps,
        width,
        height,
        assets,
        tracks,
        total_duration,
        warnings,
    } = project;
    let warnings = warnings
        .into_iter()
        .map(map_xges_warning)
        .collect::<Vec<_>>();
    let summary = Some(MediaExchangeSummary {
        project_name: Some(project_name.clone()),
        duration_ms: Some(total_duration),
        track_count: Some(tracks.len() as u32),
        clip_count: Some(
            tracks
                .iter()
                .map(|track| track.fragments.len() as u32)
                .sum(),
        ),
        asset_count: Some(assets.len() as u32),
    });

    XgesImportResult {
        format: "xges".to_string(),
        source_path: source_path.to_string_lossy().to_string(),
        project_name,
        fps,
        width,
        height,
        assets,
        tracks,
        total_duration,
        warnings,
        summary,
    }
}

fn map_xges_warning(warning: XgesImportWarning) -> MediaExchangeWarning {
    MediaExchangeWarning {
        code: warning.code,
        message: warning.message,
        path: warning.path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parse_otio_summary_extracts_counts_and_duration() {
        let json = r#"{
          "OTIO_SCHEMA": "Timeline.1",
          "name": "Import Test",
          "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "children": [
              {
                "OTIO_SCHEMA": "Track.1",
                "children": [
                  {
                    "OTIO_SCHEMA": "Gap.1",
                    "source_range": {
                      "OTIO_SCHEMA": "TimeRange.1",
                      "start_time": { "OTIO_SCHEMA": "RationalTime.1", "rate": 25, "value": 0 },
                      "duration": { "OTIO_SCHEMA": "RationalTime.1", "rate": 25, "value": 25 }
                    }
                  },
                  {
                    "OTIO_SCHEMA": "Clip.1",
                    "media_reference": { "target_url": "file:///C:/media/a.mp4" },
                    "source_range": {
                      "OTIO_SCHEMA": "TimeRange.1",
                      "start_time": { "OTIO_SCHEMA": "RationalTime.1", "rate": 25, "value": 0 },
                      "duration": { "OTIO_SCHEMA": "RationalTime.1", "rate": 25, "value": 50 }
                    }
                  }
                ]
              },
              {
                "OTIO_SCHEMA": "Track.1",
                "children": [
                  {
                    "OTIO_SCHEMA": "Clip.1",
                    "media_reference": { "target_url": "file:///C:/media/b.wav" },
                    "source_range": {
                      "OTIO_SCHEMA": "TimeRange.1",
                      "start_time": { "OTIO_SCHEMA": "RationalTime.1", "rate": 25, "value": 0 },
                      "duration": { "OTIO_SCHEMA": "RationalTime.1", "rate": 25, "value": 25 }
                    }
                  }
                ]
              }
            ]
          }
        }"#;

        let summary = parse_otio_summary(json).expect("summary should parse");
        assert_eq!(summary.project_name.as_deref(), Some("Import Test"));
        assert_eq!(summary.track_count, Some(2));
        assert_eq!(summary.clip_count, Some(2));
        assert_eq!(summary.asset_count, Some(2));
        assert_eq!(summary.duration_ms, Some(3000.0));
    }

    #[test]
    fn import_otio_copies_into_project_directory() {
        let temp_dir = unique_temp_dir();
        let source_dir = temp_dir.join("source");
        let project_dir = temp_dir.join("project");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&project_dir).expect("project dir");

        let source_file = source_dir.join("example.otio.json");
        fs::write(
            &source_file,
            r#"{
              "OTIO_SCHEMA": "Timeline.1",
              "name": "Import Shell",
              "tracks": { "OTIO_SCHEMA": "Stack.1", "children": [] }
            }"#,
        )
        .expect("write source");

        let request = OtioImportRequest {
            file_path: source_file.to_string_lossy().to_string(),
            project_path: Some(project_dir.to_string_lossy().to_string()),
        };

        let result = tauri::async_runtime::block_on(import_otio(request)).expect("import otio");
        let imported_file = project_dir.join(OTIO_FILE_NAME);

        assert_eq!(result.format, "otio");
        assert!(imported_file.is_file());
    }

    #[test]
    fn summarize_xges_project_extracts_counts() {
        let xges = r#"
            <ges version='0.7'>
              <project properties='properties, name=(string)GES Demo;'>
                <ressources>
                  <asset id='file:///C:/media/a.png' extractable-type-name='GESUriClip' properties='properties, supported-formats=(int)4;' metadatas='metadatas;'>
                    <stream-info extractable-type-name='GESVideoUriSource' properties='properties, track-type=(int)4;' metadatas='metadatas;' caps='image/png, width=(int)512, height=(int)512'/>
                  </asset>
                  <asset id='file:///C:/media/b.wav' extractable-type-name='GESUriClip' properties='properties, supported-formats=(int)2, duration=(guint64)2000000000;' metadatas='metadatas;'>
                    <stream-info extractable-type-name='GESAudioUriSource' properties='properties, track-type=(int)2;' metadatas='metadatas;' caps='audio/x-wav'/>
                  </asset>
                </ressources>
                <timeline>
                  <track track-type='4' track-id='0' properties='properties, restriction-caps=(string)&quot;video/x-raw\,\ width\=\(int\)1920\,\ height\=\(int\)1080\,\ framerate\=\(fraction\)30/1&quot;;' />
                  <track track-type='2' track-id='1' properties='properties;' />
                  <layer priority='0'>
                    <clip id='0' asset-id='file:///C:/media/a.png' track-types='4' start='0' duration='1000000000' inpoint='0' properties='properties, name=(string)A;'>
                      <source track-id='0' properties='properties, track-type=(int)4;' children-properties='properties;' />
                    </clip>
                    <clip id='1' asset-id='file:///C:/media/b.wav' track-types='2' start='500000000' duration='1500000000' inpoint='0' properties='properties, name=(string)B;'>
                      <source track-id='1' properties='properties, track-type=(int)2;' children-properties='properties, GstVolume::mute=(boolean)false, GstVolume::volume=(double)1;' />
                    </clip>
                  </layer>
                </timeline>
              </project>
            </ges>
        "#;

        let parsed = parse_xges_project(xges).expect("xges should parse");
        let summary = summarize_xges_project(&parsed);
        assert_eq!(summary.project_name.as_deref(), Some("GES Demo"));
        assert_eq!(summary.track_count, Some(2));
        assert_eq!(summary.clip_count, Some(2));
        assert_eq!(summary.asset_count, Some(2));
        assert_eq!(summary.duration_ms, Some(2000.0));
    }

    #[test]
    fn import_xges_parses_timeline_and_copies_into_project_directory() {
        let temp_dir = unique_temp_dir();
        let source_dir = temp_dir.join("source");
        let project_dir = temp_dir.join("project");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&project_dir).expect("project dir");

        let source_file = source_dir.join("example.xges");
        fs::write(
            &source_file,
            r#"
            <ges version='0.7'>
              <project properties='properties, name=(string)Import Shell;'>
                <ressources>
                  <asset id='file:///C:/media/a.png' extractable-type-name='GESUriClip' properties='properties, supported-formats=(int)4;' metadatas='metadatas;'>
                    <stream-info extractable-type-name='GESVideoUriSource' properties='properties, track-type=(int)4;' metadatas='metadatas;' caps='image/png, width=(int)512, height=(int)512'/>
                  </asset>
                </ressources>
                <timeline>
                  <track track-type='4' track-id='0' properties='properties, restriction-caps=(string)&quot;video/x-raw\,\ width\=\(int\)1280\,\ height\=\(int\)720\,\ framerate\=\(fraction\)25/1&quot;;' />
                  <layer priority='0'>
                    <clip id='0' asset-id='file:///C:/media/a.png' track-types='4' start='0' duration='1000000000' inpoint='0' properties='properties, name=(string)Still;'>
                      <source track-id='0' properties='properties, track-type=(int)4;' children-properties='properties;' />
                    </clip>
                  </layer>
                </timeline>
              </project>
            </ges>
            "#,
        )
        .expect("write source");

        let request = XgesImportRequest {
            file_path: source_file.to_string_lossy().to_string(),
            project_path: Some(project_dir.to_string_lossy().to_string()),
        };

        let result = tauri::async_runtime::block_on(import_xges(request)).expect("import xges");
        let imported_file = project_dir.join(XGES_FILE_NAME);

        assert_eq!(result.format, "xges");
        assert_eq!(result.project_name, "Import Shell");
        assert_eq!(result.width, 1280);
        assert_eq!(result.height, 720);
        assert_eq!(result.tracks.len(), 1);
        assert_eq!(result.assets.len(), 1);
        assert!(imported_file.is_file());
    }

    fn unique_temp_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("opendirector-otio-{unique}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }
}
