use crate::media::model::{PreviewSurfaceRect, PreviewViewport};

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(test)]
mod test_stub;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(test)]
type PlatformNativePreviewSurface = test_stub::TestNativePreviewSurface;
#[cfg(all(target_os = "macos", not(test)))]
type PlatformNativePreviewSurface = macos::MacOsNativePreviewSurface;
#[cfg(not(any(test, target_os = "macos", target_os = "windows")))]
type PlatformNativePreviewSurface = UnsupportedNativePreviewSurface;
#[cfg(all(target_os = "windows", not(test)))]
type PlatformNativePreviewSurface = windows::WindowsNativePreviewSurface;

#[derive(Debug)]
pub struct NativePreviewSurface {
    inner: PlatformNativePreviewSurface,
}

impl NativePreviewSurface {
    pub fn attach(
        app_handle: &tauri::AppHandle,
        window_label: &str,
        surface_id: &str,
    ) -> Result<Self, String> {
        Ok(Self {
            inner: PlatformNativePreviewSurface::attach(app_handle, window_label, surface_id)?,
        })
    }

    pub fn set_viewport(&mut self, viewport: &PreviewViewport) -> Result<(), String> {
        self.inner.set_viewport(viewport)
    }

    pub fn set_presenting(&mut self, presenting: bool) -> Result<(), String> {
        self.inner.set_presenting(presenting)
    }

    pub fn set_embedded_content_attached(&mut self, attached: bool) -> Result<(), String> {
        self.inner.set_embedded_content_attached(attached)
    }

    pub fn host_window_handle_repr(&self) -> Option<String> {
        self.inner.host_window_handle_repr()
    }

    pub fn surface_window_handle_repr(&self) -> Option<String> {
        self.inner.surface_window_handle_repr()
    }

    pub fn surface_window_handle_value(&self) -> Option<usize> {
        self.inner.surface_window_handle_value()
    }

    pub fn physical_rect(&self) -> Option<PreviewSurfaceRect> {
        self.inner.physical_rect()
    }

    pub fn is_visible(&self) -> bool {
        self.inner.is_visible()
    }

    pub fn is_presenting(&self) -> bool {
        self.inner.is_presenting()
    }

    pub fn is_embedded_content_attached(&self) -> bool {
        self.inner.is_embedded_content_attached()
    }

    pub fn detach(&mut self) -> Result<(), String> {
        self.inner.detach()
    }
}

pub fn native_surface_supported() -> bool {
    native_surface_platform_status().supported
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeSurfacePlatformStatus {
    pub supported: bool,
    pub implemented: bool,
    pub status: &'static str,
    pub reason: Option<&'static str>,
}

pub fn native_surface_platform_status() -> NativeSurfacePlatformStatus {
    #[cfg(test)]
    {
        return NativeSurfacePlatformStatus {
            supported: false,
            implemented: true,
            status: "unsupported",
            reason: Some("Native preview surfaces are disabled in unit tests"),
        };
    }

    #[cfg(all(not(test), target_os = "windows"))]
    {
        return NativeSurfacePlatformStatus {
            supported: true,
            implemented: true,
            status: "supported",
            reason: None,
        };
    }

    #[cfg(all(not(test), target_os = "macos"))]
    {
        return NativeSurfacePlatformStatus {
            supported: true,
            implemented: true,
            status: "supported",
            reason: None,
        };
    }

    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
    {
        NativeSurfacePlatformStatus {
            supported: false,
            implemented: false,
            status: "unsupported",
            reason: Some("Native preview surfaces are only implemented on Windows and macOS"),
        }
    }
}

pub fn native_surface_type() -> Option<&'static str> {
    #[cfg(test)]
    {
        return None;
    }

    #[cfg(all(not(test), target_os = "windows"))]
    {
        return Some("win32-child-window");
    }

    #[cfg(all(not(test), target_os = "macos"))]
    {
        return Some("nsview-child");
    }

    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
    {
        None
    }
}

#[cfg(not(any(test, target_os = "macos", target_os = "windows")))]
#[derive(Debug)]
struct UnsupportedNativePreviewSurface;

#[cfg(not(any(test, target_os = "macos", target_os = "windows")))]
impl UnsupportedNativePreviewSurface {
    fn attach(_: &tauri::AppHandle, _: &str, _: &str) -> Result<Self, String> {
        Err("Native preview surfaces are not supported on this platform".to_string())
    }

    fn set_viewport(&mut self, _: &PreviewViewport) -> Result<(), String> {
        Ok(())
    }

    fn set_presenting(&mut self, _: bool) -> Result<(), String> {
        Ok(())
    }

    fn host_window_handle_repr(&self) -> Option<String> {
        None
    }

    fn surface_window_handle_repr(&self) -> Option<String> {
        None
    }

    fn surface_window_handle_value(&self) -> Option<usize> {
        None
    }

    fn physical_rect(&self) -> Option<PreviewSurfaceRect> {
        None
    }

    fn is_visible(&self) -> bool {
        false
    }

    fn is_presenting(&self) -> bool {
        false
    }

    fn is_embedded_content_attached(&self) -> bool {
        false
    }

    fn set_embedded_content_attached(&mut self, _: bool) -> Result<(), String> {
        Ok(())
    }

    fn detach(&mut self) -> Result<(), String> {
        Ok(())
    }
}
