/**
 * Task Lifecycle — handles task completion, continuous segment chaining,
 * cancel, and the markRecordTerminal helper.
 */

import { generateThumbnailForAsset } from '@opendirector/core/services/asset-import';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Generation } from '@opendirector/core/types/generation';
import { isActiveGenerationStatus } from '@opendirector/core/types/generation';
import { t } from '@opendirector/core/i18n';
import { getErrorMessage, getFileExtension, isAssetUrl, isRemoteUrl } from '@opendirector/core/utils/common';
import { toWebViewUrl } from '@opendirector/core/utils/platform';
import { generateId } from '@opendirector/core/utils/id';
import {
  generationToRecord,
  type GenerationRecord,
  type GenerationsFile,
} from '@opendirector/core/utils/xml';
import {
  updateGenerationsXml,
  readGenerationFromXml,
  getFs,
  getDb,
  extractProjectPath,
  buildGeneratedAsset,
  generatedVideoPath,
  generatedAudioPath,
  generatedImagePath,
  GENERATED_VIDEO_DIR,
  recordToParams,
  audioMimeForExtension,
  isAudioExt,
} from './generation-xml-repository';
import { submitGenerationTask } from './task-submitter';
import { resetFragmentIfGenerating } from './fragment-utils';
import { failGeneration, cancelGeneration, getGenerationById } from './store-sync';
import { taskLog } from './task-log';
import { safeSaveAsset, safeCreateGeneration } from './task-db-helpers';
import { scheduleSaveAfterCompletion } from './completion-save';
import { cancelAcrossControllers, getTaskController } from './task-controller-registry';

export interface TaskCompleteParams {
  taskId: string;
  apiTaskId: string;
  localPath: string;
  fileSize: number;
  lastFrameUrl?: string;
  projectPath?: string;
}

