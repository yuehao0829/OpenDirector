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
import type { TaskController } from '../task-controller-registry';
import { submitMiniMaxTtsTask } from '../task-submitter';

export const minimaxController: TaskController = {
  start(input) {
    return submitMiniMaxTtsTask(
      input.fragmentId,
      input.instanceId,
      input.modelId,
      input.params,
      input.instance,
    );
  },

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
