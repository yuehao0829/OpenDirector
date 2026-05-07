/**
 * Asset XML Repository — XML read/write for Assets.xml,
 * reusing the per-folder write lock from generation-xml-repository.
 */

import { ASSETS_XML_FILENAME } from '@opendirector/core/services/project-io';
import {
  serializeAssetsFile,
  parseAssetsFile,
  type AssetRecord,
  type AssetsFile,
} from '@opendirector/core/utils/xml';
import { arrayBufferToText, textToArrayBuffer } from '@opendirector/core/utils/encoding';
import { withProjectWriteLock, getFs } from './generation-xml-repository';
import { taskLog } from './task-log';

// ============================================================================
// Assets.xml read / write
// ============================================================================

/** Read and parse Assets.xml, returning undefined if missing or invalid. */
export async function readAssetsFile(
  folderPath: string,
): Promise<AssetsFile | undefined> {
  try {
    const fs = await getFs();
    if (!fs) return undefined;
    const data = await fs.readFile(`${folderPath}/${ASSETS_XML_FILENAME}`);
    return parseAssetsFile(arrayBufferToText(data));
  } catch {
    return undefined;
  }
}

/** Write an AssetsFile to disk. */
export async function writeAssetsFile(
  folderPath: string,
  file: AssetsFile,
): Promise<void> {
  const fs = await getFs();
  if (!fs) return;
  const xml = serializeAssetsFile(file);
  await fs.writeFile(`${folderPath}/${ASSETS_XML_FILENAME}`, textToArrayBuffer(xml));
}

/** Read-modify-write a single asset record in Assets.xml, under the write lock. */
export async function updateAssetsXml(
  folderPath: string | undefined,
  assetId: string,
  updates: Partial<AssetRecord>,
): Promise<boolean> {
  try {
    if (!folderPath) return false;

    return await withProjectWriteLock(folderPath, async () => {
      const file = (await readAssetsFile(folderPath)) ?? { assets: [] };

      const existingIdx = file.assets.findIndex((a) => a.id === assetId);
      if (existingIdx >= 0) {
        file.assets[existingIdx] = { ...file.assets[existingIdx], ...updates };
      } else {
        return false;
      }

      await writeAssetsFile(folderPath, file);
      return true;
    });
  } catch (error) {
    taskLog.warn(folderPath, 'asset_xml_write', 'Failed to update Assets.xml', { error: String(error) });
    return false;
  }
}