export async function handleTaskComplete(params: TaskCompleteParams): Promise<boolean> {
  const { taskId, apiTaskId, localPath, fileSize, lastFrameUrl, projectPath } = params;
  const gen = getGenerationById(taskId);

  const isAudioOutput = gen?.outputType === 'audio';
  // SeedAudio can emit wav/pcm/ogg (not just mp3); derive the extension + mime
  // from the file Rust actually wrote. MiniMax writes .mp3 so this stays mp3.
  const audioExt = isAudioOutput ? audioExtensionFromPath(localPath) : 'mp3';
  const outputPath = isAudioOutput ? generatedAudioPath(taskId, audioExt) : generatedVideoPath(taskId);
  const outputMime = isAudioOutput ? audioMimeForExtension(audioExt) : 'video/mp4';

  const taskProjectPath = projectPath ?? extractProjectPath(localPath);
  taskLog.info(taskProjectPath, 'complete_start', 'Handling task completion', {
    taskId,
    fileSize,
  });
  if (!gen) {
    // Generation not in the in-memory store (e.g. it completed while a different project was
    // open and was evicted on project switch). Recover outputType/fragmentId from the XML
    // record and build the asset so the downloaded file is not orphaned, then acknowledge.
    const fs = await getFs();
    if (!taskProjectPath || !fs) {
      return false;
    }
    try {
      const xmlRecord = await readGenerationFromXml(taskProjectPath, taskId, fs);
      const isAudio = xmlRecord?.outputType === 'audio';
      const isImage = xmlRecord?.outputType === 'image';
      const audioExt = isAudio ? audioExtensionFromPath(localPath) : 'mp3';
      const relPath = isAudio
        ? generatedAudioPath(taskId, audioExt)
        : isImage
          ? generatedImagePath(taskId)
          : generatedVideoPath(taskId);
      const mime = isAudio ? audioMimeForExtension(audioExt) : isImage ? 'image/jpeg' : 'video/mp4';

      const assetId = generateId();
      // fs.getMediaMetadata and getDb()->getProjectsByFolderPath have no data dependency,
      // so run them concurrently. mediaMeta is null on failure (unchanged); projectId is ''
      // on failure or null-db (matching the original try/catch); db stays in scope for safeSaveAsset.
      const dbPromise = getDb();
      const [mediaMeta, db, projectId] = await Promise.all([
        fs.getMediaMetadata(localPath).catch(() => null),
        dbPromise,
        // await unwraps the inner Promise so ?? '' can convert null (getProjectsByFolderPath
        // returns string | null) and undefined (null db) to '' — matching the original try/catch.
        dbPromise.then(async (db) => (await db?.getProjectsByFolderPath(taskProjectPath)) ?? '').catch(() => ''),
      ]);
      const webviewUrl = toWebViewUrl(localPath);

      const asset = buildGeneratedAsset({
        taskId,
        assetId,
        relativePath: relPath,
        fileSize,
        videoUrl: webviewUrl,
        thumbnailUrl: undefined,
        duration: mediaMeta?.duration,
        width: isAudio ? undefined : mediaMeta?.width,
        height: isAudio ? undefined : mediaMeta?.height,
        audioChannels: mediaMeta?.audioChannels,
        sampleRate: mediaMeta?.sampleRate,
        projectId: projectId ?? '',
        outputType: isAudio ? 'audio' : isImage ? 'image' : 'video',
        mimeType: mime,
      });
      safeSaveAsset(db, taskProjectPath, asset, 'db_save_asset_nogen');

      const written = await updateGenerationsXml(taskProjectPath, taskId, {
        status: 'completed',
        providerTaskId: apiTaskId,
        resultAssetId: assetId,
        completedAt: new Date().toISOString(),
        result: {
          fileName: relPath,
          fileSize,
          duration: mediaMeta?.duration ?? 0,
          width: mediaMeta?.width,
          height: mediaMeta?.height,
          mimeType: mime,
        },
      });
      return written;
    } catch (err) {
      taskLog.warn(taskProjectPath, 'complete_nogen_error', 'Failed to build asset for out-of-store completion', { taskId, error: String(err) });
      // Don't acknowledge — keep the pending record (with file_id) so it isn't silently lost.
      return false;
    }
  }

  if (gen.status === 'completed') {
    taskLog.info(taskProjectPath, 'complete_idempotent', 'Task already completed (idempotent)', { taskId });
    return true;
  }

  const project = useProjectStore.getState().currentProject;

  const isCurrentProject = project?.folderPath && (!taskProjectPath || taskProjectPath === project.folderPath);
  const effectiveFolderPath = isCurrentProject ? project!.folderPath! : taskProjectPath;
  const isBackgroundCompletion = !isCurrentProject && !!effectiveFolderPath;

  const fs = await getFs();
  const db = await getDb();

  if (effectiveFolderPath && fs) {
    try {
      const existingGen = await readGenerationFromXml(effectiveFolderPath, taskId, fs);
      if (existingGen && existingGen.status === 'completed') {
        taskLog.info(effectiveFolderPath, 'complete_idempotent_xml', 'Task already completed in Generations.xml (idempotent)', { taskId });
        if (isCurrentProject) {
          useGenerationStore.getState().updateGeneration(taskId, {
            status: 'completed',
          });
          const fragment = useTimelineStore.getState().fragments.find((f) => f.id === gen.fragmentId);
          if (fragment) {
            const webviewUrl = toWebViewUrl(localPath);
            useTimelineStore.getState().updateFragment(fragment.id, {
              generatedUrl: webviewUrl,
              status: 'completed',
            });
          }
          scheduleSaveAfterCompletion();
        }
        return true;
      }
    } catch {
      // proceed with normal completion flow
    }
  }

  try {
    if (!fs || !effectiveFolderPath) {
      await failGeneration(taskId, 'No project folder path available', effectiveFolderPath);
      return false;
    }

    // Pre-generate asset ID so thumbnail generation uses the same filename
    const assetId = generateId();

    const [metadataResult, thumbnailResult] = await Promise.allSettled([
      fs.getMediaMetadata(localPath).catch((error) => {
        // Don't block completion, but surface the failure so it isn't silently swallowed —
        // a missing duration here means the asset ships without media metadata and relies on
        // project-load re-hydration to recover.
        taskLog.warn(effectiveFolderPath, 'complete_media_metadata_error', 'Failed to probe generated media metadata', {
          taskId,
          localPath,
          error: String(error),
        });
        return null;
      }),
      isAudioOutput
        ? Promise.resolve(undefined)
        : generateThumbnailForAsset(localPath, fs, 'video', effectiveFolderPath, assetId),
    ]);

    const mediaMeta = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
    const thumbnailUrl = thumbnailResult.status === 'fulfilled' ? thumbnailResult.value?.thumbnailUrl : undefined;

    const webviewUrl = toWebViewUrl(localPath);

    let projectId = project?.id ?? '';
    if (isBackgroundCompletion) {
      try {
        const result = await db.getProjectsByFolderPath(effectiveFolderPath);
        if (result) projectId = result;
      } catch {
        // Generations.xml will still be updated
      }
    }

    const asset = buildGeneratedAsset({
      taskId,
      assetId,
      relativePath: outputPath,
      fileSize,
      videoUrl: webviewUrl,
      thumbnailUrl,
      duration: mediaMeta?.duration,
      width: isAudioOutput ? undefined : mediaMeta?.width,
      height: isAudioOutput ? undefined : mediaMeta?.height,
      audioChannels: mediaMeta?.audioChannels,
      sampleRate: mediaMeta?.sampleRate,
      projectId,
      outputType: isAudioOutput ? 'audio' : 'video',
      // Pass the derived mime/extension so SeedAudio ogg/wav/pcm assets are
      // stored with their real MIME (buildGeneratedAsset defaults audio to
      // 'audio/mpeg' + '.mp3' name when omitted). Matches the !gen path (118).
      mimeType: outputMime,
      fileExtension: audioExt,
    });

    const fragment = isCurrentProject
      ? useTimelineStore.getState().fragments.find((f) => f.id === gen.fragmentId)
      : undefined;

    if (isCurrentProject) {
      useAssetStore.getState().addAsset(asset);
      safeSaveAsset(db, effectiveFolderPath, asset, 'db_save_asset');
    } else if (projectId) {
      safeSaveAsset(db, effectiveFolderPath, asset, 'db_save_asset_bg');
    }

    taskLog.info(effectiveFolderPath, 'complete_asset_saved', 'Asset saved for completed task', {
      taskId,
      assetId,
    });

    const completedAt = new Date();

    const isContinuousIntermediate = gen.continuousMode && (gen.currentSegmentIndex ?? 0) + 1 < (gen.continuousPlan ?? []).length;

    // Persist last frame + build composite in parallel (independent operations)
    // Only persist for intermediate segments — the last segment has no next segment to chain to
    let lastFrameAssetId: string | undefined;
    if (isCurrentProject && gen.continuousMode) {
      const persistPromise = isContinuousIntermediate && lastFrameUrl
        ? persistLastFrame(taskId, gen, lastFrameUrl, effectiveFolderPath, fs, db, projectId)
          .then((id) => {
            if (id) {
              taskLog.info(effectiveFolderPath, 'last_frame_persisted', 'Persisted last frame image', { taskId, lastFrameAssetId: id });
            }
            return id;
          })
          .catch((err) => {
            taskLog.warn(effectiveFolderPath, 'last_frame_persist_error', 'Failed to persist last frame', { taskId, error: String(err) });
            return undefined;
          })
        : Promise.resolve(undefined);

      const compositePromise = isCurrentProject && fragment
        ? buildAndUpdateCompositeAsset(gen, effectiveFolderPath, fs, db, projectId, assetId, webviewUrl, thumbnailUrl)
          .catch((err) => {
            taskLog.warn(effectiveFolderPath, 'composite_error', 'Failed to build composite video', { taskId: gen.id, error: String(err) });
            // Fallback for last segment
            if (gen.continuousMode && (gen.currentSegmentIndex ?? 0) + 1 >= (gen.continuousPlan ?? []).length) {
              useTimelineStore.getState().updateFragment(fragment!.id, { generatedUrl: webviewUrl, status: 'completed' });
            }
          })
        : Promise.resolve();

      [lastFrameAssetId] = await Promise.all([persistPromise, compositePromise]);
    }

    if (isCurrentProject) {
      useGenerationStore.getState().updateGeneration(taskId, {
        resultAssetId: assetId,
        status: 'completed',
        providerTaskId: apiTaskId,
        result: {
          fileName: outputPath,
          fileSize,
          duration: mediaMeta?.duration ?? 0,
          width: mediaMeta?.width,
          height: mediaMeta?.height,
          mimeType: outputMime,
          lastFrameUrl,
          lastFrameAssetId,
        },
        ...(lastFrameAssetId ? { lastFrameAssetId } : {}),
        completedAt,
        ...(isContinuousIntermediate ? {} : { isSelected: true }),
      });
    }

    if (projectId) {
      const generation = getGenerationById(taskId);
      if (generation) {
        safeCreateGeneration(db, effectiveFolderPath, generation, 'db_create_gen');
      }
    }

    await updateGenerationsXml(effectiveFolderPath, taskId, {
      status: 'completed',
      resultAssetId: assetId,
      providerTaskId: apiTaskId,
      ...(isContinuousIntermediate ? {} : { isSelected: true }),
      ...(lastFrameAssetId ? { lastFrameAssetId } : {}),
      completedAt: new Date().toISOString(),
      result: {
        fileName: outputPath,
        fileSize,
        duration: mediaMeta?.duration ?? 0,
        width: mediaMeta?.width,
        height: mediaMeta?.height,
        mimeType: outputMime,
        lastFrameAssetId,
      },
    });

    taskLog.info(effectiveFolderPath, 'complete_xml_updated', 'Generations.xml updated for completed task', {
      taskId,
    });

    if (isCurrentProject && fragment) {
      if (!gen.continuousMode) {
        useTimelineStore.getState().updateFragment(fragment.id, {
          generatedUrl: webviewUrl,
          sourceAssetId: assetId,
          resultAssetId: assetId,
          thumbnailUrl,
          status: 'completed',
        });
      }
    }

    if (isCurrentProject) {
      await triggerNextSegmentIfNeeded(taskId, lastFrameUrl);
      scheduleSaveAfterCompletion();
    }

    return true;
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    taskLog.error(effectiveFolderPath, 'complete_error', 'Error in completion handler', {
      taskId,
      error: errorMsg,
    });
    await failGeneration(taskId, errorMsg, effectiveFolderPath);
    if (isCurrentProject && gen.fragmentId) {
      resetFragmentIfGenerating(gen.fragmentId, 'failed');
    }
    return false;
  }
}

