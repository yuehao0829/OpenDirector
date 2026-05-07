/**
 * Task Submitter — builds content items, resolves the Ark model ID,
 * and submits a generation task via the Rust backend.
 */

import { getPlatformAdapter } from '@opendirector/core/adapters';
import { autoProcessReferences } from '@opendirector/core/services/reference-auto-processor';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { SeedanceContentItem } from '@opendirector/core/types/ai-video';
import type { Generation, GenerationParams } from '@opendirector/core/types/generation';
import type { SubmitGenerationOptions } from '@opendirector/core/types/service-interfaces';
import { t } from '@opendirector/core/i18n';
import { getErrorMessage, isAssetUrl, isRemoteUrl } from '@opendirector/core/utils/common';
import { generateId } from '@opendirector/core/utils/id';
import { seedanceTypeDefinition } from '../providers/builtin-types/seedance-type';
import { refTypeToRole } from '../providers/seedance';
import { providerRuntimeRegistry, resolveDefaultAssetProvider } from '../providers/runtime-registry';
import { providerTypeRegistry } from '../providers/type-registry';
import {
  updateGenerationsXml,
  resolveFragmentContext,
  buildProviderParams,
  getProviderPassword,
  getContentUrl,
  setContentUrl,
  resolveLocalFilePath,
} from './generation-xml-repository';
import { resetFragmentIfGenerating } from './fragment-utils';
import { failGeneration } from './store-sync';
import { taskLog } from './task-log';

