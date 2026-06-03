/**
 * Task Bridge — thin façade that initialises the Rust event listener
 * and re-exports the public API from the split sub-modules.
 *
 * Sub-modules:
 *   generation-xml-repository  — XML read/write, write lock, shared helpers
 *   task-submitter              — submit generation task
 *   task-lifecycle              — completion handling, cancel, markRecordTerminal
 *   task-recovery               — project restoration, server refresh, orphan cleanup
 *   store-sync                  — coordinated store + XML updates
 */

import type { GenerationEvent } from '@opendirector/core/types/ai-video';
import { tauriBridge, isTauri } from '@opendirector/core/services/tauri-bridge';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { updateGenerationsXml } from './generation-xml-repository';
import { handleTaskComplete } from './task-lifecycle';
import { resetFragmentIfGenerating } from './fragment-utils';
import { failGeneration, cancelGeneration, getGenerationById } from './store-sync';
import { taskLog } from './task-log';

let initialized = false;
const bridgeState: { unlisten?: () => void } = {};

/**
 * Check whether a generation event belongs to the currently open project.
 * - Events with `project_path`: compare directly against current project's folderPath.
 * - Events without `project_path`: look up the generation's projectId in the store.
 *   If the generation is not in the store yet (race), assume it belongs to the
 *   current project — it will be filtered out on next project switch.
 */
function isCurrentProjectEvent(taskId: string, eventProjectPath?: string): boolean {
  const currentProject = useProjectStore.getState().currentProject;
  if (eventProjectPath) {
    return !!currentProject?.folderPath && eventProjectPath === currentProject.folderPath;
  }
  const gen = getGenerationById(taskId);
  if (!gen) return true;
  return !currentProject?.id || gen.projectId === currentProject.id;
}

export async function initTaskBridge(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!isTauri()) return;

  bridgeState.unlisten = await tauriBridge.listen<GenerationEvent>('generation:status', (payload) => {
    const projectPath = useProjectStore.getState().currentProject?.folderPath;
    const eventProjectPath = payload.type !== 'download_progress' ? payload.project_path : undefined;
    const isCurrent = isCurrentProjectEvent(payload.task_id, eventProjectPath);

    switch (payload.type) {
      case 'created':
        useGenerationStore.getState().updateGeneration(payload.task_id, { providerTaskId: payload.api_task_id });
        taskLog.info(projectPath, 'event_created', 'Task created on server', {
          taskId: payload.task_id,
          apiTaskId: payload.api_task_id,
        });
        // Only write XML for the current project — background projects have their
        // own XML that will be updated via handleTaskComplete's isBackgroundCompletion path
        if (isCurrent) {
          const project = useProjectStore.getState().currentProject;
          if (project?.folderPath) {
            updateGenerationsXml(project.folderPath, payload.task_id, {
              providerTaskId: payload.api_task_id,
            }).catch((err) => taskLog.warn(projectPath, 'write_provider_task_id', 'Failed to write providerTaskId to XML', { error: String(err) }));
          }
        }
        break;

      case 'completed':
        taskLog.info(projectPath, 'event_completed', 'Task completed', {
          taskId: payload.task_id,
          filePath: payload.file_path,
          fileSize: payload.file_size,
        });
        // handleTaskComplete already handles background completion correctly
        // (writes to the correct project's XML/DB based on project_path)
        handleTaskComplete({
          taskId: payload.task_id,
          apiTaskId: payload.api_task_id,
          localPath: payload.file_path,
          fileSize: payload.file_size,
          lastFrameUrl: payload.last_frame_url,
          projectPath: payload.project_path,
        })
          .then((ack) => { if (ack) tauriBridge.seedanceApi.acknowledgeTask(payload.task_id); })
          .catch((err) => taskLog.warn(projectPath, 'completed_handler_error', 'Completed handler failed', { error: String(err) }));
        break;

      case 'failed':
        taskLog.error(projectPath, 'event_failed', 'Task failed', {
          taskId: payload.task_id,
          error: payload.error,
        });
        // Only reset fragment for current project — background project fragments aren't in the timeline
        if (isCurrent) {
          const gen = getGenerationById(payload.task_id);
          if (gen?.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'failed');
        }
        failGeneration(payload.task_id, payload.error, payload.project_path)
          .then((written) => { if (written) tauriBridge.seedanceApi.acknowledgeTask(payload.task_id); })
          .catch((err) => taskLog.warn(projectPath, 'failed_handler_error', 'Failed handler failed', { error: String(err) }));
        break;

      case 'cancelled':
        taskLog.info(projectPath, 'event_cancelled', 'Task cancelled', {
          taskId: payload.task_id,
        });
        // Only reset fragment for current project
        if (isCurrent) {
          const gen = getGenerationById(payload.task_id);
          if (gen?.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'draft');
        }
        cancelGeneration(payload.task_id, payload.project_path)
          .then((written) => { if (written) tauriBridge.seedanceApi.acknowledgeTask(payload.task_id); })
          .catch((err) => taskLog.warn(projectPath, 'cancelled_handler_error', 'Cancelled handler failed', { error: String(err) }));
        break;
    }
  });
}

export { submitGenerationTask } from './task-submitter';
export type { SubmitGenerationOptions } from '@opendirector/core/types/service-interfaces';
export { cancelGenerationTask } from './task-lifecycle';
export { restoreProjectGenerations, refreshActiveGenerations, cleanupOrphanedGeneratingFragments } from './task-recovery';
export { initAssetTaskBridge, restoreProjectAssets } from './asset-bridge';