export async function triggerNextSegmentIfNeeded(
  taskId: string,
  lastFrameUrl: string | undefined,
): Promise<void> {
  const gen = getGenerationById(taskId);
  if (!gen?.continuousMode) return;

  const plan = gen.continuousPlan ?? [];
  const nextIndex = (gen.currentSegmentIndex ?? 0) + 1;

  // Update generation with next segment index
  useGenerationStore.getState().updateGeneration(taskId, { currentSegmentIndex: nextIndex });

  const project = useProjectStore.getState().currentProject;
  if (project?.folderPath) {
    await updateGenerationsXml(project.folderPath, taskId, { currentSegmentIndex: nextIndex });
  }

  if (nextIndex >= plan.length) {
    taskLog.info(project?.folderPath, 'continuous_complete', `Continuous generation complete: ${plan.length} segments`, { taskId });
    return;
  }

  if (!lastFrameUrl) {
    taskLog.warn(project?.folderPath, 'continuous_missing_frame', 'No last_frame_url for segment chaining', { taskId, segmentIndex: nextIndex });
    await failGeneration(taskId, 'Missing last_frame_url for segment chaining', project?.folderPath);
    return;
  }

  // Prefer remote presigned URL directly — the API accepts it as-is.
  // Fall back to local path only if the remote URL is unavailable (crash recovery after URL expiry).
  let effectiveFirstFrameUrl = lastFrameUrl;
  if (!isRemoteUrl(lastFrameUrl) && !isAssetUrl(lastFrameUrl) && gen.lastFrameAssetId) {
    const asset = useAssetStore.getState().getAssetById(gen.lastFrameAssetId);
    if (asset?.relativePath && project?.folderPath) {
      effectiveFirstFrameUrl = `${project.folderPath}/${asset.relativePath}`;
    }
  }

  const nextDuration = plan[nextIndex];

  taskLog.info(project?.folderPath, 'continuous_segment_start', `Starting continuous segment ${nextIndex + 1}/${plan.length}`, {
    taskId,
    segmentIndex: nextIndex,
    duration: nextDuration,
  });

  try {
    const genRecord = generationToRecord(gen);
    const genParams = recordToParams(genRecord);
    await submitGenerationTask(
      gen.fragmentId!,
      gen.providerInstanceId,
      (gen.providerParams.model as string) ?? '',
      { ...genParams, duration: nextDuration },
      {
        firstFrameUrl: effectiveFirstFrameUrl,
        returnLastFrame: nextIndex + 1 < plan.length,
        continuousMode: true,
        continuousPlan: plan,
        currentSegmentIndex: nextIndex,
        continuousGroupId: gen.continuousGroupId ?? gen.id,
      },
    );
  } catch (error) {
    taskLog.error(project?.folderPath, 'segment_start_error', 'Failed to start segment', { taskId, segmentIndex: nextIndex, error: getErrorMessage(error) });
    await failGeneration(taskId, getErrorMessage(error), project?.folderPath);
  }
}

