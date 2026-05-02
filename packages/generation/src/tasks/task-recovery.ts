/**
 * Task Recovery — project restoration, server status refresh,
 * succeeded-task recovery, and orphan cleanup.
 */

import { generateThumbnailForAsset } from '@opendirector/core/services/asset-import';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { PendingGenerationTask, TaskStatusResult } from '@opendirector/core/types/ai-video';
import type { Generation } from '@opendirector/core/types/generation';
import { isActiveGenerationStatus } from '@opendirector/core/types/generation';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import { getErrorMessage } from '@opendirector/core/utils/common';
import { toWebViewUrl } from '@opendirector/core/utils/platform';
import type {
  GenerationRecord,
  GenerationsFile,
  GenerationResultInfo,
} from '@opendirector/core/utils/xml';
import {
  readGenerationsFile,
  writeGenerationsFile,
  withProjectWriteLock,
  getFs,
  getDb,
  getProviderPassword,
  buildGeneratedAsset,
  generatedVideoPath,
} from './generation-xml-repository';
import { handleTaskComplete, markRecordTerminal, triggerNextSegmentIfNeeded } from './task-lifecycle';
import { resetFragmentIfGenerating } from './fragment-utils';
import { failGeneration, cancelGeneration, expireGeneration, updateGenerationProgress } from './store-sync';
import { taskLog } from './task-log';

/**
 * Restore project generations when opening a project.
 * Reads Generations.xml for transient records, cross-references with Rust pending tasks,
 * batch-queries the server for stale records, and restores them sequentially.
 */
export async function restoreProjectGenerations(folderPath: string): Promise<void> {
  const fs = await getFs();
  if (!fs) return;

  const [file, pendingTasksResult] = await Promise.allSettled([
    readGenerationsFile(folderPath, fs),
    tauriBridge.seedanceApi.listPendingTasks(),
  ]);

  if (file.status !== 'fulfilled' || !file.value) return;

  const generationsFile = file.value;

  // Reconcile completed generations whose fragments/assets are out of sync
  await reconcileCompletedGenerations(folderPath, generationsFile, fs);

  const transientRecords = generationsFile.generations.filter(
    (g) => isActiveGenerationStatus(g.status)
  );
  if (transientRecords.length === 0) return;

  const pendingTasks: PendingGenerationTask[] =
    pendingTasksResult.status === 'fulfilled' ? pendingTasksResult.value : [];

  const activeTaskIds = new Set(pendingTasks.map((t) => t.task_id));
  const seedanceInstance = getAnySeedanceInstance();
  const storeUpdates: Array<{ id: string; updates: { status: GenerationRecord['status']; errorMessage?: string } }> = [];

  for (const record of transientRecords) {
    if (!activeTaskIds.has(record.id)) continue;

    const pendingRecord = pendingTasks.find((t) => t.task_id === record.id);
    restoreProcessingRecord(record);

    const instance = useProviderInstanceStore.getState().get(pendingRecord?.provider_id ?? '');
    const password = getProviderPassword(instance);
    if (password) {
      try {
        await tauriBridge.seedanceApi.resumeGeneration(record.id, password);
        taskLog.info(folderPath, 'resume_task', 'Resuming Rust-tracked task', { taskId: record.id });
      } catch (err) {
        console.warn(`[TaskBridge] Failed to resume Rust-tracked task ${record.id}:`, err);
      }
    }
  }

  const staleRecords = transientRecords.filter((r) => !activeTaskIds.has(r.id));
  if (staleRecords.length > 0) {
    if (!seedanceInstance) {
      for (const record of staleRecords) {
        const idx = generationsFile.generations.findIndex((g) => g.id === record.id);
        if (idx < 0) continue;
        const errorMsg = '未配置生成服务，无法检查任务状态';
        generationsFile.generations[idx] = {
          ...generationsFile.generations[idx],
          status: 'failed',
          error: errorMsg,
          completedAt: new Date().toISOString(),
        };
        storeUpdates.push({ id: record.id, updates: { status: 'failed', errorMessage: errorMsg } });
      }
    } else {
      const providerTaskIds = staleRecords.map((r) => r.providerTaskId).filter((id): id is string => !!id);
      const serverStatusMap = await batchQueryServerStatuses(providerTaskIds, seedanceInstance, folderPath);
      const seedancePassword = getProviderPassword(seedanceInstance);

      // Build index for O(1) lookups
      const recordIndex = new Map<string, number>();
      for (let i = 0; i < generationsFile.generations.length; i++) {
        recordIndex.set(generationsFile.generations[i].id, i);
      }

      for (const record of staleRecords) {
        const idx = recordIndex.get(record.id) ?? -1;
        if (idx < 0) continue;

        if (!record.providerTaskId) {
          markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', '任务缺少服务端ID，无法恢复');
          continue;
        }

        const serverResult = serverStatusMap.get(record.providerTaskId);
        const serverStatus = serverResult?.status;

        if (serverStatus === 'running' || serverStatus === 'pending') {
          restoreProcessingRecord(record);
          if (seedancePassword) {
            try {
              await tauriBridge.seedanceApi.resumeGeneration(record.id, seedancePassword);
            } catch (err) {
              console.warn(`[TaskBridge] Failed to re-register server-tracked task ${record.id} with Rust:`, err);
            }
          }
        } else if (serverStatus === 'succeeded') {
          try {
            const updatedRecord = await restoreSucceededTask(record, folderPath, fs, serverResult!);
            generationsFile.generations[idx] = updatedRecord;
          } catch (error) {
            console.error(`[TaskBridge] Failed to restore succeeded task ${record.id}:`, error);
            markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', `恢复已完成任务失败: ${getErrorMessage(error)}`);
          }
        } else if (serverStatus === 'cancelled') {
          markRecordTerminal(generationsFile, idx, storeUpdates, 'cancelled');
        } else if (serverStatus === 'expired') {
          markRecordTerminal(generationsFile, idx, storeUpdates, 'expired', '生成结果已过期');
        } else {
          const errorMsg = serverStatus === 'failed' ? '生成任务在服务器端失败' : '任务在重启后丢失';
          markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', errorMsg);
        }
      }
    }
  }

  // Batch store updates to minimize re-renders
  for (const { id, updates } of storeUpdates) {
    useGenerationStore.getState().updateGeneration(id, updates);
  }

  // Write back modified XML under write lock
  await withProjectWriteLock(folderPath, async () => {
    await writeGenerationsFile(folderPath, generationsFile, fs);
  });

  await cleanupOrphanedGeneratingFragments();
}

