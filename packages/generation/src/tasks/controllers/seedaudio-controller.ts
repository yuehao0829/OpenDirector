/**
 * SeedAudio TTS TaskController.
 *
 * Event-driven (like MiniMax): the Rust side runs a single-shot POST
 * /api/v3/tts/create and emits `generation:status` events (created → completed).
 * There is no JS-side polling — SeedAudio has no queryable task endpoint, so
 * this controller implements only the required start/cancel/resume surface and
 * omits all optional polling methods (batchQuery / getTaskStatus /
 * downloadResult / refreshActive). Recovery of stale SeedAudio tasks without a
 * pending file marks them failed (handled in task-recovery.ts via the absence of
 * batchQuery).
 *
 * References (optional voice-cloning inputs): audio AND image refs upload to
 * TOS (`audio_url` / `image_url`) when an asset provider is configured; when
 * no provider is set (or init fails) they fall back to base64 inline
 * (`audio_data` / `image_data`). The API treats speaker / audio / image as
 * mutually exclusive cloning sources; the controller honours a fixed priority
 * — 多条音频 > 1 图片 > speaker (voiceId) — taking up to 3 audio clips
 * (referenced positionally as @音频1 / @音频2 / @音频3, preserving the user's
 * order) or a single image / speaker. Pure text with no reference and no
 * voiceId yields an empty array.
 */

import { getPlatformAdapter } from '@opendirector/core/adapters';
import { autoProcessReferences } from '@opendirector/core/services/reference-auto-processor';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { SeedAudioReferenceInput } from '@opendirector/core/types/ai-video';
import type { Reference } from '@opendirector/core/types/asset';
import type { AssetProvider } from '@opendirector/core/types/asset-provider';
import type { Generation, GenerationParams } from '@opendirector/core/types/generation';
import type { InputRequirements } from '@opendirector/core/types/provider-system';
import { t } from '@opendirector/core/i18n';
import { getErrorMessage } from '@opendirector/core/utils/common';
import { generateId } from '@opendirector/core/utils/id';
import { providerRuntimeRegistry, resolveDefaultAssetProvider } from '../../providers/runtime-registry';
import { providerTypeRegistry } from '../../providers/type-registry';
import type { TaskController, TaskControllerStartInput } from '../task-controller-registry';
import {
  updateGenerationsXml,
  resolveFragmentContext,
  buildProviderParams,
  getProviderPassword,
  resolveLocalFilePath,
} from '../generation-xml-repository';
import { resetFragmentIfGenerating } from '../fragment-utils';
import { failGeneration } from '../store-sync';
import { taskLog } from '../task-log';

export const seedaudioController: TaskController = {
  start: submitSeedAudioTtsTask,

  cancel(taskId) {
    return tauriBridge.seedaudioTtsApi.cancelGeneration(taskId);
  },

  resume(taskId, password) {
    return tauriBridge.seedaudioTtsApi.resumeGeneration(taskId, password);
  },

  // No batchQuery / getTaskStatus / downloadResult / refreshActive —
  // SeedAudio is event-driven via a single Rust HTTP request that emits
  // `generation:status` events directly.
};

/**
 * Submit a SeedAudio TTS task (event-driven path).
 *
 * Like MiniMax, completion is driven by the Rust task emitting `generation:status`
 * events (created → completed), processed by `bridge.ts` + `handleTaskComplete`
 * (outputType: 'audio'). Unlike MiniMax, SeedAudio supports optional reference
 * audio / image (recorded in the Generation + XML) for voice cloning. Audio +
 * image refs upload to TOS (`audio_url` / `image_url`) when a provider is
 * configured, else base64 inline (`audio_data` / `image_data`).
 */