/**
 * Build or update a composite video from all completed segments in a continuous chain.
 * For the first segment, reuses the existing asset (no duplicate creation).
 * For subsequent segments, the media pipeline concatenates all completed segments.
 * The fragment is updated to show the composite with appropriate status.
 */
async function buildAndUpdateCompositeAsset(
  currentGen: Generation,
  projectPath: string,
  fs: NonNullable<Awaited<ReturnType<typeof getFs>>>,
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  projectId: string,
  existingAssetId: string,
  existingWebviewUrl: string,
  existingThumbnailUrl: string | undefined,
): Promise<void> {
  const groupId = currentGen.continuousGroupId ?? currentGen.id;
  const plan = currentGen.continuousPlan ?? [];
  const currentIdx = currentGen.currentSegmentIndex ?? 0;
  const isLastSegment = currentIdx + 1 >= plan.length;

  const fragment = useTimelineStore.getState().fragments.find((f) => f.id === currentGen.fragmentId);
  if (!fragment) return;

  // Collect all completed segment generation paths
  const allGenerations = useGenerationStore.getState().generations;
  const chainGenerations = allGenerations
    .filter((g) =>
      (g.continuousGroupId === groupId || g.id === groupId) &&
      g.continuousMode &&
      g.status === 'completed' &&
      (g.currentSegmentIndex ?? 0) <= currentIdx,
    )
    .sort((a, b) => (a.currentSegmentIndex ?? 0) - (b.currentSegmentIndex ?? 0));

  const segmentPaths = chainGenerations.map((g) =>
    `${projectPath}/${generatedVideoPath(g.id)}`
  );

  // First segment: reuse the existing asset already created by handleTaskComplete
  if (segmentPaths.length <= 1) {
    useTimelineStore.getState().updateFragment(fragment.id, {
      generatedUrl: existingWebviewUrl,
      sourceAssetId: existingAssetId,
      resultAssetId: existingAssetId,
      thumbnailUrl: existingThumbnailUrl,
      status: isLastSegment ? 'completed' : 'generating',
    });
    return;
  }

  // Multiple segments: concatenate via the media pipeline
  // Use versioned filename to avoid overwriting the file currently held by WebView
  try {
    const compositeFilename = `${groupId}-composite-v${segmentPaths.length}`;
    const result = await tauriBridge.mediaApi.concat({
      inputPaths: segmentPaths,
      outputDir: `${projectPath}/${GENERATED_VIDEO_DIR}`,
      outputFilename: compositeFilename,
    });
    const compositeLocalPath = result.outputPath;
    const compositeFileSize = result.fileSize;

    const compositeAssetId = currentGen.compositeAssetId ?? generateId();
    const thumbnailResult = await generateThumbnailForAsset(
      compositeLocalPath,
      fs,
      'video',
      projectPath,
      compositeAssetId,
    ).catch(() => undefined);
    const compositeThumbnailUrl = thumbnailResult?.thumbnailUrl;

    const mediaMeta = await fs.getMediaMetadata(compositeLocalPath).catch(() => null);

    const compositeWebviewUrl = toWebViewUrl(compositeLocalPath);
    const compositeRelativePath = `${GENERATED_VIDEO_DIR}/${compositeFilename}.mp4`;

    const asset = buildGeneratedAsset({
      taskId: groupId,
      assetId: compositeAssetId,
      relativePath: compositeRelativePath,
      fileSize: compositeFileSize,
      videoUrl: compositeWebviewUrl,
      thumbnailUrl: compositeThumbnailUrl,
      duration: mediaMeta?.duration,
      width: mediaMeta?.width,
      height: mediaMeta?.height,
      audioChannels: mediaMeta?.audioChannels,
      sampleRate: mediaMeta?.sampleRate,
      projectId,
    });

    useAssetStore.getState().addAsset(asset);
    safeSaveAsset(db, projectPath, asset, 'db_save_composite');

    // Clean up previous composite versions (v2, v3, ... v{N-1}) now that the new composite is ready
    for (let v = 2; v < segmentPaths.length; v++) {
      const oldPath = `${projectPath}/${GENERATED_VIDEO_DIR}/${groupId}-composite-v${v}.mp4`;
      fs.deleteFile(oldPath).catch(() => { /* ignore — old file may already be gone */ });
    }

    useGenerationStore.getState().updateGeneration(currentGen.id, { compositeAssetId });
    await updateGenerationsXml(projectPath, currentGen.id, { compositeAssetId });

    useTimelineStore.getState().updateFragment(fragment.id, {
      generatedUrl: compositeWebviewUrl,
      sourceAssetId: compositeAssetId,
      resultAssetId: compositeAssetId,
      thumbnailUrl: compositeThumbnailUrl,
      status: isLastSegment ? 'completed' : 'generating',
    });

    taskLog.info(projectPath, 'composite_updated', 'Composite video updated', {
      taskId: currentGen.id,
      compositeAssetId,
      segmentCount: segmentPaths.length,
      isLastSegment,
    });
  } catch (err) {
    taskLog.warn(projectPath, 'composite_error', 'Failed to build composite video', {
      taskId: currentGen.id,
      error: String(err),
    });

    // Fallback: show last segment's video
    if (isLastSegment) {
      useTimelineStore.getState().updateFragment(fragment.id, {
        generatedUrl: existingWebviewUrl,
        status: 'completed',
      });
    }
  }
}