/**
 * Batch query server statuses for multiple provider task IDs.
 * Returns a Map from providerTaskId to full TaskStatusResult.
 */
async function batchQueryServerStatuses(
  providerTaskIds: string[],
  instance: ProviderInstance,
  folderPath?: string,
): Promise<Map<string, TaskStatusResult>> {
  const result = new Map<string, TaskStatusResult>();
  if (providerTaskIds.length === 0) return result;

  const password = getProviderPassword(instance);
  if (!password) return result;

  try {
    const results = await tauriBridge.seedanceApi.batchQueryTasks(instance.instanceId, password, providerTaskIds);
    for (const r of results) {
      result.set(r.task_id, r);
    }
    if (folderPath) {
      taskLog.info(folderPath, 'batch_query_result', 'Batch query succeeded', {
        count: results.length,
      });
    }
  } catch (err) {
    console.warn('[TaskBridge] Batch query failed, falling back to individual queries:', err);
    if (folderPath) {
      taskLog.warn(folderPath, 'batch_query_fallback', 'Batch query failed, falling back to individual queries', {
        count: providerTaskIds.length,
      });
    }
    const statuses = await Promise.allSettled(
      providerTaskIds.map((id) =>
        tauriBridge.seedanceApi.getTaskStatus(instance.instanceId, password, id)
      ),
    );
    for (let i = 0; i < providerTaskIds.length; i++) {
      const settled = statuses[i];
      if (settled.status === 'fulfilled') {
        result.set(providerTaskIds[i], settled.value);
      }
    }
  }

  return result;
}

/**
 * Restore a server-completed task that has no local result.
 * Downloads video, creates asset, and updates all stores.
 */
