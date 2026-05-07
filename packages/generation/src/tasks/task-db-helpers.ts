import type { Asset } from '@opendirector/core/types/asset';
import type { Generation } from '@opendirector/core/types/generation';
import type { DatabaseAdapter } from '@opendirector/core/adapters/types';
import { taskLog } from './task-log';

export function safeSaveAsset(
  db: DatabaseAdapter | null | undefined,
  folderPath: string | undefined,
  asset: Asset,
  phase: string,
): void {
  if (!db) return;
  db.saveAsset(asset).catch((e) =>
    taskLog.warn(folderPath, phase, 'Failed to save asset to DB', { error: String(e) }),
  );
}

export function safeCreateGeneration(
  db: DatabaseAdapter | null | undefined,
  folderPath: string | undefined,
  generation: Generation,
  phase: string,
): void {
  if (!db) return;
  db.createGeneration(generation).catch((e) =>
    taskLog.warn(folderPath, phase, 'Failed to save generation to DB', { error: String(e) }),
  );
}
