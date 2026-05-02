/**
 * Platform detection utilities
 */

/**
 * Check if running in Tauri desktop environment
 * Uses __TAURI_INTERNALS__ which is always injected (unlike __TAURI__ which requires withGlobalTauri)
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Convert a native file path to a URL that Tauri WebView can load.
 * Uses the asset:// protocol (via __TAURI_INTERNALS__).
 */
export function toWebViewUrl(filePath: string): string {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (path: string, protocol?: string) => string } }).__TAURI_INTERNALS__;
  // Normalize backslashes to forward slashes on Windows before convertFileSrc
  const normalizedPath = filePath.replace(/\\/g, '/');
  return internals.convertFileSrc(normalizedPath);
}
