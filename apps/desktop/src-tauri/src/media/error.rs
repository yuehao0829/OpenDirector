pub type MediaResult<T> = Result<T, String>;

pub fn backend_unavailable(backend: &str) -> String {
    format!("{backend} backend is not implemented yet")
}

pub fn backend_not_ready(backend: &str, reason: &str) -> String {
    format!("{backend} backend is not ready: {reason}")
}
