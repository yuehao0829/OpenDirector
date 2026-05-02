/**
 * Lazy-load Tauri window API once, reuse across calls.
 * Shared by TitleBar and useWindowCloseHandler to avoid
 * duplicate module-level caches.
 */
let _windowModule: typeof import('@tauri-apps/api/window') | null = null;

export async function getTauriWindow() {
  if (!_windowModule) {
    _windowModule = await import('@tauri-apps/api/window');
  }
  return _windowModule.getCurrentWindow();
}
