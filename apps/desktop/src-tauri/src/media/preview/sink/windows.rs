#![cfg_attr(test, allow(dead_code))]

use std::sync::mpsc::sync_channel;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, FillRect, GetStockObject, InvalidateRect, BLACK_BRUSH, HBRUSH,
    PAINTSTRUCT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, RegisterClassW, SetWindowPos,
    ShowWindow, CW_USEDEFAULT, HTTRANSPARENT, HWND_TOP, MA_NOACTIVATE, SWP_HIDEWINDOW,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_NCHITTEST, WM_PAINT,
    WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

use crate::media::model::{PreviewSurfaceRect, PreviewViewport};

const SURFACE_WINDOW_CLASS_NAME: &str = "OpenDirectorNativePreviewSurface";

static WINDOW_CLASS_REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Debug)]
pub struct WindowsNativePreviewSurface {
    app_handle: AppHandle,
    parent_hwnd_value: usize,
    surface_hwnd_value: Option<usize>,
    last_viewport: Option<PreviewViewport>,
    last_physical_rect: Option<PreviewSurfaceRect>,
    visible: bool,
    presenting: bool,
    embedded_content_attached: bool,
}

impl WindowsNativePreviewSurface {
    pub fn attach(
        app_handle: &AppHandle,
        window_label: &str,
        surface_id: &str,
    ) -> Result<Self, String> {
        let app_handle_for_task = app_handle.clone();
        let window_label = window_label.to_string();
        let _surface_id = surface_id.to_string();

        let (parent_hwnd_value, surface_hwnd_value) =
            run_on_main_thread_result(app_handle, move || {
                ensure_surface_window_class_registered()?;

                let window = app_handle_for_task
                    .get_webview_window(&window_label)
                    .ok_or_else(|| {
                        format!("Preview host window was not found: {}", window_label)
                    })?;
                let parent_hwnd = window
                    .hwnd()
                    .map_err(|error| format!("Failed to resolve preview host HWND: {error}"))?;
                let surface_hwnd = create_surface_window(parent_hwnd)?;

                Ok((parent_hwnd.0 as usize, surface_hwnd.0 as usize))
            })?;

        Ok(Self {
            app_handle: app_handle.clone(),
            parent_hwnd_value,
            surface_hwnd_value: Some(surface_hwnd_value),
            last_viewport: None,
            last_physical_rect: None,
            visible: false,
            presenting: false,
            embedded_content_attached: false,
        })
    }

    pub fn set_viewport(&mut self, viewport: &PreviewViewport) -> Result<(), String> {
        self.last_viewport = Some(viewport.clone());
        let state = self.apply_window_state()?;
        self.visible = state.visible;
        self.last_physical_rect = state.physical_rect;
        Ok(())
    }

    pub fn set_presenting(&mut self, presenting: bool) -> Result<(), String> {
        self.presenting = presenting;
        let state = self.apply_window_state()?;
        self.visible = state.visible;
        self.last_physical_rect = state.physical_rect;
        Ok(())
    }

    pub fn host_window_handle_repr(&self) -> Option<String> {
        Some(format_hwnd(self.parent_hwnd_value))
    }

    pub fn surface_window_handle_repr(&self) -> Option<String> {
        self.surface_hwnd_value.map(format_hwnd)
    }

    pub fn surface_window_handle_value(&self) -> Option<usize> {
        self.surface_hwnd_value
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
        let state = self.apply_window_state()?;
        self.visible = state.visible;
        self.last_physical_rect = state.physical_rect;
        Ok(())
    }

    pub fn detach(&mut self) -> Result<(), String> {
        let Some(surface_hwnd_value) = self.surface_hwnd_value.take() else {
            self.visible = false;
            self.presenting = false;
            self.last_physical_rect = None;
            return Ok(());
        };

        run_on_main_thread_result(&self.app_handle, move || {
            destroy_surface_window(HWND(surface_hwnd_value as _))
        })?;

        self.visible = false;
        self.presenting = false;
        self.last_physical_rect = None;
        self.embedded_content_attached = false;
        Ok(())
    }

    fn apply_window_state(&self) -> Result<AppliedWindowState, String> {
        let Some(surface_hwnd_value) = self.surface_hwnd_value else {
            return Ok(AppliedWindowState::default());
        };
        let viewport = self.last_viewport.clone();
        let presenting = self.presenting;
        let embedded_content_attached = self.embedded_content_attached;

        run_on_main_thread_result(&self.app_handle, move || {
            apply_window_state(
                HWND(surface_hwnd_value as _),
                viewport.as_ref(),
                presenting,
                embedded_content_attached,
            )
        })
    }
}

