/**
 * MiniMax TTS TaskController.
 *
 * MiniMax TTS is event-driven: its Rust coordinator polls the MiniMax API and
 * emits `generation:status` events (created → download_progress → completed).
 * The JS side does NOT poll the MiniMax API directly, so this controller
 * implements only the required start/cancel/resume surface and omits all
 * optional polling methods (batchQuery / getTaskStatus / downloadResult /
 * refreshActive). Recovery of stale MiniMax tasks without a pending file marks
 * them failed (handled in task-recovery.ts via the absence of batchQuery).
 */

import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { Generation, GenerationParams } from '@opendirector/core/types/generation';
import { getErrorMessage } from '@opendirector/core/utils/common';
import { generateId } from '@opendirector/core/utils/id';
import { providerTypeRegistry } from '../../providers/type-registry';
import type { TaskController, TaskControllerStartInput } from '../task-controller-registry';
import {
  updateGenerationsXml,
  resolveFragmentContext,
  buildProviderParams,
  getProviderPassword,
} from '../generation-xml-repository';
import { resetFragmentIfGenerating } from '../fragment-utils';
import { failGeneration } from '../store-sync';
import { taskLog } from '../task-log';

export const minimaxController: TaskController = {
  start: submitMiniMaxTtsTask,

  cancel(taskId) {
    return tauriBridge.minimaxTtsApi.cancelGeneration(taskId);
  },

  resume(taskId, password) {
    return tauriBridge.minimaxTtsApi.resumeGeneration(taskId, password);
  },

  // No batchQuery / getTaskStatus / downloadResult / refreshActive —
  // MiniMax is event-driven via the Rust coordinator. The coordinator emits
  // `generation:status` events directly; JS-side polling is not needed.
};
/**
 * Submit a MiniMax TTS task (async path).
 *
 * Unlike Seedance, TTS has no reference content / TOS upload / local_references /
 * continuous mode. Completion is driven by the Rust coordinator emitting
 * `generation:status` events (created → download_progress → completed), which
 * `bridge.ts` + `handleTaskComplete` process (outputType: 'audio').
 */
async function submitMiniMaxTtsTask(input: TaskControllerStartInput): Promise<string> {
  const { fragmentId, instanceId, modelId, params, instance } = input;
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

  const modelParams = variant?.params;
  const normalized = normalizeMinimaxTtsParams(params, modelParams?.voiceModifyFormats);
  const providerParams = buildProviderParams(modelId, normalized, modelName);

  const pendingGeneration: Generation = {
    id: taskId,
    projectId: project.id ?? '',
    fragmentId,
    fragmentName: ctx.fragmentName,
    promptText: params.prompt,
    references: [],
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

  taskLog.info(folderPath, 'submit_pending', 'MiniMax TTS task submitted', {
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
    references: [],
    providerInstanceId: instanceId,
    providerDisplayName: providerLabel,
    providerParams,
    outputType: 'audio',
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

    await tauriBridge.minimaxTtsApi.startGeneration({
      task_id: taskId,
      provider_id: instanceId,
      password,
      project_path: folderPath,
      fragment_id: fragmentId,
      model: modelId,
      text: params.prompt,
      voice_id: normalized.voiceId ?? '',
      speed: normalized.speed,
      emotion: normalized.emotion,
      audio_format: normalized.audioFormat,
      sample_rate: normalized.sampleRate ? Number(normalized.sampleRate) : undefined,
      vol: normalized.volume,
      pitch: normalized.pitch,
      bitrate: normalized.bitrate,
      channel: normalized.channel,
      language_boost: normalized.languageBoost,
      voice_modify_pitch: normalized.voiceModifyPitch,
      voice_modify_intensity: normalized.voiceModifyIntensity,
      voice_modify_timbre: normalized.voiceModifyTimbre,
      voice_modify_sound_effects: normalized.voiceModifySoundEffects,
      pronunciation_tone: normalized.pronunciationTone,
      aigc_watermark: normalized.aigcWatermark,
      english_normalization: normalized.englishNormalization,
    });

    taskLog.info(folderPath, 'submit_success', 'MiniMax TTS task submitted to Rust', { taskId });
    // Completion is driven by Rust coordinator events (generation:status).
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    taskLog.error(folderPath, 'submit_error', 'Failed to start MiniMax TTS', {
      taskId,
      error: errorMsg,
    });
    await failGeneration(taskId, errorMsg, folderPath);
    resetFragmentIfGenerating(fragmentId, 'draft');
  }

  return taskId;
}

/**
 * Normalize generation params for MiniMax TTS.
 * Ignores video-only fields (duration / aspectRatio / resolution) — TTS has no notion of these.
 * `voiceModifyFormats` comes from the provider's CapabilityParams (single source of truth
 * for which audio formats support voice_modify).
 */
function normalizeMinimaxTtsParams(
  params: GenerationParams,
  voiceModifyFormats: string[] = ['mp3', 'wav', 'flac'],
): GenerationParams {
  const result: GenerationParams = {
    ...params,
    references: [],
    duration: 0,
    aspectRatio: '',
    resolution: undefined,
  };
  // Empty-string sound effects "none" → don't send to API
  if (result.voiceModifySoundEffects === '') {
    result.voiceModifySoundEffects = undefined;
  }
  // voice_modify only supported for formats declared by the provider — strip for others
  const fmt = result.audioFormat ?? '';
  if (!voiceModifyFormats.includes(fmt)) {
    result.voiceModifyPitch = undefined;
    result.voiceModifyIntensity = undefined;
    result.voiceModifyTimbre = undefined;
    result.voiceModifySoundEffects = undefined;
  }
  return result;
}