/**
 * Persist a last-frame image to disk, create an asset, create a generation
 * record, and return the asset ID.
 * The image is downloaded from the remote URL and saved locally so it survives
 * restarts (unlike the 24h-expiring remote URL).
 * A generation record with outputType='image' is created so the last-frame
 * appears as an independent image card in the generation list.
 */
async function persistLastFrame(
  parentTaskId: string,
  parentGen: Generation,
  lastFrameUrl: string,
  projectPath: string,
  fs: NonNullable<Awaited<ReturnType<typeof getFs>>>,
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  projectId: string,
): Promise<string | undefined> {
  const imageId = `${parentTaskId}-lastframe`;

  try {
    const result = await tauriBridge.seedanceApi.downloadGenerationImage(
      lastFrameUrl,
      projectPath,
      imageId,
    );

    const localPath = result.file_path;
    const assetId = generateId();

    const thumbnailResult = await generateThumbnailForAsset(localPath, fs, 'image', projectPath, assetId)
      .catch(() => undefined);
    const thumbnailUrl = thumbnailResult?.thumbnailUrl;

    const webviewUrl = toWebViewUrl(localPath);
    const relativePath = generatedImagePath(imageId);

    const asset = buildGeneratedAsset({
      taskId: imageId,
      assetId,
      relativePath,
      fileSize: result.file_size,
      videoUrl: webviewUrl,
      thumbnailUrl,
      duration: undefined,
      width: undefined,
      height: undefined,
      projectId,
      outputType: 'image',
    });

    useAssetStore.getState().addAsset(asset);
    safeSaveAsset(db, projectPath, asset, 'db_save_lastframe');

    // Create an independent image generation record for the last-frame card
    const segmentLabel = parentGen.continuousMode && parentGen.currentSegmentIndex != null
      ? t('generation.task.segmentLastFrame', { index: parentGen.currentSegmentIndex + 1 })
      : t('generation.task.lastFrame');
    const lastFrameGen: Generation = {
      ...parentGen,
      id: imageId,
      promptText: `[${segmentLabel}] ${parentGen.promptText}`,
      references: [],
      outputType: 'image',
      resultAssetId: assetId,
      status: 'completed',
      completedAt: new Date(),
      isSelected: false,
      createdAt: new Date(),
      // Clear continuous-mode fields that don't apply to a last-frame image
      continuousMode: undefined,
      continuousPlan: undefined,
      continuousGroupId: undefined,
      currentSegmentIndex: undefined,
      lastFrameAssetId: undefined,
      compositeAssetId: undefined,
      firstFrameAsReference: undefined,
      errorMessage: undefined,
      providerTaskId: undefined,
      result: undefined,
    };
    useGenerationStore.getState().addGeneration(lastFrameGen);
    safeCreateGeneration(db, projectPath, lastFrameGen, 'db_create_lastframe_gen');

    return assetId;
  } catch {
    return undefined;
  }
}

