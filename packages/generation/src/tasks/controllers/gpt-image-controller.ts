/**
 * GPT Image TaskController.
 *
 * GPT Image generation is synchronous: the Rust `openai_generate_image`
 * command blocks until the image is ready (no polling, no events). Therefore:
 * - `start` delegates to `submitGptImageTask` which does the full inline
 *   generate + asset-create + XML-write flow.
 * - `cancel` is a no-op returning true — by the time the user could cancel,
 *   the synchronous call has already completed.
 * - `resume` is a no-op returning false — there is no async task to resume.
 * - No polling methods (batchQuery / getTaskStatus / downloadResult /
 *   refreshActive) — nothing to poll.
 */

import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { generateThumbnailForAsset } from '@opendirector/core/services/asset-import';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { computeGptImageSize, type Generation, type GenerationParams } from '@opendirector/core/types/generation';
import { getErrorMessage } from '@opendirector/core/utils/common';
import { generateId } from '@opendirector/core/utils/id';
import { toWebViewUrl } from '@opendirector/core/utils/platform';
import { providerTypeRegistry } from '../../providers/type-registry';
import type { TaskController, TaskControllerStartInput } from '../task-controller-registry';
import {
  updateGenerationsXml,
  resolveFragmentContext,
  buildProviderParams,
  getProviderPassword,
  getDb,
  getFs,
  buildGeneratedAsset,
  generatedImagePath,
  mimeTypeToExtension,
} from '../generation-xml-repository';
import { resetFragmentIfGenerating } from '../fragment-utils';
import { failGeneration } from '../store-sync';
import { taskLog } from '../task-log';
import { safeCreateGeneration, safeSaveAsset } from '../task-db-helpers';
import { scheduleSaveAfterCompletion } from '../completion-save';

export const gptImageController: TaskController = {
  start: submitGptImageTask,

  // Synchronous generation — nothing to cancel by the time this is reachable.
  async cancel(_taskId) {
    return true;
  },

  // Synchronous generation — no pending task to resume after restart.
  async resume(_taskId, _password) {
    return false;
  },

  // No batchQuery / getTaskStatus / downloadResult / refreshActive —
  // GPT Image is synchronous with no JS-side polling surface.
};
/**
 * Submit a GPT Image generation task (synchronous — no polling).
 */
