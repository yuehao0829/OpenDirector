/**
 * Temp path utilities
 *
 * Provides access to the system temporary directory for creating
 * unsaved project folders.
 */

import { tempDir } from '@tauri-apps/api/path';

/**
 * Get the system temporary directory path.
 */
export async function getTempDir(): Promise<string> {
  return tempDir();
}
