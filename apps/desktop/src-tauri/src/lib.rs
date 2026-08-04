mod commands;
mod crypto;
mod db;
mod media;

use commands::asset_task::AssetTaskManager;
use commands::generation_log::GenerationLogManager;
use commands::generation_task::GenerationTaskManager;
use commands::minimax_tts::MinimaxTaskManager;
use commands::seedance_api::SeedanceState;
use commands::seedaudio_tts::SeedAudioTaskManager;
use db::DbState;
use media::preview::PreviewSessionManager;
use tauri::Manager;

fn register_dev_pid_file() {
    let Ok(pid_file_path) = std::env::var("OPENDIRECTOR_DEV_PID_FILE") else {
        return;
    };

    if pid_file_path.is_empty() {
        return;
    }

    if let Some(parent) = std::path::Path::new(&pid_file_path).parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!(
                "[Desktop Dev] Failed to create PID file parent directory {}: {error}",
                parent.display()
            );
            return;
        }
    }

    if let Err(error) = std::fs::write(&pid_file_path, format!("{}\n", std::process::id())) {
        eprintln!(
            "[Desktop Dev] Failed to write PID file {}: {error}",
            pid_file_path
        );
    }
}

#[cfg(all(dev, target_os = "macos"))]
fn restore_dev_dock_icon<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    use std::path::PathBuf;
    use std::sync::mpsc::sync_channel;

    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSBitmapImageRep, NSDeviceRGBColorSpace, NSImage};
    use objc2_foundation::NSSize;

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let icon_path = manifest_dir.join("icons/icon.png");

    if !icon_path.exists() {
        eprintln!("[macOS] Dock icon restore skipped: icons/icon.png was not found.");
        return;
    }

    let decoded = match image::open(&icon_path) {
        Ok(image) => image.into_rgba8(),
        Err(error) => {
            eprintln!(
                "[macOS] Dock icon restore skipped: failed to decode {}: {error}",
                icon_path.display()
            );
            return;
        }
    };

    let width = decoded.width();
    let height = decoded.height();
    let rgba = decoded.into_raw();
    let (sender, receiver) = sync_channel(1);
    if let Err(error) = app_handle.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let Some(mtm) = MainThreadMarker::new() else {
                return Err("Dock icon restore must run on the main thread".to_string());
            };
            let app = NSApplication::sharedApplication(mtm);

            let bitmap = unsafe {
                NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                    NSBitmapImageRep::alloc(),
                    std::ptr::null_mut(),
                    width as isize,
                    height as isize,
                    8,
                    4,
                    true,
                    false,
                    NSDeviceRGBColorSpace,
                    (width * 4) as isize,
                    32,
                )
            }
            .ok_or_else(|| "failed to allocate Dock icon bitmap".to_string())?;

            let bitmap_data = bitmap.bitmapData();
            if bitmap_data.is_null() {
                return Err("Dock icon bitmap data buffer is null".to_string());
            }

            unsafe {
                std::ptr::copy_nonoverlapping(rgba.as_ptr(), bitmap_data, rgba.len());
            }

            let icon = NSImage::initWithSize(
                NSImage::alloc(),
                NSSize::new(width as f64, height as f64),
            );
            icon.addRepresentation(&bitmap);
            unsafe {
                app.setApplicationIconImage(Some(&icon));
            }
            if app.applicationIconImage().is_none() {
                return Err("Dock icon was not retained by NSApplication".to_string());
            }
            Ok(())
        })();

        let _ = sender.send(result);
    }) {
        eprintln!("[macOS] Dock icon restore scheduling failed: {error}");
        return;
    }

    match receiver.recv() {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("[macOS] Dock icon restore failed: {error}"),
        Err(_) => eprintln!("[macOS] Dock icon restore failed: main-thread task did not complete."),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(SeedanceState::new())
        .invoke_handler(tauri::generate_handler![
            commands::asset_file::copy_asset_file,
            commands::thumbnail::generate_video_thumbnail,
            commands::thumbnail::generate_image_thumbnail,
            commands::thumbnail::generate_audio_peakdata,
            commands::metadata::get_media_metadata,
            commands::provider_key::has_provider_credentials,
            commands::provider_key::save_provider_credentials,
            commands::provider_key::delete_provider_credentials,
            commands::provider_key::update_provider_credentials,
            commands::provider_config::export_multi_provider_config,
            commands::provider_config::verify_multi_provider_config,
            commands::provider_config::import_multi_provider_config,
            commands::generation_task::seedance_start_generation,
            commands::generation_task::seedance_cancel_generation,
            commands::generation_task::list_pending_tasks,
            commands::generation_task::seedance_resume_generation,
            commands::generation_task::acknowledge_task,
            commands::generation_task::seedance_batch_query_tasks,
            commands::minimax_tts::minimax_tts_start_generation,
            commands::minimax_tts::minimax_tts_cancel_generation,
            commands::minimax_tts::minimax_tts_resume_generation,
            commands::minimax_tts::minimax_get_voices,
            commands::seedaudio_tts::seedaudio_tts_start_generation,
            commands::seedaudio_tts::seedaudio_tts_cancel_generation,
            commands::seedaudio_tts::seedaudio_tts_resume_generation,
            commands::generation_log::write_generation_log,
            commands::seedance_api::seedance_create_task,
            commands::seedance_api::seedance_get_task_status,
            commands::seedance_api::seedance_create_asset_group,
            commands::seedance_api::seedance_list_asset_groups,
            commands::seedance_api::seedance_list_assets,
            commands::seedance_api::seedance_get_asset,
            commands::seedance_api::seedance_delete_asset,
            commands::seedance_api::seedance_create_asset,
            commands::seedance_api::download_generation_video,
            commands::seedance_api::download_generation_image,
            commands::openai_image::openai_generate_image,
            commands::tos_api::tos_presign_url,
            commands::tos_api::tos_delete_object,
            commands::tos_api::validate_tos_credentials,
            commands::tos_api::tos_upload_local_file,
            commands::asset_task::start_asset_upload,
            commands::asset_task::cancel_asset_upload,
            commands::media::media_process,
            commands::media::media_concat,
            commands::media::media_probe,
            commands::media::media_render_timeline,
            commands::media_preview::media_preview_create_session,
            commands::media_preview::media_preview_destroy_session,
            commands::media_preview::media_preview_attach_surface,
            commands::media_preview::media_preview_set_viewport,
            commands::media_preview::media_preview_set_surface_presenting,
            commands::media_preview::media_preview_set_timeline,
            commands::media_preview::media_preview_play,
            commands::media_preview::media_preview_play_from,
            commands::media_preview::media_preview_pause,
            commands::media_preview::media_preview_seek,
            commands::media_preview::media_preview_step_frame,
            commands::media_preview::media_preview_set_rate,
            commands::media_preview::media_preview_get_diagnostics,
            commands::media_exchange::export_otio,
            commands::media_exchange::import_otio,
            commands::media_exchange::export_xges,
            commands::media_exchange::import_xges,
            // Database commands
            commands::db::db_create_project,
            commands::db::db_save_project,
            commands::db::db_load_project,
            commands::db::db_list_projects,
            commands::db::db_delete_project,
            commands::db::db_autosave,
            commands::db::db_list_autosaves,
            commands::db::db_clear_autosaves,
            commands::db::db_get_preference,
            commands::db::db_set_preference,
            commands::db::db_save_asset,
            commands::db::db_get_asset,
            commands::db::db_get_assets_by_project,
            commands::db::db_get_assets_by_source,
            commands::db::db_search_assets,
            commands::db::db_delete_asset,
            commands::db::db_create_generation,
            commands::db::db_update_generation,
            commands::db::db_get_generation,
            commands::db::db_get_generations_by_project,
            commands::db::db_get_generations_by_fragment,
            commands::db::db_delete_generation,
            commands::db::db_delete_generations_by_fragment,
            commands::db::db_get_project_by_folder_path,
            commands::db::db_add_to_library,
            commands::db::db_get_library_assets,
            commands::db::db_remove_from_library,
        ])
        .setup(|app| {
            register_dev_pid_file();
            media::runtime::initialize();

            let preview_manager =
                std::sync::Arc::new(PreviewSessionManager::new(app.handle().clone()));
            app.manage(preview_manager);

            // Initialize database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");
            let db_path = app_data_dir.join("opendirector.db");
            let db_state =
                DbState::new(db_path.to_str().unwrap()).expect("Failed to initialize database");
            app.manage(db_state);

            let client = app.state::<SeedanceState>().http.clone();
            let log_manager = GenerationLogManager::new();
            app.manage(GenerationTaskManager::new(
                app.handle().clone(),
                client.clone(),
                log_manager.clone(),
            ));
            app.manage(MinimaxTaskManager::new(
                app.handle().clone(),
                client.clone(),
                log_manager.clone(),
            ));
            app.manage(SeedAudioTaskManager::new(log_manager.clone()));
            app.manage(AssetTaskManager::new(
                app.handle().clone(),
                client,
                log_manager.clone(),
            ));
            app.manage(log_manager);

            let window_builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("OpenDirector")
            .inner_size(1400.0, 900.0)
            .min_inner_size(1024.0, 768.0)
            .resizable(true)
            .decorations(false)
            .disable_drag_drop_handler();

            #[cfg(all(debug_assertions, target_os = "windows"))]
            let window_builder = window_builder.additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-breakpad --disable-crash-reporter",
            );

            let _window = window_builder.build()?;

            #[cfg(debug_assertions)]
            if std::env::var("OPENDIRECTOR_OPEN_DEVTOOLS").as_deref() == Ok("1") {
                _window.open_devtools();
            }

            #[cfg(all(dev, target_os = "macos"))]
            restore_dev_dock_icon(&app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
