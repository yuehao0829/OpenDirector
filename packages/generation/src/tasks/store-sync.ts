/**
 * Store Sync — coordinated updates to generationStore + Generations.xml.
 * Encapsulates the dual-call pattern (generation store + XML persistence).
 */

import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import type { Generation } from '@opendirector/core/types/generation';
import { updateGenerationsXml } from './generation-xml-repository';
import { taskLog } from './task-log';

/** Find a generation by ID from the store. */
export function getGenerationById(taskId: string): Generation | undefined {
  return useGenerationStore.getState().generations.find((g) => g.id === taskId);
}

/** Transition a generation to a terminal status in both store and XML. */
function transitionGeneration(
  taskId: string,
  status: 'failed' | 'cancelled' | 'expired',
  errorMsg: string | undefined,
  folderPath?: string,
): Promise<boolean> {
  const storeUpdates: Record<string, unknown> = { status, completedAt: new Date() };
  const xmlUpdates: Record<string, unknown> = { status, completedAt: new Date().toISOString() };
  if (errorMsg) {
    storeUpdates.errorMessage = errorMsg;
    xmlUpdates.error = errorMsg;
  }
  useGenerationStore.getState().updateGeneration(taskId, storeUpdates as Partial<Generation>);
  return updateGenerationsXml(folderPath, taskId, xmlUpdates);
}

export function failGeneration(taskId: string, errorMsg: string, folderPath?: string): Promise<boolean> {
  taskLog.error(folderPath, 'generation_failed', errorMsg, { taskId });
  return transitionGeneration(taskId, 'failed', errorMsg, folderPath);
}

export function cancelGeneration(taskId: string, folderPath?: string): Promise<boolean> {
  return transitionGeneration(taskId, 'cancelled', undefined, folderPath);
}

export function expireGeneration(taskId: string, errorMsg: string, folderPath?: string): Promise<boolean> {
  return transitionGeneration(taskId, 'expired', errorMsg, folderPath);
}

export function updateGenerationProgress(taskId: string, progress: number, folderPath?: string): void {
  const gen = getGenerationById(taskId);
  // Skip if progress unchanged — avoids redundant store updates and XML I/O
  if (gen && gen.status === 'processing' && gen.progress === progress) return;
  useGenerationStore.getState().updateGeneration(taskId, { status: 'processing', progress });
  if (folderPath) {
    updateGenerationsXml(folderPath, taskId, { status: 'processing' }).catch((err) =>
      taskLog.warn(folderPath, 'progress_xml_write', 'Failed to write progress status to XML', { error: String(err) })
    );
  }
}
