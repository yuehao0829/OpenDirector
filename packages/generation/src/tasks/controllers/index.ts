/**
 * Register all built-in TaskControllers at module load.
 *
 * Imported by `registration.ts` during app init so the registry is populated
 * before any generation task is submitted / cancelled / recovered.
 */

import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import { registerTaskController } from '../task-controller-registry';
import { seedanceController } from './seedance-controller';
import { minimaxController } from './minimax-controller';
import { gptImageController } from './gpt-image-controller';

export function registerBuiltinTaskControllers(): void {
  registerTaskController(BUILTIN_TYPE_IDS.SEEDANCE, seedanceController);
  registerTaskController(BUILTIN_TYPE_IDS.MINIMAX, minimaxController);
  registerTaskController(BUILTIN_TYPE_IDS.OPENAI_IMAGE, gptImageController);
}

// Auto-register on import so the controllers are available as soon as this
// module is loaded (mirrors the provider-type registration pattern in
// providers/index.ts).
registerBuiltinTaskControllers();