/** Cancel a running generation task: send Rust signal, update store, persist to XML. */
export async function cancelGenerationTask(taskId: string): Promise<void> {
  const gen = getGenerationById(taskId);
  if (!gen) return;
  if (!isActiveGenerationStatus(gen.status)) return;

  // Resolve the provider typeId from the generation's providerInstanceId, then
  // dispatch cancel through the TaskController registry. No silent seedance
  // fallback — if the typeId has no registered controller, skip with a warning.
  const instance = useProviderInstanceStore.getState().get(gen.providerInstanceId);
  const typeId = instance?.typeId;
  const controller = typeId ? getTaskController(typeId) : undefined;

  try {
    if (controller) {
      await controller.cancel(taskId);
    } else {
      // The provider instance was deleted (typeId unknown) or no controller is
      // registered for it. Cancel is keyed by task_id in the Rust managers and
      // idempotent, so broadcast to every controller to ensure the signal
      // reaches whichever manager holds the task — otherwise a running task
      // whose instance was removed could never be cancelled.
      taskLog.warn(undefined, 'cancel_no_controller', 'Provider instance/controller missing for task; broadcasting cancel to all controllers', { taskId });
      await cancelAcrossControllers(taskId);
    }
  } catch (err) {
    taskLog.warn(undefined, 'cancel_signal_error', 'Failed to send cancel signal', { taskId, error: String(err) });
  }

  const currentGen = getGenerationById(taskId);
  if (!currentGen || !isActiveGenerationStatus(currentGen.status)) return;

  if (currentGen.fragmentId) {
    resetFragmentIfGenerating(currentGen.fragmentId, 'draft');
  }

  const project = useProjectStore.getState().currentProject;
  await cancelGeneration(taskId, project?.folderPath);
}

export function markRecordTerminal(
  generationsFile: GenerationsFile,
  idx: number,
  storeUpdates: Array<{ id: string; updates: { status: GenerationRecord['status']; errorMessage?: string } }>,
  status: 'failed' | 'cancelled' | 'expired',
  errorMsg?: string,
): void {
  generationsFile.generations[idx] = {
    ...generationsFile.generations[idx],
    status,
    ...(errorMsg ? { error: errorMsg } : {}),
    completedAt: new Date().toISOString(),
  };
  storeUpdates.push({
    id: generationsFile.generations[idx].id,
    updates: { status, ...(errorMsg ? { errorMessage: errorMsg } : {}) },
  });
}

/** Derive an audio file extension from a generated file path (defaults to mp3). */
function audioExtensionFromPath(localPath: string): string {
  const ext = getFileExtension(localPath);
  return isAudioExt(ext) ? ext : 'mp3';
}