export async function submitGenerationTask(
  fragmentId: string,
  instanceId: string,
  modelId: string,
  params: GenerationParams,
  options?: SubmitGenerationOptions,
): Promise<string> {
  const continuousMeta = options?.continuousMode ? {
    continuousMode: true,
    continuousPlan: options.continuousPlan,
    currentSegmentIndex: options.currentSegmentIndex,
    continuousGroupId: options.continuousGroupId,
  } : undefined;

  const taskId = generateId();

  useTimelineStore.getState().updateFragment(fragmentId, { status: 'generating' });

  // Resolve context early so we can create a pending Generation record
  const ctx = resolveFragmentContext(fragmentId);
  const instance = useProviderInstanceStore.getState().get(instanceId);
  const providerLabel = instance?.displayName ?? instanceId;

  const modelName = resolveModelName(instanceId, modelId);
  const providerParams = buildProviderParams(modelId, params, modelName);

  const project = useProjectStore.getState().currentProject;
  const folderPath = project?.folderPath;

  const generationReferences = params.references.map((r) => ({
    assetId: r.assetId,
    type: r.type,
    weight: r.weight ?? 1,
    role: r.role,
  }));

  // Create a pending Generation record immediately so UI can show it
  const pendingGeneration: Generation = {
    id: taskId,
    projectId: project?.id ?? '',
    fragmentId,
    fragmentName: ctx.fragmentName,
    promptText: params.prompt,
    references: generationReferences,
    providerInstanceId: instanceId,
    providerDisplayName: providerLabel,
    providerParams,
    outputType: 'video',
    status: 'pending',
    queuedAt: new Date(),
    isSelected: false,
    createdAt: new Date(),
    continuousMode: continuousMeta?.continuousMode,
    continuousPlan: continuousMeta?.continuousPlan,
    currentSegmentIndex: continuousMeta?.currentSegmentIndex,
    continuousGroupId: continuousMeta?.continuousGroupId,
  };
  useGenerationStore.getState().addGeneration(pendingGeneration);

  taskLog.info(folderPath, 'submit_pending', 'Generation task submitted', {
    taskId,
    fragmentId,
    providerId: instanceId,
    model: modelId,
  });

  if (!folderPath) {
    await failGeneration(taskId, 'No project folder path');
    resetFragmentIfGenerating(fragmentId, 'draft');
    return taskId;
  }

  await updateGenerationsXml(folderPath, taskId, {
    status: 'pending',
    fragmentId,
    fragmentName: ctx.fragmentName,
    prompt: params.prompt,
    references: generationReferences,
    providerInstanceId: instanceId,
    providerDisplayName: providerLabel,
    providerParams,
    outputType: 'video',
    isSelected: false,
    createdAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    continuousMode: continuousMeta?.continuousMode,
    continuousPlan: continuousMeta?.continuousPlan,
    currentSegmentIndex: continuousMeta?.currentSegmentIndex,
    continuousGroupId: continuousMeta?.continuousGroupId,
  });

  const arkModelId = resolveArkModelId(instanceId, modelId);
  const content = await buildContentItems(params);

  let assets = useAssetStore.getState().assets;

  // Auto-process references (compress/transcode) before TOS upload
  if (options?.inputRequirements) {
    try {
      const platform = await getPlatformAdapter();
      const fs = platform.fs;
      if (fs) {
        const autoResult = await autoProcessReferences({
          references: params.references,
          getAsset: (assetId) => assets.find((a) => a.id === assetId),
          requirements: options.inputRequirements,
          projectPath: folderPath,
          fs,
        });

        // Register new assets in store
        for (const newAsset of autoResult.newAssets) {
          useAssetStore.getState().addAsset(newAsset);
        }

        // Replace assetIds in content items
        for (const item of content) {
          if (item.type !== 'image_url' && item.type !== 'video_url' && item.type !== 'audio_url') continue;
          const url = getContentUrl(item);
          if (url && autoResult.assetIdMap.has(url)) {
            setContentUrl(item, autoResult.assetIdMap.get(url)!);
          }
        }

        // Refresh assets snapshot so TOS upload and local_references can resolve new assets
        assets = useAssetStore.getState().assets;
      }
    } catch (err) {
      taskLog.warn(folderPath, 'auto_process_error', 'Auto-process references failed', {
        taskId,
        error: String(err),
      });
      // Continue with original references — best-effort
    }
  }

  // Insert first-frame image BEFORE TOS upload so it gets uploaded if it's a local path
  if (options?.firstFrameUrl) {
    const hasReferenceImage = content.some(
      (item) => item.type === 'image_url' && item.role === 'reference_image'
    );

    // When reference_image exists, first_frame must be demoted (API doesn't allow both)
    const effectiveRole = hasReferenceImage ? 'reference_image' : 'first_frame';

    for (const item of content) {
      if (item.type === 'image_url' && item.role === 'first_frame') {
        item.role = 'reference_image';
      }
    }
    const firstFrameItem: SeedanceContentItem = {
      type: 'image_url',
      image_url: { url: options.firstFrameUrl },
      role: effectiveRole,
    };
    const firstTextIdx = content.findIndex((c) => c.type !== 'text');
    if (firstTextIdx >= 0) {
      content.splice(firstTextIdx, 0, firstFrameItem);
    } else {
      content.push(firstFrameItem);
    }

    if (hasReferenceImage) {
      // Append first-frame hint to prompt
      const imageItemsBefore = content.slice(0, firstTextIdx >= 0 ? firstTextIdx : content.length)
        .filter((item) => item.type === 'image_url').length;
      const firstFrameImageIndex = imageItemsBefore + 1;
      const promptItem = content.find((c) => c.type === 'text');
      if (promptItem && promptItem.text) {
        promptItem.text += `\n${t('generation.prompt.firstFrameHint', { index: firstFrameImageIndex })}`;
      }
      useGenerationStore.getState().updateGeneration(taskId, {
        firstFrameAsReference: true,
      });
    }
  }

  const assetProvider = resolveDefaultAssetProvider();

  if (assetProvider) {
    const provider = await providerRuntimeRegistry.getOrInitializeAssetProvider(assetProvider.instanceId);

    if (provider) {
      for (let i = 0; i < content.length; i++) {
        const item = content[i];
        if (item.type !== 'image_url' && item.type !== 'video_url' && item.type !== 'audio_url') continue;

        const url = getContentUrl(item);
        if (isRemoteUrl(url) || isAssetUrl(url)) continue;

        const localPath = resolveLocalFilePath(url, assets, folderPath);
        if (!localPath) continue;

        try {
          const uploadStart = performance.now();
          const result = await provider.uploadLocalFile(localPath);
          const uploadMs = Math.round(performance.now() - uploadStart);
          setContentUrl(item, result.presignedUrl);
          taskLog.info(folderPath, 'tos_upload_result', 'TOS upload complete', {
            taskId,
            index: i,
            presignedUrl: result.presignedUrl,
            durationMs: uploadMs,
          });
        } catch (err) {
          taskLog.error(folderPath, 'tos_upload_error', `TOS upload failed for index ${i}`, {
            taskId,
            index: i,
            error: String(err),
          });
          const typeLabel = item.type === 'video_url' ? t('common.video')
            : item.type === 'audio_url' ? t('common.audio')
            : t('common.image');
          const errorMsg = t('generation.task.uploadFailed', { type: typeLabel });
          await failGeneration(taskId, errorMsg, folderPath);
          resetFragmentIfGenerating(fragmentId, 'draft');
          return taskId;
        }
      }
    }
  } else {
    for (const item of content) {
      if (item.type === 'video_url') {
        const url = item.video_url?.url ?? '';
        if (!isRemoteUrl(url)) {
          const errorMsg = t('generation.task.videoReferenceNeedsStorage');
          await failGeneration(taskId, errorMsg, folderPath);
          resetFragmentIfGenerating(fragmentId, 'draft');
          return taskId;
        }
      }
    }
  }

  const localReferences: Array<{ content_index: number; file_path: string }> = [];
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (item.type === 'image_url' || item.type === 'video_url' || item.type === 'audio_url') {
      const url = getContentUrl(item);
      if (url && !isRemoteUrl(url) && !isAssetUrl(url)) {
        localReferences.push({ content_index: i, file_path: url });
      }
    }
  }

  const inst = useProviderInstanceStore.getState().get(instanceId);
  const password = getProviderPassword(inst);

  try {
    const submitStart = performance.now();
    await tauriBridge.seedanceApi.startGeneration({
      task_id: taskId,
      provider_id: instanceId,
      password,
      model: arkModelId,
      content,
      resolution: params.resolution || '720p',
      ratio: params.aspectRatio || 'adaptive',
      duration: params.duration ?? 5,
      generate_audio: params.generateAudio ?? true,
      return_last_frame: options?.returnLastFrame,
      local_references: localReferences,
      project_path: folderPath,
      fragment_id: fragmentId,
      extra_params: {
        generate_watermark: params.generateWatermark,
      },
    });
    const submitMs = Math.round(performance.now() - submitStart);

    await updateGenerationsXml(folderPath, taskId, {
      status: 'processing',
      startedAt: new Date().toISOString(),
    });
    useGenerationStore.getState().updateGeneration(taskId, { status: 'processing', startedAt: new Date() });

    taskLog.info(folderPath, 'submit_success', 'Generation task submitted to Rust', {
      taskId,
      durationMs: submitMs,
    });
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    taskLog.error(folderPath, 'submit_error', 'Failed to start generation', {
      taskId,
      error: errorMsg,
    });
    await failGeneration(taskId, errorMsg, folderPath);
    resetFragmentIfGenerating(fragmentId, 'draft');
  }

  return taskId;
}