async function submitSeedAudioTtsTask(input: TaskControllerStartInput): Promise<string> {
  const { fragmentId, instanceId, modelId, params, options, instance } = input;
  const taskId = generateId();
  useTimelineStore.getState().updateFragment(fragmentId, { status: 'generating' });

  const ctx = resolveFragmentContext(fragmentId);
  const providerInstance = instance ?? useProviderInstanceStore.getState().get(instanceId);
  const providerLabel = providerInstance?.displayName ?? instanceId;
  const variant = providerTypeRegistry.findModelVariant(modelId);
  const modelName = variant?.name;
  const project = useProjectStore.getState().currentProject;
  const folderPath = project?.folderPath;

  if (!folderPath) {
    await failGeneration(taskId, 'No project folder path');
    resetFragmentIfGenerating(fragmentId, 'draft');
    return taskId;
  }

  const normalized = normalizeSeedAudioTtsParams(params);
  const providerParams = buildProviderParams(modelId, normalized, modelName);

  // Record the user's actual references (assetId / type / role) for display +
  // restore, mirroring Seedance (MiniMax passes [] because it has no refs).
  const generationReferences = params.references.map((r) => ({
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
    references: generationReferences,
    providerInstanceId: instanceId,
    providerDisplayName: providerLabel,
    providerParams,
    outputType: 'audio',
    status: 'pending',
    queuedAt: new Date(),
    isSelected: false,
    createdAt: new Date(),
  };
  useGenerationStore.getState().addGeneration(pendingGeneration);

  taskLog.info(folderPath, 'submit_pending', 'SeedAudio TTS task submitted', {
    taskId,
    fragmentId,
    providerId: instanceId,
    model: modelId,
  });

  await updateGenerationsXml(folderPath, taskId, {
    status: 'pending',
    fragmentId,
    fragmentName: ctx.fragmentName,
    prompt: params.prompt,
    references: generationReferences,
    providerInstanceId: instanceId,
    providerDisplayName: providerLabel,
    providerParams,
    outputType: 'audio',
    isSelected: false,
    createdAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  });

  // Build the API references, mirroring Seedance's reference pipeline:
  // 1. Auto-process (compress/transcode) over-limit references when the model
  //    declares referenceAssetConstraints.
  // 2. Resolve a local file path per reference (priority: audios > image >
  //    speaker; up to 3 audio clips, preserving @音频N order).
  // 3. Upload each local file to TOS when an asset provider is configured
  //    (→ audio_url / image_url passthrough); otherwise fall back to local file
  //    paths that Rust base64-encodes inline (audio_file_path / image_file_path).
  // A reference that can't resolve to a local path, or a failed TOS upload, is a
  // hard error — silently falling through to voiceId would clone the wrong voice.
  let references: SeedAudioReferenceInput[];
  try {
    references = await buildSeedAudioReferences(normalized, folderPath, options?.inputRequirements);
  } catch (refError) {
    const errorMsg = getErrorMessage(refError);
    taskLog.error(folderPath, 'submit_reference_error', 'Failed to resolve SeedAudio references', {
      taskId,
      error: errorMsg,
    });
    await failGeneration(taskId, errorMsg, folderPath);
    resetFragmentIfGenerating(fragmentId, 'draft');
    return taskId;
  }

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

    await tauriBridge.seedaudioTtsApi.startGeneration({
      task_id: taskId,
      provider_id: instanceId,
      password,
      project_path: folderPath,
      fragment_id: fragmentId,
      model: modelId,
      text_prompt: params.prompt,
      references,
      audio_format: normalized.audioFormat,
      sample_rate: normalized.sampleRate ? Number(normalized.sampleRate) : undefined,
      speech_rate: normalized.speed,
      loudness_rate: normalized.volume,
      pitch_rate: normalized.pitch != null ? Math.round(Number(normalized.pitch)) : undefined,
    });

    taskLog.info(folderPath, 'submit_success', 'SeedAudio TTS task submitted to Rust', { taskId });
    // Completion is driven by Rust events (generation:status).
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    taskLog.error(folderPath, 'submit_error', 'Failed to start SeedAudio TTS', {
      taskId,
      error: errorMsg,
    });
    await failGeneration(taskId, errorMsg, folderPath);
    resetFragmentIfGenerating(fragmentId, 'draft');
  }

  return taskId;
}

/** A resolved reference plan entry before TOS / base64 conversion. */
type SeedAudioReferencePlanEntry =
  | { kind: 'audio'; localPath: string }
  | { kind: 'image'; localPath: string }
  | { kind: 'speaker'; voiceId: string };

/**
 * Build the SeedAudio API references array.
 *
 * Audio AND image references upload to TOS (`audio_url` / `image_url`) when an
 * asset provider is configured — both are documented `string` reference fields
 * (a presigned URL the server fetches). When no asset provider is configured
 * (or its init throws), refs fall back to base64 inline (`audio_data` /
 * `image_data` via `audio_file_path` / `image_file_path`).
 *
 * The API requires speaker / audio / image to be mutually exclusive (and images
 * cannot mix with audio — enforced upstream by the `forbid_image_audio_mix`
 * crossConstraint). The controller honours a fixed priority — 多条音频 > 1 图片 >
 * speaker (voiceId) — taking up to 3 audio clips in the user's order (so
 * `@音频1` / `@音频2` / `@音频3` map to entries 1/2/3). Pure text with no
 * reference and no voiceId yields an empty array, which Rust omits from the
 * request body (matching the API's "no references = default-voice text" semantic).
 *
 * Throws when a selected reference cannot resolve to a local path (a hard error
 * — silently falling through to voiceId would clone the wrong voice), or when a
 * TOS upload fails (aborting the task — image refs only).
 */
async function buildSeedAudioReferences(
  params: GenerationParams,
  folderPath: string,
  inputRequirements: InputRequirements | undefined,
): Promise<SeedAudioReferenceInput[]> {
  // 1. Auto-process over-limit references (compress / transcode) when the model
  //    declares referenceAssetConstraints. Best-effort: on failure, continue
  //    with the original references (mirrors Seedance).
  let assets = useAssetStore.getState().assets;
  let assetIdMap = new Map<string, string>();

  if (inputRequirements) {
    try {
      const platform = await getPlatformAdapter();
      const fs = platform.fs;
      if (fs) {
        const autoResult = await autoProcessReferences({
          references: params.references,
          getAsset: (assetId) => assets.find((a) => a.id === assetId),
          requirements: inputRequirements,
          projectPath: folderPath,
          fs,
        });

        // Register new (processed) assets and refresh the snapshot so local
        // path resolution + TOS upload use the compressed/transcoded files.
        for (const newAsset of autoResult.newAssets) {
          useAssetStore.getState().addAsset(newAsset);
        }
        assetIdMap = autoResult.assetIdMap;
        assets = useAssetStore.getState().assets;
      }
    } catch (err) {
      taskLog.warn(folderPath, 'auto_process_error', 'Auto-process references failed', {
        error: String(err),
      });
      // Continue with original references — best-effort.
    }
  }

  // 2. Resolve the reference plan (up to 3 audio / 1 image / 1 speaker).
  const plan = buildSeedAudioReferencePlan(params, folderPath, assets, assetIdMap);

  // 3. Convert the plan to API inputs. Audio AND image refs upload to TOS
  //    (→ audio_url / image_url) when an asset provider is configured — the
  //    SeedAudio API documents `audio_url` / `image_url` as legal `string`
  //    reference fields (a presigned URL the server fetches). When no asset
  //    provider is configured (or its init throws), refs fall back to base64
  //    inline (audio_file_path / image_file_path → audio_data / image_data).
  //    `@音频N` is a supported citation (official docs); reference order /
  //    format / size are constrained upstream by the type definition.
  //
  //    A thrown TOS init (bad credentials, module load error, unknown typeId)
  //    degrades to the base64 fallback rather than hard-failing the task — the
  //    Rust base64 path fully supports inline references. TOS is initialized
  //    when any file-bearing reference is present (audio OR image).
  const hasFileRef = plan.some((e) => e.kind === 'audio' || e.kind === 'image');
  const assetProvider = resolveDefaultAssetProvider();
  // `tosProvider` stays `undefined` when no asset provider is configured or its
  // init throws — the per-reference base64 inline fallback handles that case.
  let tosProvider: AssetProvider | undefined;
  if (assetProvider && hasFileRef) {
    try {
      tosProvider = await providerRuntimeRegistry.getOrInitializeAssetProvider(assetProvider.instanceId);
    } catch (err) {
      taskLog.warn(folderPath, 'tos_init_error', 'TOS asset provider init failed; falling back to base64 inline', {
        error: String(err),
      });
    }
  }

  // Resolve each plan entry. Audio / image refs upload to TOS (→ audio_url /
  // image_url) when a provider is configured, else base64 inline
  // (audio_file_path / image_file_path). A TOS upload failure is a hard error —
  // silently dropping the ref would clone the wrong voice. Plan order is
  // preserved, so @音频N still maps to references[N-1]. (TOS uploads are
  // content-addressed; objects orphaned by a failed task are reclaimed by the
  // TOS lifecycle policy.)
  const settled = await Promise.allSettled(
    plan.map(async (entry): Promise<SeedAudioReferenceInput> => {
      if (entry.kind === 'speaker') {
        return { speaker: entry.voiceId };
      }
      const isAudio = entry.kind === 'audio';
      if (tosProvider) {
        const uploadStart = performance.now();
        try {
          const result = await tosProvider.uploadLocalFile(entry.localPath);
          const url = result.presignedUrl;
          // An empty/missing presignedUrl is silently dropped by Rust
          // (resolve_seedaudio_references skips empty url fields), which would
          // shrink the references array and clone the wrong voice — treat as a
          // hard upload failure.
          if (!url) {
            throw new Error('TOS upload returned an empty presigned URL');
          }
          const uploadMs = Math.round(performance.now() - uploadStart);
          taskLog.info(folderPath, 'tos_upload_result', 'TOS upload complete', {
            uploadMs,
            presignedUrl: url,
          });
          return isAudio ? { audio_url: url } : { image_url: url };
        } catch (err) {
          taskLog.error(folderPath, 'tos_upload_error', 'TOS upload failed', {
            error: String(err),
          });
          const typeLabel = isAudio ? t('common.audio') : t('common.image');
          throw new Error(t('generation.task.uploadFailed', { type: typeLabel }));
        }
      }
      // No asset provider (or init failed) → base64 inline fallback.
      return isAudio
        ? { audio_file_path: entry.localPath }
        : { image_file_path: entry.localPath };
    }),
  );

  const references: SeedAudioReferenceInput[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      references.push(result.value);
    } else {
      // First rejection fails the task; all uploads have settled, so no in-flight
      // upload is orphaned mid-rejection.
      throw result.reason as Error;
    }
  }
  return references;
}