async function submitGptImageTask(input: TaskControllerStartInput): Promise<string> {
  const { fragmentId, instanceId, modelId, params, instance } = input;
  const taskId = generateId();
  useTimelineStore.getState().updateFragment(fragmentId, { status: 'generating' });

  const ctx = resolveFragmentContext(fragmentId);
  const providerInstance = instance ?? useProviderInstanceStore.getState().get(instanceId);
  const providerLabel = providerInstance?.displayName ?? instanceId;
  const modelName = providerTypeRegistry.findModelVariant(modelId)?.name;
  const project = useProjectStore.getState().currentProject;
  const folderPath = project?.folderPath;

  if (!folderPath) {
    await failGeneration(taskId, 'No project folder path');
    resetFragmentIfGenerating(fragmentId, 'draft');
    return taskId;
  }

  const normalized = normalizeGptImageParams(params);
  const providerParams = buildProviderParams(modelId, normalized, modelName);
  const references = params.references.map((r) => ({
    assetId: r.assetId,
    type: r.type,
    weight: r.weight ?? 1,
    role: r.role,
  }));

  const pendingGeneration: Generation = {
    id: taskId,
    projectId: project.id ?? '',
    fragmentId,
    fragmentName: ctx.fragmentName,
    promptText: params.prompt,
    references,
    providerInstanceId: instanceId,
    providerDisplayName: providerLabel,
    providerParams,
    outputType: 'image',
    status: 'pending',
    queuedAt: new Date(),
    isSelected: false,
    createdAt: new Date(),
  };
  useGenerationStore.getState().addGeneration(pendingGeneration);

  await updateGenerationsXml(folderPath, taskId, {
    status: 'pending',
    fragmentId,
    fragmentName: ctx.fragmentName,
    prompt: params.prompt,
    references,
    providerInstanceId: instanceId,
    providerDisplayName: providerLabel,
    providerParams,
    outputType: 'image',
    isSelected: false,
    createdAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  });

  const password = getProviderPassword(providerInstance);

  try {
    await updateGenerationsXml(folderPath, taskId, {
      status: 'processing',
      startedAt: new Date().toISOString(),
    });
    useGenerationStore.getState().updateGeneration(taskId, {
      status: 'processing',
      startedAt: new Date(),
    });

    const result = await tauriBridge.openAIImageApi.generateImage({
      provider_id: instanceId,
      password,
      task_id: taskId,
      project_path: folderPath,
      model: modelId,
      prompt: params.prompt,
      n: 1,
      size: normalized.imageSize,
      quality: normalized.imageQuality,
      output_format: normalized.imageOutputFormat,
      background: normalized.imageBackground,
      moderation: normalized.imageModeration,
      output_compression: normalized.imageOutputCompression,
    });

    const [fs, db] = await Promise.all([getFs(), getDb()]);
    const assetId = generateId();
    const thumbnailResult = fs
      ? await generateThumbnailForAsset(result.file_path, fs, 'image', folderPath, assetId).catch(() => undefined)
      : undefined;
    const thumbnailUrl = thumbnailResult?.thumbnailUrl;
    const webviewUrl = toWebViewUrl(result.file_path);
    const extension = mimeTypeToExtension(result.mime_type) ?? mimeTypeToExtension(result.output_format) ?? 'png';
    const relativePath = generatedImagePath(taskId, extension);

    const asset = buildGeneratedAsset({
      taskId,
      assetId,
      relativePath,
      fileSize: result.file_size,
      videoUrl: webviewUrl,
      thumbnailUrl,
      duration: undefined,
      width: result.width,
      height: result.height,
      projectId: project?.id ?? '',
      outputType: 'image',
      mimeType: result.mime_type,
      fileExtension: extension,
    });

    useAssetStore.getState().addAsset(asset);
    safeSaveAsset(db, folderPath, asset, 'db_save_gpt_image_asset');

    const completedAt = new Date();
    const resultInfo = {
      fileName: relativePath,
      fileSize: result.file_size,
      duration: 0,
      width: result.width,
      height: result.height,
      mimeType: result.mime_type,
      usage: result.usage,
      revisedPrompt: result.revised_prompt,
      created: result.created,
    };

    useGenerationStore.getState().updateGeneration(taskId, {
      resultAssetId: assetId,
      status: 'completed',
      result: resultInfo,
      completedAt,
      isSelected: true,
    });

    const generation: Generation = {
      ...pendingGeneration,
      resultAssetId: assetId,
      status: 'completed',
      result: resultInfo,
      completedAt,
      isSelected: true,
    };
    safeCreateGeneration(db, folderPath, generation, 'db_create_gpt_image_gen');

    await updateGenerationsXml(folderPath, taskId, {
      status: 'completed',
      resultAssetId: assetId,
      isSelected: true,
      completedAt: completedAt.toISOString(),
      result: resultInfo,
    });

    useTimelineStore.getState().updateFragment(fragmentId, {
      generatedUrl: webviewUrl,
      sourceAssetId: assetId,
      resultAssetId: assetId,
      thumbnailUrl,
      status: 'completed',
    });

    scheduleSaveAfterCompletion();
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    taskLog.error(folderPath, 'gpt_image_submit_error', 'Failed to generate image', {
      taskId,
      error: errorMsg,
    });
    await failGeneration(taskId, errorMsg, folderPath);
    resetFragmentIfGenerating(fragmentId, 'failed');
  }

  return taskId;
}

function normalizeGptImageParams(params: GenerationParams): GenerationParams {
  const outputFormat = params.imageOutputFormat ?? 'png';
  let background = params.imageBackground ?? 'auto';
  if (background === 'transparent' && outputFormat === 'jpeg') {
    background = 'auto';
  }
  const resolution = params.resolution ?? '1080p';
  const aspectRatio = params.aspectRatio ?? '16:9';
  const computedSize = computeGptImageSize(resolution, aspectRatio);

  return {
    ...params,
    imageSize: computedSize,
    imageQuality: params.imageQuality ?? 'auto',
    imageOutputFormat: outputFormat,
    imageBackground: background,
    imageModeration: params.imageModeration ?? 'auto',
  };
}