async function restoreSucceededTask(
  record: GenerationRecord,
  folderPath: string,
  fs: NonNullable<Awaited<ReturnType<typeof getFs>>>,
  serverResult: TaskStatusResult,
): Promise<GenerationRecord> {
  if (!record.providerTaskId) throw new Error('Missing providerTaskId');

  const videoUrl = serverResult.result_url;
  if (!videoUrl) throw new Error('Server task succeeded but no video_url returned');

  const downloadResult = await tauriBridge.seedanceApi.downloadGenerationVideo(videoUrl, folderPath, record.id);
  const localPath = downloadResult.file_path;
  const fileSize = downloadResult.file_size;

  const assetId = crypto.randomUUID();

  const [metadataResult, thumbnailSettled] = await Promise.allSettled([
    fs.getMediaMetadata(localPath).catch(() => null),
    generateThumbnailForAsset(localPath, fs, 'video', folderPath, assetId),
  ]);

  const mediaMeta = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
  const thumbnailUrl = thumbnailSettled.status === 'fulfilled' ? thumbnailSettled.value?.thumbnailUrl : undefined;

  const webviewUrl = toWebViewUrl(localPath);
  const project = useProjectStore.getState().currentProject;
  const db = await getDb();

  const asset = buildGeneratedAsset({
    taskId: record.id,
    assetId,
    relativePath: generatedVideoPath(record.id),
    fileSize,
    videoUrl: webviewUrl,
    thumbnailUrl,
    duration: mediaMeta?.duration,
    width: mediaMeta?.width,
    height: mediaMeta?.height,
    audioChannels: mediaMeta?.audioChannels,
    sampleRate: mediaMeta?.sampleRate,
    projectId: project?.id ?? '',
  });

  useAssetStore.getState().addAsset(asset);
  if (db) {
    db.saveAsset(asset).catch((e: unknown) => console.warn('[TaskBridge] Failed to save restored asset to DB:', e));
  }

  const fragment = useTimelineStore.getState().fragments.find((f) => f.id === record.fragmentId);

  const resultInfo: GenerationResultInfo = {
    fileName: generatedVideoPath(record.id),
    fileSize,
    duration: mediaMeta?.duration ?? 0,
    width: mediaMeta?.width,
    height: mediaMeta?.height,
    mimeType: 'video/mp4',
    lastFrameUrl: serverResult.last_frame_url ?? undefined,
  };

  useGenerationStore.getState().updateGeneration(record.id, {
    resultAssetId: assetId,
    status: 'completed',
    providerTaskId: record.providerTaskId,
    result: resultInfo,
    completedAt: new Date(),
    isSelected: true,
    continuousMode: record.continuousMode,
    continuousPlan: record.continuousPlan,
    currentSegmentIndex: record.currentSegmentIndex,
    continuousGroupId: record.continuousGroupId,
    lastFrameAssetId: record.lastFrameAssetId,
  });

  if (fragment) {
    useTimelineStore.getState().updateFragment(fragment.id, {
      generatedUrl: webviewUrl,
      sourceAssetId: assetId,
      resultAssetId: assetId,
      thumbnailUrl,
      status: 'completed',
    });
  }

  console.log(`[TaskBridge] Restored succeeded task ${record.id} with video download`);

  taskLog.info(folderPath, 'restore_succeeded', 'Restored succeeded task with video download', {
    taskId: record.id,
    localPath,
  });

  if (record.continuousMode) {
    await triggerNextSegmentIfNeeded(record.id, resultInfo.lastFrameUrl);
  }

  return {
    ...record,
    status: 'completed',
    resultAssetId: assetId,
    providerTaskId: record.providerTaskId,
    isSelected: true,
    completedAt: new Date().toISOString(),
    result: resultInfo,
    error: undefined,
  };
}

/** Restore a generation record to processing, and sync its fragment to 'generating'. */
function restoreProcessingRecord(record: GenerationRecord): void {
  useGenerationStore.getState().updateGeneration(record.id, {
    status: 'processing',
    progress: 0,
    errorMessage: undefined,
    continuousMode: record.continuousMode,
    continuousPlan: record.continuousPlan,
    currentSegmentIndex: record.currentSegmentIndex,
    continuousGroupId: record.continuousGroupId,
    lastFrameAssetId: record.lastFrameAssetId,
    compositeAssetId: record.compositeAssetId,
    firstFrameAsReference: record.firstFrameAsReference,
  });

  if (record.fragmentId) {
    useTimelineStore.getState().updateFragment(record.fragmentId, { status: 'generating' });
  }
}

function getAnySeedanceInstance(): ProviderInstance | undefined {
  return useProviderInstanceStore.getState().getByType('seedance')[0];
}

/**
 * Manually refresh active generation tasks by querying the server.
 * Uses batch query API for multiple tasks, single query for one.
 * Triggers completion/download flow on status changes.
 */