/**
 * Resolve the reference plan: up to 3 audio clips (preserving the user's
 * `@音频N` order), else a single image, else the speaker voiceId. Each audio /
 * image entry resolves to a local file path (remapping through the auto-process
 * assetIdMap so the compressed/transcoded file is used). Throws when a selected
 * reference cannot resolve to a local path.
 */
function buildSeedAudioReferencePlan(
  params: GenerationParams,
  folderPath: string,
  assets: Array<{ id: string; sourcePath?: string; relativePath?: string }>,
  assetIdMap: Map<string, string>,
): SeedAudioReferencePlanEntry[] {
  // Defense-in-depth: the API treats image and audio cloning sources as mutually
  // exclusive. The UI blocks mixing via the `forbid_image_audio_mix`
  // crossConstraint, but a caller that bypasses the UI gate (programmatic /
  // retry path) must not silently drop the image and clone from audio — surface
  // a hard error so the wrong-voice failure can't pass silently.
  const hasAudio = params.references.some((r) => r.type === 'audio');
  const hasImage = params.references.some((r) => r.type === 'image');
  if (hasAudio && hasImage) {
    throw new Error(t('generation.validation.imageAudioMixForbidden'));
  }
  const audioRefs = params.references.filter((r) => r.type === 'audio').slice(0, 3);
  if (audioRefs.length > 0) {
    return audioRefs.map((r) => resolveFileRef(r, 'audio', assets, assetIdMap, folderPath));
  }

  const imageRef = params.references.find((r) => r.type === 'image');
  if (imageRef) {
    return [resolveFileRef(imageRef, 'image', assets, assetIdMap, folderPath)];
  }

  if (params.voiceId) {
    return [{ kind: 'speaker', voiceId: params.voiceId }];
  }

  return [];
}

