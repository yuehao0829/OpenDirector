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

import type { TaskController } from '../task-controller-registry';
import { submitGptImageTask } from '../task-submitter';

export const gptImageController: TaskController = {
  start(input) {
    return submitGptImageTask(
      input.fragmentId,
      input.instanceId,
      input.modelId,
      input.params,
      input.options,
      input.instance,
    );
  },

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
