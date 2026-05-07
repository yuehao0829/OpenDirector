/**
 * Project Cleanup
 *
 * Handles cleanup of orphan files on disk that are not
 * referenced by any asset in the project.
 */

import type { FileSystemAdapter } from '../adapters/types';

/**
 * Delete orphan files on disk that are not referenced by any asset.
 * Scans Assets/ subdirectories and Thumbnails/ for files whose name
 * starts with an unknown asset UUID.
 */
export async function cleanupOrphanFiles(
  fs: FileSystemAdapter,
  projectPath: string,
  assets: { id: string }[]
): Promise<void> {
  const knownIds = new Set(assets.map((a) => a.id));

  // All directories to scan: asset subdirectories + thumbnails
  const scanDirs = ['Assets/Video', 'Assets/Image', 'Assets/Audio', 'Thumbnails'];

  for (const dir of scanDirs) {
    const fullPath = `${projectPath}/${dir}`;
    try {
      const files = await fs.listDir(fullPath);
      for (const file of files) {
        if (file.isDirectory) continue;
        // Filename pattern: {uuid}.{ext}
        const uuid = file.name.split('.')[0];
        if (uuid && !knownIds.has(uuid)) {
          try {
            await fs.deleteFile(file.path);
          } catch (error) {
            // file may have been deleted by a concurrent operation
          }
        }
      }
    } catch {
      // Directory may not exist yet — skip
    }
  }
}
