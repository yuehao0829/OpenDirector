export * from './types';
export * from './seedance';
export * from './volcengine-tos';
export * from './gpt-image';
export * from './minimax';
export * from './seedaudio';
export * from './type-registry';
export * from './runtime-registry';

// Register built-in provider types on import
import { providerTypeRegistry } from './type-registry';
import {
  createSeedanceTypeDefinition,
  createVolcengineTosTypeDefinition,
} from './builtin-types/seedance-type';
import { createGptImageTypeDefinition } from './builtin-types/gpt-image-type';
import { createMinimaxTypeDefinition } from './builtin-types/minimax-type';
import { createSeedAudioTypeDefinition } from './builtin-types/seedaudio-type';

export function registerBuiltinProviderTypes(): void {
  providerTypeRegistry.registerBuiltin(createSeedanceTypeDefinition());
  providerTypeRegistry.registerBuiltin(createVolcengineTosTypeDefinition());
  providerTypeRegistry.registerBuiltin(createGptImageTypeDefinition());
  providerTypeRegistry.registerBuiltin(createMinimaxTypeDefinition());
  providerTypeRegistry.registerBuiltin(createSeedAudioTypeDefinition());
}