/**
 * Resolve a single file-bearing reference to a local path, remapping through the
 * auto-process assetIdMap so the compressed/transcoded file is used. Throws on a
 * missing asset or unresolvable path — silently falling through would clone the
 * wrong voice.
 */
function resolveFileRef(
  ref: Reference,
  kind: 'audio' | 'image',
  assets: Array<{ id: string; sourcePath?: string; relativePath?: string }>,
  assetIdMap: Map<string, string>,
  folderPath: string,
): SeedAudioReferencePlanEntry {
  const effectiveAssetId = assetIdMap.get(ref.assetId) ?? ref.assetId;
  // Guard against a missing asset: resolveLocalFilePath would otherwise return
  // the raw assetId (a UUID, truthy) and bypass the !localPath check, surfacing
  // a misleading "must be absolute" error from Rust later.
  if (!assets.find((a) => a.id === effectiveAssetId)) {
    throw new Error(`Could not find the reference ${kind} asset. Re-add the reference ${kind} before generating.`);
  }
  const localPath = resolveLocalFilePath(effectiveAssetId, assets, folderPath);
  if (!localPath) {
    throw new Error(`Could not resolve the reference ${kind} to a local file path. Use a local ${kind} file as the reference.`);
  }
  return { kind, localPath } as SeedAudioReferencePlanEntry;
}

/**
 * Normalize generation params for SeedAudio TTS.
 * Strips video-only fields (duration / aspectRatio / resolution) — TTS has no
 * notion of these. References + voiceId + audio params are preserved.
 */
function normalizeSeedAudioTtsParams(params: GenerationParams): GenerationParams {
  return {
    ...params,
    duration: 0,
    aspectRatio: '',
    resolution: undefined,
  };
}
