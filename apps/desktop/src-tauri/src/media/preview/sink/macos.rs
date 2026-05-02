#![cfg_attr(test, allow(dead_code))]

use std::ffi::CString;
use std::sync::mpsc::sync_channel;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::{msg_send, sel, ClassType, MainThreadMarker};
use objc2_app_kit::NSView;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{AppHandle, Manager};

use crate::media::model::{PreviewSurfaceRect, PreviewViewport};

const SURFACE_VIEW_CLASS_NAME: &str = "OpenDirectorNativePreviewPassthroughView";

static SURFACE_VIEW_CLASS_REGISTERED: OnceLock<Result<&'static AnyClass, String>> = OnceLock::new();

#[derive(Debug)]
pub struct MacOsNativePreviewSurface {
    app_handle: AppHandle,
    parent_ns_view_value: usize,
    surface_ns_view_value: Option<usize>,
    last_viewport: Option<PreviewViewport>,
    last_physical_rect: Option<PreviewSurfaceRect>,
    visible: bool,
    presenting: bool,
    embedded_content_attached: bool,
}

impl MacOsNativePreviewSurface {
    pub fn attach(
        app_handle: &AppHandle,
        window_label: &str,
        surface_id: &str,
    ) -> Result<Self, String> {
        let app_handle_for_task = app_handle.clone();
        let window_label = window_label.to_string();
        let _surface_id = surface_id.to_string();

        let (parent_ns_view_value, surface_ns_view_value) =
            run_on_main_thread_result(app_handle, move || {
                let window = app_handle_for_task
                    .get_webview_window(&window_label)
                    .ok_or_else(|| {
                        format!("Preview host window was not found: {}", window_label)
                    })?;
                let parent_ns_view = window
                    .ns_view()
                    .map_err(|error| format!("Failed to resolve preview host NSView: {error}"))?;
                let surface_ns_view = create_surface_view(parent_ns_view)?;

                Ok((parent_ns_view as usize, surface_ns_view as usize))
            })?;

        Ok(Self {
            app_handle: app_handle.clone(),
            parent_ns_view_value,
            surface_ns_view_value: Some(surface_ns_view_value),
            last_viewport: None,
            last_physical_rect: None,
            visible: false,
            presenting: false,
            embedded_content_attached: false,
        })
    }

    pub fn set_viewport(&mut self, viewport: &PreviewViewport) -> Result<(), String> {
        self.last_viewport = Some(viewport.clone());
        let state = self.apply_view_state()?;
        self.visible = state.visible;
        self.last_physical_rect = state.physical_rect;
        Ok(())
    }

    pub fn set_presenting(&mut self, presenting: bool) -> Result<(), String> {
        self.presenting = presenting;
        let state = self.apply_view_state()?;
        self.visible = state.visible;
        self.last_physical_rect = state.physical_rect;
        Ok(())
    }

    pub fn host_window_handle_repr(&self) -> Option<String> {
        Some(format_ns_view(self.parent_ns_view_value))
    }

    pub fn surface_window_handle_repr(&self) -> Option<String> {
        self.surface_ns_view_value.map(format_ns_view)
    }

    pub fn surface_window_handle_value(&self) -> Option<usize> {
        self.surface_ns_view_value
    }

    pub fn physical_rect(&self) -> Option<PreviewSurfaceRect> {
        self.last_physical_rect.clone()
    }

    pub fn is_visible(&self) -> bool {
        self.visible
    }

    pub fn is_presenting(&self) -> bool {
        self.presenting
    }

    pub fn is_embedded_content_attached(&self) -> bool {
        self.embedded_content_attached
    }

    pub fn set_embedded_content_attached(&mut self, attached: bool) -> Result<(), String> {
        self.embedded_content_attached = attached;
        let state = self.apply_view_state()?;
        self.visible = state.visible;
        self.last_physical_rect = state.physical_rect;
        Ok(())
    }