async function buildContentItems(params: GenerationParams): Promise<SeedanceContentItem[]> {
  const items: SeedanceContentItem[] = [];

  if (params.prompt?.trim()) {
    items.push({ type: 'text', text: params.prompt });
  }

  if (params.negativePrompt?.trim()) {
    items.push({ type: 'text', text: `Avoid: ${params.negativePrompt}` });
  }

  // Sort references by type group (image → video → audio) to match prompt numbering
  const typeOrder: Record<string, number> = { image: 0, video: 1, audio: 2 };
  const sortedRefs = [...params.references].sort((a, b) => {
    const orderDiff = (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
    if (orderDiff !== 0) return orderDiff;
    // Preserve original order within same type
    return params.references.indexOf(a) - params.references.indexOf(b);
  });

  const assets = useAssetStore.getState().assets;

  for (let i = 0; i < sortedRefs.length; i++) {
    const ref = sortedRefs[i];
    const asset = assets.find((a) => a.id === ref.assetId);
    const hasRemoteAsset = asset?.remoteAssetId && asset?.remoteAssetStatus === 'Active';

    const url = hasRemoteAsset ? `asset://${asset.remoteAssetId}` : ref.assetId;

    const role = refTypeToRole(ref.type, ref.role);
    const item: SeedanceContentItem = {
      type: ref.type === 'video' ? 'video_url' : ref.type === 'audio' ? 'audio_url' : 'image_url',
      role,
    };
    if (item.type === 'video_url') item.video_url = { url };
    else if (item.type === 'audio_url') item.audio_url = { url };
    else item.image_url = { url };
    items.push(item);
  }

  return items;
}

function resolveArkModelId(instanceId: string, modelId: string): string {
  const instance = useProviderInstanceStore.getState().get(instanceId);
  if (instance?.config) {
    const perModelOverride = instance.config[`model:${modelId}:ark_model_id`];
    if (typeof perModelOverride === 'string') return perModelOverride;
  }
  const modelDef = seedanceTypeDefinition.modelFamilies
    .flatMap((f) => f.models)
    .find((m) => m.modelId === modelId);
  if (modelDef?.metadata?.arkModelId) return modelDef.metadata.arkModelId;
  return 'doubao-seedance-2-0-260128';
}

function resolveModelName(_instanceId: string, modelId: string): string | undefined {
  return providerTypeRegistry.findModelVariant(modelId)?.name;
}
