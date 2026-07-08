/**
 * Seedance TaskController.
 *
 * Seedance is the only provider that supports JS-side status polling (via the
 * ARK batch query API). Therefore this controller implements the full surface:
 * start/cancel/resume (required) + batchQuery/getTaskStatus/downloadResult/
 * refreshActive (optional polling methods).
 *
 * The `refreshActive` method contains the server-status refresh logic formerly
 * inlined in `task-recovery.ts::refreshActiveGenerations`. It batch-queries the
 * ARK API for active Seedance tasks and reconciles their local state
 * (download + complete on succeeded, fail/cancel/expire on terminal statuses).
 */

import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import type { Generation } from '@opendirector/core/types/generation';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import type { TaskStatusResult } from '@opendirector/core/types/ai-video';
import { t } from '@opendirector/core/i18n';
import { getErrorMessage } from '@opendirector/core/utils/common';
import type { TaskController, DownloadResultInput } from '../task-controller-registry';
import { submitSeedanceTask } from '../task-submitter';
import { handleTaskComplete } from '../task-lifecycle';
import { failGeneration, cancelGeneration, expireGeneration } from '../store-sync';
import { resetFragmentIfGenerating } from '../fragment-utils';
import { getProviderPassword } from '../generation-xml-repository';
import { taskLog } from '../task-log';

/**
 * Batch-query ARK task statuses, falling back to individual queries on error.
 * Moved here from task-recovery.ts::batchQueryServerStatuses so the
 * provider-specific API calls live on the controller.
 */
async function batchQueryWithFallback(
  instance: ProviderInstance,
  password: string,
  taskIds: string[],
): Promise<TaskStatusResult[]> {
  if (taskIds.length === 0) return [];
  try {
    return await tauriBridge.seedanceApi.batchQueryTasks(instance.instanceId, password, taskIds);
  } catch {
    taskLog.warn(undefined, 'batch_query_fallback', 'Batch query failed, falling back to individual queries', {
      count: taskIds.length,
    });
    const statuses = await Promise.allSettled(
      taskIds.map((id) =>
        tauriBridge.seedanceApi.getTaskStatus(instance.instanceId, password, id),
      ),
    );
    const results: TaskStatusResult[] = [];
    for (const settled of statuses) {
      if (settled.status === 'fulfilled') results.push(settled.value);
    }
    return results;
  }
}