    pub fn detach(&mut self) -> Result<(), String> {
        let Some(surface_ns_view_value) = self.surface_ns_view_value.take() else {
            self.visible = false;
            self.presenting = false;
            self.last_physical_rect = None;
            return Ok(());
        };

        run_on_main_thread_result(&self.app_handle, move || {
            destroy_surface_view(surface_ns_view_value as *mut NSView)
        })?;

        self.visible = false;
        self.presenting = false;
        self.last_physical_rect = None;
        self.embedded_content_attached = false;
        Ok(())
    }

    fn apply_view_state(&self) -> Result<AppliedViewState, String> {
        let Some(surface_ns_view_value) = self.surface_ns_view_value else {
            return Ok(AppliedViewState::default());
        };
        let viewport = self.last_viewport.clone();
        let parent_ns_view_value = self.parent_ns_view_value;
        let presenting = self.presenting;
        let embedded_content_attached = self.embedded_content_attached;

        run_on_main_thread_result(&self.app_handle, move || {
            apply_view_state(
                surface_ns_view_value as *mut NSView,
                parent_ns_view_value as *mut NSView,
                viewport.as_ref(),
                presenting,
                embedded_content_attached,
            )
        })
    }
}

impl Drop for MacOsNativePreviewSurface {
    fn drop(&mut self) {
        let _ = self.detach();
    }
}

fn run_on_main_thread_result<T, F>(app_handle: &AppHandle, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = sync_channel(1);
    app_handle
        .run_on_main_thread(move || {
            let _ = sender.send(task());
        })
        .map_err(|error| format!("Failed to schedule native preview surface task: {error}"))?;

    receiver
        .recv()
        .map_err(|_| "Native preview surface task did not complete".to_string())?
}

fn create_surface_view(parent_ns_view: *mut std::ffi::c_void) -> Result<*mut NSView, String> {
    if parent_ns_view.is_null() {
        return Err("Preview host NSView is null".to_string());
    }

    let parent_ns_view = parent_ns_view.cast::<NSView>();
    let _mtm = MainThreadMarker::new()
        .ok_or_else(|| "Preview surface creation must run on the main thread".to_string())?;
    let surface_view_class = ensure_surface_view_class_registered()?;
    let surface_view: Retained<NSView> = unsafe {
        msg_send![
            msg_send![surface_view_class, alloc],
            initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))
        ]
    };
    surface_view.setWantsLayer(true);
    surface_view.setHidden(true);

    unsafe {
        parent_ns_view
            .as_ref()
            .ok_or_else(|| {
                "Preview host NSView became unavailable while creating surface".to_string()
            })?
            .addSubview(&surface_view);
    }

    Ok(Retained::into_raw(surface_view))
}

fn ensure_surface_view_class_registered() -> Result<&'static AnyClass, String> {
    SURFACE_VIEW_CLASS_REGISTERED
        .get_or_init(register_surface_view_class)
        .clone()
}

fn register_surface_view_class() -> Result<&'static AnyClass, String> {
    let class_name = CString::new(SURFACE_VIEW_CLASS_NAME)
        .map_err(|error| format!("Invalid preview surface view class name: {error}"))?;
    let mut builder = ClassBuilder::new(class_name.as_c_str(), NSView::class())
        .ok_or_else(|| "Failed to register native preview passthrough NSView class".to_string())?;

    unsafe {
        builder.add_method(
            sel!(hitTest:),
            surface_view_hit_test as extern "C-unwind" fn(_, _, _) -> _,
        );
    }

    Ok(builder.register())
}

extern "C-unwind" fn surface_view_hit_test(
    _this: &AnyObject,
    _cmd: Sel,
    _point: NSPoint,
) -> *mut AnyObject {
    std::ptr::null_mut()
}

fn destroy_surface_view(surface_ns_view: *mut NSView) -> Result<(), String> {
    if surface_ns_view.is_null() {
        return Ok(());
    }

    let Some(surface_view) = (unsafe { Retained::from_raw(surface_ns_view) }) else {
        return Ok(());
    };
    surface_view.setHidden(true);
    surface_view.removeFromSuperview();
    Ok(())
}