export async function refreshActiveGenerations(): Promise<void> {
  const store = useGenerationStore.getState();
  const activeGenerations = store.generations.filter((g) => isActiveGenerationStatus(g.status));
  if (activeGenerations.length === 0) return;

  const instance = getAnySeedanceInstance();

  if (!instance) {
    console.error('[Generation Refresh] No Seedance provider configured');
    return;
  }

  const gensWithApiId = activeGenerations.filter((g) => g.providerTaskId);
  if (gensWithApiId.length === 0) {
    console.warn('[Generation Refresh] No active generations with providerTaskId to query');
    return;
  }

  const project = useProjectStore.getState().currentProject;
  const folderPath = project?.folderPath;

  const apiTaskIds = gensWithApiId.map((g) => g.providerTaskId!);
  const serverResults = await batchQueryServerStatuses(apiTaskIds, instance, folderPath);
  console.log('[Generation Refresh] Query results:', Object.fromEntries(serverResults));

  const password = getProviderPassword(instance);

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
        console.warn(`[Generation Refresh] resumeGeneration failed for ${gen.id}:`, err);
      }
      await refreshSucceededTaskFromServer(gen, serverResult, folderPath);
    } else if (serverStatus === 'failed') {
      const error = serverResult.error
        ? (typeof serverResult.error === 'string' ? serverResult.error : JSON.stringify(serverResult.error))
        : '生成任务在服务器端失败';
      if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'failed');
      const written = await failGeneration(gen.id, error, folderPath);
      if (written) { try { await tauriBridge.seedanceApi.acknowledgeTask(gen.id); } catch { /* acknowledgement is best-effort */ } }
    } else if (serverStatus === 'cancelled') {
      if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'draft');
      const written = await cancelGeneration(gen.id, folderPath);
      if (written) { try { await tauriBridge.seedanceApi.acknowledgeTask(gen.id); } catch { /* acknowledgement is best-effort */ } }
    } else if (serverStatus === 'expired') {
      const error = '生成结果已过期';
      if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'failed');
      const written = await expireGeneration(gen.id, error, folderPath);
      if (written) { try { await tauriBridge.seedanceApi.acknowledgeTask(gen.id); } catch { /* acknowledgement is best-effort */ } }
    } else if ((serverStatus === 'running' || serverStatus === 'pending') && serverResult.progress != null) {
      updateGenerationProgress(gen.id, serverResult.progress, folderPath);
    }
  }
}

/**
 * Handle a succeeded task discovered by refresh, using JS-side download + asset creation.
 * Used when Rust resumeGeneration fails (coordinator lost track of the task).
 */
async function refreshSucceededTaskFromServer(
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
    console.error(`[Refresh] Failed to download/complete task ${gen.id}:`, err);
    const errorMsg = `恢复已完成任务失败: ${getErrorMessage(err)}`;
    await failGeneration(gen.id, errorMsg, folderPath);
  }
}

/**
 * Reconcile completed generations whose fragments or assets are out of sync.
 * This handles the case where handleTaskComplete wrote Generations.xml but
 * the app was killed before Timeline.xml / .odp were saved — so the fragment
 * is stuck in 'generating' and the asset is missing from assetStore/DB.
 */
