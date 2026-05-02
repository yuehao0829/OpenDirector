use crate::media::model::{PreviewSurfaceRect, PreviewViewport};

#[derive(Debug, Default)]
pub struct TestNativePreviewSurface {
    visible: bool,
    presenting: bool,
    embedded_content_attached: bool,
    physical_rect: Option<PreviewSurfaceRect>,
}

impl TestNativePreviewSurface {
    pub fn attach(_: &tauri::AppHandle, _: &str, _: &str) -> Result<Self, String> {
        Ok(Self::default())
    }

    pub fn set_viewport(&mut self, viewport: &PreviewViewport) -> Result<(), String> {
        self.physical_rect = viewport_to_physical_rect(viewport);
        self.visible =
            self.presenting && self.embedded_content_attached && self.physical_rect.is_some();
        Ok(())
    }

    pub fn set_presenting(&mut self, presenting: bool) -> Result<(), String> {
        self.presenting = presenting;
        self.visible =
            self.presenting && self.embedded_content_attached && self.physical_rect.is_some();
        Ok(())
    }

    pub fn host_window_handle_repr(&self) -> Option<String> {
        None
    }

    pub fn surface_window_handle_repr(&self) -> Option<String> {
        None
    }

    pub fn surface_window_handle_value(&self) -> Option<usize> {
        None
    }

    pub fn physical_rect(&self) -> Option<PreviewSurfaceRect> {
        self.physical_rect.clone()
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
        self.visible =
            self.presenting && self.embedded_content_attached && self.physical_rect.is_some();
        Ok(())
    }

    pub fn detach(&mut self) -> Result<(), String> {
        self.visible = false;
        self.presenting = false;
        self.embedded_content_attached = false;
        self.physical_rect = None;
        Ok(())
    }
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
    let width = (viewport.width * scale_factor).round().max(0.0) as i32;
    let height = (viewport.height * scale_factor).round().max(0.0) as i32;
    if width <= 0 || height <= 0 {
        return None;
    }

    Some(PreviewSurfaceRect {
        x: (viewport.x * scale_factor).round() as i32,
        y: (viewport.y * scale_factor).round() as i32,
        width,
        height,
    })
}