fn apply_view_state(
    surface_ns_view: *mut NSView,
    parent_ns_view: *mut NSView,
    viewport: Option<&PreviewViewport>,
    presenting: bool,
    embedded_content_attached: bool,
) -> Result<AppliedViewState, String> {
    let Some(surface_view) = (unsafe { surface_ns_view.as_ref() }) else {
        return Ok(AppliedViewState::default());
    };
    let Some(parent_view) = (unsafe { parent_ns_view.as_ref() }) else {
        surface_view.setHidden(true);
        return Ok(AppliedViewState::default());
    };

    let parent_bounds = parent_view.bounds();
    let Some((frame, physical_rect)) =
        viewport_to_ns_frame(viewport, parent_bounds.size.height, parent_view.isFlipped())
    else {
        surface_view.setHidden(true);
        return Ok(AppliedViewState::default());
    };

    surface_view.setFrame(frame);
    let visible = presenting && embedded_content_attached;
    surface_view.setHidden(!visible);

    Ok(AppliedViewState {
        visible,
        physical_rect: Some(physical_rect),
    })
}

fn viewport_to_ns_frame(
    viewport: Option<&PreviewViewport>,
    parent_height: f64,
    parent_is_flipped: bool,
) -> Option<(NSRect, PreviewSurfaceRect)> {
    let viewport = viewport?;
    if !viewport.visible
        || !viewport.x.is_finite()
        || !viewport.y.is_finite()
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || !viewport.scale_factor.is_finite()
    {
        return None;
    }

    let width = viewport.width.max(0.0);
    let height = viewport.height.max(0.0);
    if width <= 0.0 || height <= 0.0 {
        return None;
    }

    let scale_factor = viewport.scale_factor.max(0.1);
    let physical_rect = PreviewSurfaceRect {
        x: (viewport.x * scale_factor).round() as i32,
        y: (viewport.y * scale_factor).round() as i32,
        width: (width * scale_factor).round() as i32,
        height: (height * scale_factor).round() as i32,
    };
    let y = if parent_is_flipped {
        viewport.y
    } else {
        (parent_height - viewport.y - height).max(0.0)
    };

    Some((
        NSRect::new(NSPoint::new(viewport.x, y), NSSize::new(width, height)),
        physical_rect,
    ))
}

fn format_ns_view(value: usize) -> String {
    format!("NSView(0x{value:x})")
}

#[derive(Debug, Default)]
struct AppliedViewState {
    visible: bool,
    physical_rect: Option<PreviewSurfaceRect>,
}

#[cfg(test)]
mod tests {
    use super::viewport_to_ns_frame;
    use crate::media::model::PreviewViewport;

    #[test]
    fn viewport_to_ns_frame_preserves_top_left_coordinates_for_flipped_parent_views() {
        let (frame, rect) = viewport_to_ns_frame(
            Some(&PreviewViewport {
                x: 12.0,
                y: 34.0,
                width: 320.0,
                height: 180.0,
                scale_factor: 2.0,
                visible: true,
            }),
            600.0,
            true,
        )
        .expect("visible viewport should map to a frame");

        assert_eq!(frame.origin.x, 12.0);
        assert_eq!(frame.origin.y, 34.0);
        assert_eq!(rect.x, 24);
        assert_eq!(rect.y, 68);
        assert_eq!(rect.width, 640);
        assert_eq!(rect.height, 360);
    }

    #[test]
    fn viewport_to_ns_frame_converts_top_left_coordinates_for_non_flipped_parent_views() {
        let (frame, _) = viewport_to_ns_frame(
            Some(&PreviewViewport {
                x: 12.0,
                y: 34.0,
                width: 320.0,
                height: 180.0,
                scale_factor: 2.0,
                visible: true,
            }),
            600.0,
            false,
        )
        .expect("visible viewport should map to a frame");

        assert_eq!(frame.origin.x, 12.0);
        assert_eq!(frame.origin.y, 386.0);
    }

    #[test]
    fn viewport_to_ns_frame_rejects_hidden_viewports() {
        assert!(viewport_to_ns_frame(
            Some(&PreviewViewport {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
                scale_factor: 2.0,
                visible: false,
            }),
            600.0,
            true,
        )
        .is_none());
    }
}
