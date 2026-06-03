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
import { t } from '@opendirector/core/i18n';
import { getErrorMessage } from '@opendirector/core/utils/common';
import { toWebViewUrl } from '@opendirector/core/utils/platform';
import { generateId } from '@opendirector/core/utils/id';
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
  generatedImagePath,
  generatedVideoPath,
  mimeTypeToExtension,
} from './generation-xml-repository';
import { handleTaskComplete, markRecordTerminal, triggerNextSegmentIfNeeded } from './task-lifecycle';
import { resetFragmentIfGenerating } from './fragment-utils';
import { failGeneration, cancelGeneration, expireGeneration } from './store-sync';
import { taskLog } from './task-log';
import { safeSaveAsset } from './task-db-helpers';

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
        taskLog.warn(folderPath, 'resume_error', 'Failed to resume Rust-tracked task', { taskId: record.id, error: String(err) });
      }
    }
  }

  const staleRecords = transientRecords.filter((r) => !activeTaskIds.has(r.id));
  if (staleRecords.length > 0) {
    if (!seedanceInstance) {
      for (const record of staleRecords) {
        const idx = generationsFile.generations.findIndex((g) => g.id === record.id);
        if (idx < 0) continue;
        const errorMsg = t('generation.task.serviceNotConfigured');
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
          markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', t('generation.task.missingServerId'));
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
              taskLog.warn(folderPath, 'reregister_error', 'Failed to re-register server-tracked task with Rust', { taskId: record.id, error: String(err) });
            }
          }
        } else if (serverStatus === 'succeeded') {
          try {
            const updatedRecord = await restoreSucceededTask(record, folderPath, fs, serverResult!);
            generationsFile.generations[idx] = updatedRecord;
          } catch (error) {
            taskLog.error(folderPath, 'restore_error', 'Failed to restore succeeded task', { taskId: record.id, error: getErrorMessage(error) });
            markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', t('generation.task.restoreSucceededFailed', { message: getErrorMessage(error) }));
          }
        } else if (serverStatus === 'cancelled') {
          markRecordTerminal(generationsFile, idx, storeUpdates, 'cancelled');
        } else if (serverStatus === 'expired') {
          markRecordTerminal(generationsFile, idx, storeUpdates, 'expired', t('generation.task.resultExpired'));
        } else {
          const errorMsg = serverStatus === 'failed' ? t('generation.task.serverFailed') : t('generation.task.lostAfterRestart');
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
  } catch {
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

  const assetId = generateId();

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
  safeSaveAsset(db, folderPath, asset, 'db_save_asset');

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
    taskLog.warn(undefined, 'refresh_no_provider', 'No Seedance provider configured');
    return;
  }

  const gensWithApiId = activeGenerations.filter((g) => g.providerTaskId);
  if (gensWithApiId.length === 0) {
    taskLog.info(undefined, 'refresh_no_tasks', 'No active generations with providerTaskId to query');
    return;
  }

  const project = useProjectStore.getState().currentProject;
  const folderPath = project?.folderPath;

  const apiTaskIds = gensWithApiId.map((g) => g.providerTaskId!);
  const serverResults = await batchQueryServerStatuses(apiTaskIds, instance, folderPath);
  taskLog.info(folderPath, 'refresh_results', 'Query results', { results: Object.fromEntries(serverResults) });

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
        taskLog.warn(folderPath, 'refresh_resume_error', 'resumeGeneration failed', { taskId: gen.id, error: String(err) });
      }
      await refreshSucceededTaskFromServer(gen, serverResult, folderPath);
    } else if (serverStatus === 'failed') {
      const error = serverResult.error
        ? (typeof serverResult.error === 'string' ? serverResult.error : JSON.stringify(serverResult.error))
        : t('generation.task.serverFailed');
      if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'failed');
      const written = await failGeneration(gen.id, error, folderPath);
      if (written) { try { await tauriBridge.seedanceApi.acknowledgeTask(gen.id); } catch { /* acknowledgement is best-effort */ } }
    } else if (serverStatus === 'cancelled') {
      if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'draft');
      const written = await cancelGeneration(gen.id, folderPath);
      if (written) { try { await tauriBridge.seedanceApi.acknowledgeTask(gen.id); } catch { /* acknowledgement is best-effort */ } }
    } else if (serverStatus === 'expired') {
      const error = t('generation.task.resultExpired');
      if (gen.fragmentId) resetFragmentIfGenerating(gen.fragmentId, 'failed');
      const written = await expireGeneration(gen.id, error, folderPath);
      if (written) { try { await tauriBridge.seedanceApi.acknowledgeTask(gen.id); } catch { /* acknowledgement is best-effort */ } }
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
    taskLog.error(folderPath, 'refresh_download_error', 'Failed to download/complete task', { taskId: gen.id, error: getErrorMessage(err) });
    const errorMsg = t('generation.task.restoreSucceededFailed', { message: getErrorMessage(err) });
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

    const mediaRelPath = resolveGeneratedMediaPath(record);
    const mediaAbsPath = `${folderPath}/${mediaRelPath}`;
    const idx = recordIndex.get(record.id);
    const isImageOutput = record.outputType === 'image';

    const mediaInfo = await readGeneratedMediaInfo(record, mediaAbsPath, fs);

    if (mediaInfo !== null) {
      const assetId = generateId();
      const [thumbnailSettled] = await Promise.allSettled([
        generateThumbnailForAsset(mediaAbsPath, fs, isImageOutput ? 'image' : 'video', folderPath, assetId),
      ]);
      const thumbnailUrl = thumbnailSettled.status === 'fulfilled' ? thumbnailSettled.value?.thumbnailUrl : undefined;

      const webviewUrl = toWebViewUrl(mediaAbsPath);
      const project = useProjectStore.getState().currentProject;

      const asset = buildGeneratedAsset({
        taskId: record.id,
        assetId,
        relativePath: mediaRelPath,
        fileSize: mediaInfo.fileSize,
        videoUrl: webviewUrl,
        thumbnailUrl,
        duration: isImageOutput ? undefined : mediaInfo.duration,
        width: mediaInfo.width,
        height: mediaInfo.height,
        audioChannels: isImageOutput ? undefined : mediaInfo.audioChannels,
        sampleRate: isImageOutput ? undefined : mediaInfo.sampleRate,
        projectId: project?.id ?? '',
        outputType: isImageOutput ? 'image' : 'video',
        mimeType: isImageOutput ? (record.result?.mimeType ?? 'image/jpeg') : undefined,
        fileExtension: isImageOutput ? inferExtensionFromPath(mediaRelPath) : undefined,
      });
      const newAssetId = asset.id;

      assetStore.addAsset(asset);
      safeSaveAsset(db, folderPath, asset, 'db_save_reconciled');

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

      taskLog.info(folderPath, 'reconciled', 'Reconciled completed generation: asset rebuilt, fragment fixed', { recordId: record.id });

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

async function readGeneratedMediaInfo(
  record: GenerationRecord,
  mediaAbsPath: string,
  fs: NonNullable<Awaited<ReturnType<typeof getFs>>>,
): Promise<{
  fileSize: number;
  duration?: number;
  width?: number;
  height?: number;
  audioChannels?: number;
  sampleRate?: number;
} | null> {
  if (record.outputType === 'image') {
    const fileSize = await fs.getFileSize(mediaAbsPath).catch(() => null);
    if (fileSize === null) return null;
    return {
      fileSize,
      width: record.result?.width,
      height: record.result?.height,
    };
  }

  // Try to read video metadata directly — avoids TOCTOU from fs.exists()
  const metadata = await fs.getMediaMetadata(mediaAbsPath).catch(() => null);
  if (metadata === null) return null;

  const fileSize = await fs.getFileSize(mediaAbsPath).catch(() => 0);
  return {
    fileSize,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    audioChannels: metadata.audioChannels,
    sampleRate: metadata.sampleRate,
  };
}

function resolveGeneratedMediaPath(record: GenerationRecord): string {
  if (record.result?.fileName) return record.result.fileName;
  if (record.outputType === 'image') {
    return generatedImagePath(record.id, mimeTypeToExtension(record.result?.mimeType) ?? 'jpg');
  }
  return generatedVideoPath(record.id);
}

function inferExtensionFromPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? mimeTypeToExtension(ext) ?? ext : undefined;
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
    taskLog.info(undefined, 'orphan_reset', 'Resetting orphan generating fragment to draft', { fragmentId: f.id });
    timelineStore.updateFragment(f.id, { status: 'draft' });
  }
}