impl Drop for WindowsNativePreviewSurface {
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

fn ensure_surface_window_class_registered() -> Result<(), String> {
    WINDOW_CLASS_REGISTERED
        .get_or_init(register_surface_window_class)
        .clone()
}

fn register_surface_window_class() -> Result<(), String> {
    let class_name = encode_wide_null_terminated(SURFACE_WINDOW_CLASS_NAME);
    let instance = unsafe {
        GetModuleHandleW(None).map_err(|error| {
            format!("Failed to resolve module handle for preview surface class: {error}")
        })?
    };

    let class = WNDCLASSW {
        hInstance: HINSTANCE(instance.0),
        lpszClassName: PCWSTR(class_name.as_ptr()),
        lpfnWndProc: Some(surface_window_proc),
        hbrBackground: HBRUSH(unsafe { GetStockObject(BLACK_BRUSH).0 }),
        ..Default::default()
    };

    let atom = unsafe { RegisterClassW(&class) };
    if atom == 0 {
        return Err("Failed to register native preview surface window class".to_string());
    }

    Ok(())
}

fn create_surface_window(parent_hwnd: HWND) -> Result<HWND, String> {
    let class_name = encode_wide_null_terminated(SURFACE_WINDOW_CLASS_NAME);
    let instance = unsafe {
        GetModuleHandleW(None)
            .map(|module| HINSTANCE(module.0))
            .map_err(|error| {
                format!("Failed to resolve module handle for preview surface: {error}")
            })?
    };

    let surface_hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            Some(parent_hwnd),
            None,
            Some(instance),
            None,
        )
        .map_err(|error| format!("Failed to create native preview surface window: {error}"))?
    };

    unsafe {
        SetWindowPos(
            surface_hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|error| format!("Failed to initialize native preview surface window: {error}"))?;
        let _ = ShowWindow(surface_hwnd, SW_HIDE);
    }

    Ok(surface_hwnd)
}

fn destroy_surface_window(hwnd: HWND) -> Result<(), String> {
    unsafe {
        DestroyWindow(hwnd)
            .map_err(|error| format!("Failed to destroy native preview surface window: {error}"))
    }
}

fn apply_window_state(
    surface_hwnd: HWND,
    viewport: Option<&PreviewViewport>,
    presenting: bool,
    _embedded_content_attached: bool,
) -> Result<AppliedWindowState, String> {
    let Some(rect) = viewport.and_then(|value| viewport_to_physical_rect(value)) else {
        hide_surface_window(surface_hwnd)?;
        return Ok(AppliedWindowState::default());
    };
    let x = rect.x;
    let y = rect.y;
    let width = rect.width;
    let height = rect.height;

    // Preserve empty-surface visibility while presenting so debugPresentSurface can
    // still validate host attachment and viewport placement before media binds.
    if !presenting {
        unsafe {
            SetWindowPos(
                surface_hwnd,
                Some(HWND_TOP),
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_HIDEWINDOW,
            )
            .map_err(|error| format!("Failed to stage native preview surface window: {error}"))?;
        }
        return Ok(AppliedWindowState {
            visible: false,
            physical_rect: Some(rect),
        });
    }

    unsafe {
        SetWindowPos(
            surface_hwnd,
            Some(HWND_TOP),
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|error| format!("Failed to move native preview surface window: {error}"))?;
        let _ = ShowWindow(surface_hwnd, SW_SHOWNOACTIVATE);
        let _ = InvalidateRect(Some(surface_hwnd), None, true);
    }

    Ok(AppliedWindowState {
        visible: true,
        physical_rect: Some(rect),
    })
}

fn hide_surface_window(surface_hwnd: HWND) -> Result<(), String> {
    unsafe {
        SetWindowPos(
            surface_hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .map_err(|error| format!("Failed to hide native preview surface window: {error}"))?;
        let _ = ShowWindow(surface_hwnd, SW_HIDE);
    }
    Ok(())
}

fn viewport_to_physical_rect(viewport: &PreviewViewport) -> Option<PreviewSurfaceRect> {
    if !viewport.visible
        || !viewport.x.is_finite()
        || !viewport.y.is_finite()
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || !viewport.scale_factor.is_finite()
    {
        return None;
    }

    let scale_factor = viewport.scale_factor.max(0.1);
    let x = (viewport.x * scale_factor).round() as i32;
    let y = (viewport.y * scale_factor).round() as i32;
    let width = (viewport.width * scale_factor).round().max(0.0) as i32;
    let height = (viewport.height * scale_factor).round().max(0.0) as i32;

    if width <= 0 || height <= 0 {
        return None;
    }

    Some(PreviewSurfaceRect {
        x,
        y,
        width,
        height,
    })
}

fn encode_wide_null_terminated(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn format_hwnd(hwnd_value: usize) -> String {
    format!("0x{:X}", hwnd_value)
}

#[derive(Debug, Clone, Default)]
struct AppliedWindowState {
    visible: bool,
    physical_rect: Option<PreviewSurfaceRect>,
}

unsafe extern "system" fn surface_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut paint) };
            let mut rect = RECT::default();
            let _ = unsafe { GetClientRect(hwnd, &mut rect) };
            unsafe {
                FillRect(hdc, &rect, HBRUSH(GetStockObject(BLACK_BRUSH).0));
                let _ = EndPaint(hwnd, &paint);
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

#[cfg(test)]
mod tests {
    use super::viewport_to_physical_rect;
    use crate::media::model::PreviewViewport;

    #[test]
    fn viewport_to_physical_rect_scales_css_pixels() {
        let rect = viewport_to_physical_rect(&PreviewViewport {
            x: 10.25,
            y: 20.25,
            width: 320.0,
            height: 180.0,
            scale_factor: 1.25,
            visible: true,
        })
        .expect("viewport should map to a physical rect");

        assert_eq!(rect.x, 13);
        assert_eq!(rect.y, 25);
        assert_eq!(rect.width, 400);
        assert_eq!(rect.height, 225);
    }

    #[test]
    fn viewport_to_physical_rect_rejects_hidden_or_empty_viewports() {
        assert!(viewport_to_physical_rect(&PreviewViewport {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 100.0,
            scale_factor: 1.0,
            visible: true,
        })
        .is_none());

        assert!(viewport_to_physical_rect(&PreviewViewport {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            scale_factor: 1.0,
            visible: false,
        })
        .is_none());
    }
}