export const seedanceController: TaskController = {
  start(input) {
    return submitSeedanceTask(
      input.fragmentId,
      input.instanceId,
      input.modelId,
      input.params,
      input.options,
      input.instance,
    );
  },

  cancel(taskId) {
    return tauriBridge.seedanceApi.cancelGeneration(taskId);
  },

  resume(taskId, password) {
    return tauriBridge.seedanceApi.resumeGeneration(taskId, password);
  },

  batchQuery(instance, password, taskIds) {
    return batchQueryWithFallback(instance, password, taskIds);
  },

  getTaskStatus(instance, password, taskId) {
    return tauriBridge.seedanceApi.getTaskStatus(instance.instanceId, password, taskId);
  },

  downloadResult(input: DownloadResultInput) {
    return tauriBridge.seedanceApi.downloadGenerationVideo(input.url, input.projectPath, input.generationId);
  },

  /**
   * Refresh active Seedance generations by querying the ARK API.
   * Reconciles local state for tasks whose server status changed.
   */
  async refreshActive(gens: Generation[], folderPath?: string): Promise<void> {
    if (gens.length === 0) return;

    // Resolve a Seedance instance for credentials (use the first gen's instance,
    // falling back to any configured Seedance instance).
    let instance: ProviderInstance | undefined;
    for (const gen of gens) {
      instance = useProviderInstanceStore.getState().get(gen.providerInstanceId);
      if (instance) break;
    }
    if (!instance) {
      instance = useProviderInstanceStore.getState().getByType('seedance')[0];
    }
    if (!instance) {
      taskLog.warn(folderPath, 'refresh_no_provider', 'No Seedance provider configured');
      return;
    }

    const password = getProviderPassword(instance);
    if (!password) {
      taskLog.warn(folderPath, 'refresh_no_password', 'No password for Seedance provider');
      return;
    }

    const gensWithApiId = gens.filter((g) => g.providerTaskId);
    if (gensWithApiId.length === 0) {
      taskLog.info(folderPath, 'refresh_no_tasks', 'No active generations with providerTaskId to query');
      return;
    }

    const apiTaskIds = gensWithApiId.map((g) => g.providerTaskId!);
    const serverResultsArray = await batchQueryWithFallback(instance, password, apiTaskIds);
    const serverResults = new Map<string, TaskStatusResult>();
    for (const r of serverResultsArray) {
      serverResults.set(r.task_id, r);
    }
    taskLog.info(folderPath, 'refresh_results', 'Query results', { results: Object.fromEntries(serverResults) });

    for (const gen of gensWithApiId) {
      const serverResult = serverResults.get(gen.providerTaskId!);
      if (!serverResult) continue;

      const serverStatus = serverResult.status;

      if (serverStatus === 'succeeded') {
        const videoUrl = serverResult.result_url;
        if (!videoUrl) continue;
        // Server already finished — resumeGeneration only re-registers with Rust,
        // it won't produce further events. Always perform JS-side download + completion.
        try {
          await tauriBridge.seedanceApi.resumeGeneration(gen.id, password);
        } catch (err) {
          taskLog.warn(folderPath, 'refresh_resume_error', 'resumeGeneration failed', { taskId: gen.id, error: String(err) });
        }
        await refreshSucceededFromServer(gen, serverResult, folderPath);
      } else if (serverStatus === 'failed') {
        const error = serverResult.error
          ? (typeof serverResult.error === 'string' ? serverResult.error : JSON.stringify(serverResult.error))
          : t('generation.task.serverFailed');
        if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'failed');
        const written = await failGeneration(gen.id, error, folderPath);
        if (written) { try { await tauriBridge.acknowledgeTask(gen.id); } catch { /* best-effort */ } }
      } else if (serverStatus === 'cancelled') {
        if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'draft');
        const written = await cancelGeneration(gen.id, folderPath);
        if (written) { try { await tauriBridge.acknowledgeTask(gen.id); } catch { /* best-effort */ } }
      } else if (serverStatus === 'expired') {
        const error = t('generation.task.resultExpired');
        if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'failed');
        const written = await expireGeneration(gen.id, error, folderPath);
        if (written) { try { await tauriBridge.acknowledgeTask(gen.id); } catch { /* best-effort */ } }
      }
    }
  },
};

/**
 * Handle a succeeded task discovered by refresh, using JS-side download + asset creation.
 * Used when Rust resumeGeneration fails (coordinator lost track of the task).
 */
async function refreshSucceededFromServer(
  gen: Generation,
  serverResult: TaskStatusResult,
  folderPath?: string,
): Promise<void> {
  const videoUrl = serverResult.result_url;
  if (!videoUrl || !folderPath) return;

  try {
    const downloadResult = await tauriBridge.seedanceApi.downloadGenerationVideo(videoUrl, folderPath, gen.id);
    const localPath = downloadResult.file_path;
    const fileSize = downloadResult.file_size;

    // Delegate to handleTaskComplete for the full completion flow
    await handleTaskComplete({
      taskId: gen.id,
      apiTaskId: gen.providerTaskId ?? '',
      localPath,
      fileSize,
      lastFrameUrl: serverResult.last_frame_url,
      projectPath: folderPath,
    });
  } catch (err) {
    taskLog.error(folderPath, 'refresh_download_error', 'Failed to download/complete task', { taskId: gen.id, error: getErrorMessage(err) });
    const errorMsg = t('generation.task.restoreSucceededFailed', { message: getErrorMessage(err) });
    await failGeneration(gen.id, errorMsg, folderPath);
  }
}
