/**
 * Cached Tauri invoke() — reuse the same dynamic import across all callers.
 *
 * Two variants:
 * - `invoke()` — raw invoke, no platform guard (use when already inside a Tauri-only code path)
 * - `guardedInvoke()` — checks isTauri() first, throws if not in Tauri desktop
 */

import { isTauri } from './platform';

let _invokePromise: Promise<typeof import('@tauri-apps/api/core')['invoke']> | null = null;

async function getInvokeFn() {
  if (!_invokePromise) {
    _invokePromise = import('@tauri-apps/api/core').then((mod) => mod.invoke);
  }
  return _invokePromise;
}

/** Invoke a Tauri command without a platform guard. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauriInvoke = await getInvokeFn();
  return tauriInvoke<T>(cmd, args);
}

/** Invoke a Tauri command with isTauri() guard. Throws if not in Tauri desktop. */
export async function guardedInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`[TauriBridge] "${cmd}" is only available in the Tauri desktop app`);
  }
  const tauriInvoke = await getInvokeFn();
  return tauriInvoke<T>(cmd, args);
}
