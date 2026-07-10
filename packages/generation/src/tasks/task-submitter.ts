/**
 * Task Submitter — dispatch entry point for generation tasks.
 *
 * Dispatches to the per-provider TaskController registered for the instance's
 * typeId (see tasks/controllers). The provider-specific submit logic
 * (submitSeedanceTask / submitGptImageTask / submitMiniMaxTtsTask) and its
 * helpers now live in each provider's controller module; this file no longer
 * imports any provider-specific types or helpers — it is a thin,
 * typeId-agnostic dispatch shim that fails loudly for any unregistered type
 * (no silent seedance fallback).
 */

import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import type { GenerationParams } from '@opendirector/core/types/generation';
import type { SubmitGenerationOptions } from '@opendirector/core/types/service-interfaces';
import { generateId } from '@opendirector/core/utils/id';
import { resetFragmentIfGenerating } from './fragment-utils';
import { failGeneration } from './store-sync';
import { taskLog } from './task-log';
import { getTaskController } from './task-controller-registry';

export async function submitGenerationTask(
  fragmentId: string,
  instanceId: string,
  modelId: string,
  params: GenerationParams,
  options?: SubmitGenerationOptions,
): Promise<string> {
  const instance = useProviderInstanceStore.getState().get(instanceId);
  const typeId = instance?.typeId;

  // Dispatch via the TaskController registry — there is NO silent seedance
  // fallback. A typeId with no registered controller (a missing instance, an
  // unknown type, or a provider that wired its type but forgot its controller)
  // fails loudly instead of mis-routing into the seedance submit path.
  const controller = typeId ? getTaskController(typeId) : undefined;
  if (!controller) {
    taskLog.warn(undefined, 'submit_unregistered_type', 'No TaskController registered for provider type', {
      typeId,
      instanceId,
    });
    const taskId = generateId();
    useTimelineStore.getState().updateFragment(fragmentId, { status: 'generating' });
    await failGeneration(taskId, `Unsupported provider type: ${typeId ?? '(none)'}`);
    resetFragmentIfGenerating(fragmentId, 'draft');
    return taskId;
  }

  return controller.start({ fragmentId, instanceId, modelId, params, options, instance });
}