async function reconcileCompletedGenerations(
  folderPath: string,
  generationsFile: GenerationsFile,
  fs: NonNullable<Awaited<ReturnType<typeof getFs>>>,
): Promise<void> {
  const completedRecords = generationsFile.generations.filter(
    (g) => g.status === 'completed' && g.resultAssetId && g.fragmentId,
  );
  if (completedRecords.length === 0) return;

  const db = await getDb();
  const assetStore = useAssetStore.getState();
  const timelineStore = useTimelineStore.getState();
  const generationStore = useGenerationStore.getState();
  const assetIdSet = new Set(assetStore.assets.map((a) => a.id));

  // Build index for O(1) lookups
  const recordIndex = new Map<string, number>();
  for (let i = 0; i < generationsFile.generations.length; i++) {
    recordIndex.set(generationsFile.generations[i].id, i);
  }

  const storeUpdates: Array<{ id: string; updates: { status: GenerationRecord['status']; errorMessage?: string } }> = [];

  for (const record of completedRecords) {
    const fragment = timelineStore.fragments.find((f) => f.id === record.fragmentId);
    const needsFragmentFix = fragment && (
      fragment.status === 'generating' ||
      !fragment.sourceAssetId ||
      !fragment.resultAssetId
    );
    const assetMissing = record.resultAssetId ? !assetIdSet.has(record.resultAssetId) : true;
    if (!needsFragmentFix && !assetMissing) continue;

    const videoRelPath = generatedVideoPath(record.id);
    const videoAbsPath = `${folderPath}/${videoRelPath}`;
    const idx = recordIndex.get(record.id);

    // Try to read metadata directly — avoids TOCTOU from fs.exists()
    const metadataResult = await fs.getMediaMetadata(videoAbsPath).catch(() => null);

    if (metadataResult !== null) {
      const assetId = crypto.randomUUID();
      const [thumbnailSettled] = await Promise.allSettled([
        generateThumbnailForAsset(videoAbsPath, fs, 'video', folderPath, assetId),
      ]);
      const thumbnailUrl = thumbnailSettled.status === 'fulfilled' ? thumbnailSettled.value?.thumbnailUrl : undefined;

      const [fileSizeResult] = await Promise.allSettled([fs.getFileSize(videoAbsPath)]);
      const fileSize = fileSizeResult.status === 'fulfilled' ? fileSizeResult.value : 0;

      const webviewUrl = toWebViewUrl(videoAbsPath);
      const project = useProjectStore.getState().currentProject;

      const asset = buildGeneratedAsset({
        taskId: record.id,
        assetId,
        relativePath: videoRelPath,
        fileSize,
        videoUrl: webviewUrl,
        thumbnailUrl,
        duration: metadataResult.duration,
        width: metadataResult.width,
        height: metadataResult.height,
        audioChannels: metadataResult.audioChannels,
        sampleRate: metadataResult.sampleRate,
        projectId: project?.id ?? '',
      });
      const newAssetId = asset.id;

      assetStore.addAsset(asset);
      if (db) {
        db.saveAsset(asset).catch((e: unknown) => console.warn('[TaskBridge] Failed to save reconciled asset to DB:', e));
      }

      if (fragment && needsFragmentFix) {
        timelineStore.updateFragment(fragment.id, {
          generatedUrl: webviewUrl,
          sourceAssetId: newAssetId,
          resultAssetId: newAssetId,
          thumbnailUrl,
          status: 'completed',
        });
      }

      // buildGeneratedAsset creates a new UUID, so update the reference
      if (idx !== undefined) {
        generationsFile.generations[idx] = {
          ...generationsFile.generations[idx],
          resultAssetId: newAssetId,
        };
      }

      generationStore.updateGeneration(record.id, {
        resultAssetId: newAssetId,
        status: 'completed',
        isSelected: true,
      });

      console.log(`[TaskBridge] Reconciled completed generation ${record.id}: asset rebuilt, fragment fixed`);

      if (record.continuousMode) {
        const plan = record.continuousPlan ?? [];
        const nextIndex = (record.currentSegmentIndex ?? 0) + 1;
        if (nextIndex < plan.length) {
          await triggerNextSegmentIfNeeded(record.id, record.result?.lastFrameUrl);
        }
      }
    } else {
      // Video missing from disk
      const errorMsg = 'Generated file missing from disk';
      if (idx !== undefined) {
        markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', errorMsg);
      }

      if (fragment) {
        resetFragmentIfGenerating(fragment.id, 'failed');
      }
    }
  }

  // Batch store updates for failed records
  for (const { id, updates } of storeUpdates) {
    generationStore.updateGeneration(id, updates);
  }

  // Let the caller write back the XML to avoid double-write
}

/**
 * Clean up fragments stuck in 'generating' status that have no
 * corresponding active task.
 */
export async function cleanupOrphanedGeneratingFragments(): Promise<void> {
  const timelineStore = useTimelineStore.getState();
  const activeGenFragmentIds = new Set(
    useGenerationStore.getState().generations
      .filter((g) => isActiveGenerationStatus(g.status) && g.fragmentId)
      .map((g) => g.fragmentId!),
  );

  const orphanFragments = timelineStore.fragments.filter(
    (f) => f.status === 'generating' && !activeGenFragmentIds.has(f.id),
  );

  for (const f of orphanFragments) {
    console.log(`[TaskBridge] Resetting orphan generating fragment ${f.id} to draft`);
    timelineStore.updateFragment(f.id, { status: 'draft' });
  }
}
