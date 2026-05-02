use crate::media::model::PreviewViewport;

pub fn normalize_viewport(viewport: PreviewViewport) -> PreviewViewport {
    PreviewViewport {
        x: viewport.x.max(0.0),
        y: viewport.y.max(0.0),
        width: viewport.width.max(0.0),
        height: viewport.height.max(0.0),
        scale_factor: viewport.scale_factor.max(0.1),
        visible: viewport.visible && viewport.width > 0.0 && viewport.height > 0.0,
    }
}
