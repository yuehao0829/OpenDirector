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
  generatedAudioPath,
  mimeTypeToExtension,
} from './generation-xml-repository';
import { markRecordTerminal, triggerNextSegmentIfNeeded } from './task-lifecycle';
import { resetFragmentIfGenerating } from './fragment-utils';
import { taskLog } from './task-log';
import { safeSaveAsset } from './task-db-helpers';
import { getTaskController, type TaskController } from './task-controller-registry';

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
    tauriBridge.listPendingTasks(),
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
  const storeUpdates: Array<{ id: string; updates: { status: GenerationRecord['status']; errorMessage?: string } }> = [];

  // Resolve the provider instance + TaskController for a transient record
  // (falls back to the XML record's providerInstanceId when no pending task
  // file exists). Returns the controller (or undefined if the typeId is
  // unregistered — callers skip-with-warning, NO silent seedance fallback).
  const resolveRecordController = (record: GenerationRecord): { instance: ProviderInstance | undefined; controller: TaskController | undefined } => {
    const pendingRecord = pendingTasks.find((t) => t.task_id === record.id);
    const providerId = pendingRecord?.provider_id ?? record.providerInstanceId;
    const instance = useProviderInstanceStore.getState().get(providerId);
    const typeId = instance?.typeId;
    return { instance, controller: typeId ? getTaskController(typeId) : undefined };
  };

  // 1. Records with a pending task file → resume via the controller.
  //    Each provider re-registers with its own Rust coordinator.
  for (const record of transientRecords) {
    if (!activeTaskIds.has(record.id)) continue;
    restoreProcessingRecord(record);

    const { instance, controller } = resolveRecordController(record);
    const password = getProviderPassword(instance);
    if (!controller) {
      taskLog.warn(folderPath, 'resume_no_controller', 'No TaskController for provider type', { taskId: record.id, typeId: instance?.typeId });
      const idx = generationsFile.generations.findIndex((g) => g.id === record.id);
      if (idx >= 0) {
        markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', t('generation.task.serviceNotConfigured'));
        if (record.fragmentId) {
          resetFragmentIfGenerating(record.fragmentId, 'failed');
        }
      }
      continue;
    }
    if (password) {
      try {
        await controller.resume(record.id, password);
        taskLog.info(folderPath, 'resume_task', 'Resuming Rust-tracked task', { taskId: record.id, typeId: instance?.typeId });
      } catch (err) {
        taskLog.warn(folderPath, 'resume_error', 'Failed to resume Rust-tracked task', { taskId: record.id, error: String(err) });
      }
    } else {
      // No credentials (e.g. provider instance deleted) — cannot resume. Mark failed so the
      // task + fragment are not stuck in 'processing'/'generating' forever.
      const idx = generationsFile.generations.findIndex((g) => g.id === record.id);
      if (idx >= 0) {
        markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', t('generation.task.serviceNotConfigured'));
        if (record.fragmentId) {
          resetFragmentIfGenerating(record.fragmentId, 'failed');
        }
      }
    }
  }

  const staleRecords = transientRecords.filter((r) => !activeTaskIds.has(r.id));
  if (staleRecords.length > 0) {
    // Build index for O(1) lookups
    const recordIndex = new Map<string, number>();
    for (let i = 0; i < generationsFile.generations.length; i++) {
      recordIndex.set(generationsFile.generations[i].id, i);
    }

    // Group stale records by controller. Controllers without `batchQuery`
    // (MiniMax, GPT-Image) are unrecoverable from JS without a pending file
    // → mark failed. Controllers with `batchQuery` (Seedance) get the
    // server-status-query flow.
    const pollableStale: Array<{ record: GenerationRecord; controller: TaskController; instance: ProviderInstance | undefined }> = [];
    for (const record of staleRecords) {
      const idx = recordIndex.get(record.id) ?? -1;
      if (idx < 0) continue;

      const { instance, controller } = resolveRecordController(record);
      if (!controller) {
        taskLog.warn(folderPath, 'stale_no_controller', 'No TaskController for stale record', { taskId: record.id, typeId: instance?.typeId });
        markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', t('generation.task.lostAfterRestart'));
        continue;
      }
      if (!controller.batchQuery) {
        // Event-driven or synchronous provider with no JS-side polling —
        // without a pending file there is no way to recover. Mark failed
        // (matches the former minimaxStale behavior).
        markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', t('generation.task.lostAfterRestart'));
        continue;
      }
      // Has batchQuery → collect for the server-query flow below.
      pollableStale.push({ record, controller, instance });
    }

    // Server-query flow for controllers that support JS-side polling (Seedance).
    // Group by controller so each controller's batchQuery is called once with
    // all its stale task IDs.
    if (pollableStale.length > 0) {
      const byController = new Map<TaskController, typeof pollableStale>();
      for (const item of pollableStale) {
        const group = byController.get(item.controller) ?? [];
        group.push(item);
        byController.set(item.controller, group);
      }

      for (const [controller, items] of byController) {
        // Type guard — controllers without batchQuery were filtered out above,
        // but TypeScript can't narrow through the Map iteration.
        if (!controller.batchQuery) continue;

        // Resolve an instance for credentials (use the first available).
        const instance = items.find((i) => i.instance)?.instance;
        if (!instance) {
          for (const { record } of items) {
            const idx = recordIndex.get(record.id) ?? -1;
            if (idx < 0) continue;
            markRecordTerminal(generationsFile, idx, storeUpdates, 'failed', t('generation.task.serviceNotConfigured'));
          }
          continue;
        }

        const password = getProviderPassword(instance);
        const providerTaskIds = items
          .map((i) => i.record.providerTaskId)
          .filter((id): id is string => !!id);
        const serverResultsArray = await controller.batchQuery(instance, password, providerTaskIds);
        const serverStatusMap = new Map<string, TaskStatusResult>();
        for (const r of serverResultsArray) {
          serverStatusMap.set(r.task_id, r);
        }
        if (folderPath) {
          taskLog.info(folderPath, 'batch_query_result', 'Batch query succeeded', { count: serverResultsArray.length });
        }

        for (const { record } of items) {
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
            if (password) {
              try {
                await controller.resume(record.id, password);
              } catch (err) {
                taskLog.warn(folderPath, 'reregister_error', 'Failed to re-register server-tracked task with Rust', { taskId: record.id, error: String(err) });
              }
            }
          } else if (serverStatus === 'succeeded') {
            try {
              const updatedRecord = await restoreSucceededTask(record, folderPath, fs, serverResult!, controller);
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
 * Restore a server-completed task that has no local result.
 * Downloads video, creates asset, and updates all stores.
 *
 * The `controller` provides the provider-specific `downloadResult` method
 * (replacing the former direct `seedanceApi.downloadGenerationVideo` call).
 */
async function restoreSucceededTask(
  record: GenerationRecord,
  folderPath: string,
  fs: NonNullable<Awaited<ReturnType<typeof getFs>>>,
  serverResult: TaskStatusResult,
  controller: TaskController,
): Promise<GenerationRecord> {
  if (!record.providerTaskId) throw new Error('Missing providerTaskId');

  const videoUrl = serverResult.result_url;
  if (!videoUrl) throw new Error('Server task succeeded but no video_url returned');

  if (!controller.downloadResult) {
    throw new Error('Controller does not support downloadResult');
  }
  const downloadResult = await controller.downloadResult({
    url: videoUrl,
    projectPath: folderPath,
    generationId: record.id,
  });
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

/**
 * Manually refresh active generation tasks.
 *
 * Groups active generations by their provider's TaskController and delegates
 * to `controller.refreshActive?.()` for each. Only Seedance implements
 * `refreshActive` (it has a JS-side batch query endpoint). Event-driven
 * providers (MiniMax) and synchronous providers (GPT Image) are skipped with
 * a warning — their state is driven by Rust coordinator events, not JS polling.
 */
export async function refreshActiveGenerations(): Promise<void> {
  const store = useGenerationStore.getState();
  const activeGenerations = store.generations.filter((g) => isActiveGenerationStatus(g.status));
  if (activeGenerations.length === 0) return;

  // Group active generations by controller (resolved via typeId).
  const gensByController = new Map<TaskController, Generation[]>();
  for (const gen of activeGenerations) {
    const instance = useProviderInstanceStore.getState().get(gen.providerInstanceId);
    const typeId = instance?.typeId;
    if (!typeId) {
      taskLog.warn(undefined, 'refresh_no_type', 'Active generation has no provider type', { taskId: gen.id });
      continue;
    }
    const controller = getTaskController(typeId);
    if (!controller) {
      taskLog.warn(undefined, 'refresh_no_controller', 'No TaskController for active generation', { taskId: gen.id, typeId });
      continue;
    }
    if (!controller.refreshActive) {
      // Event-driven (MiniMax) or synchronous (GPT Image) — no JS-side polling.
      taskLog.info(undefined, 'refresh_skip_event_driven', 'Skipping refresh for provider without JS polling', { taskId: gen.id, typeId });
      continue;
    }
    const group = gensByController.get(controller) ?? [];
    group.push(gen);
    gensByController.set(controller, group);
  }

  if (gensByController.size === 0) return;

  const folderPath = useProjectStore.getState().currentProject?.folderPath;

  // Dispatch each controller's refreshActive concurrently.
  await Promise.all(
    Array.from(gensByController.entries()).map(([controller, gens]) =>
      controller.refreshActive!(gens, folderPath),
    ),
  );
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
    const isAudioOutput = record.outputType === 'audio';

    const mediaInfo = await readGeneratedMediaInfo(record, mediaAbsPath, fs);

    if (mediaInfo !== null) {
      const assetId = generateId();
      const [thumbnailSettled] = await Promise.allSettled([
        isAudioOutput
          ? Promise.resolve(undefined)
          : generateThumbnailForAsset(mediaAbsPath, fs, isImageOutput ? 'image' : 'video', folderPath, assetId),
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
        width: isAudioOutput ? undefined : mediaInfo.width,
        height: isAudioOutput ? undefined : mediaInfo.height,
        audioChannels: isImageOutput ? undefined : mediaInfo.audioChannels,
        sampleRate: isImageOutput ? undefined : mediaInfo.sampleRate,
        projectId: project?.id ?? '',
        outputType: isImageOutput ? 'image' : isAudioOutput ? 'audio' : 'video',
        mimeType: isImageOutput
          ? (record.result?.mimeType ?? 'image/jpeg')
          : isAudioOutput
            ? (record.result?.mimeType ?? 'audio/mpeg')
            : undefined,
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
  if (record.outputType === 'audio') {
    // Derive the extension from the recorded mimeType (symmetric with the image
    // branch above) so a non-mp3 SeedAudio output (wav/ogg/pcm) resolves to its
    // real file rather than a non-existent `<id>.mp3`.
    return generatedAudioPath(record.id, mimeTypeToExtension(record.result?.mimeType) ?? 'mp3');
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
