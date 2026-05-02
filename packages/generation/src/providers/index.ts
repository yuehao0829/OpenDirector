export * from './types';
export * from './seedance';
export * from './volcengine-tos';
export * from './type-registry';
export * from './runtime-registry';

// Register built-in provider types on import
import { providerTypeRegistry } from './type-registry';
import { seedanceTypeDefinition, volcengineTosTypeDefinition } from './builtin-types/seedance-type';

providerTypeRegistry.registerBuiltin(seedanceTypeDefinition);
providerTypeRegistry.registerBuiltin(volcengineTosTypeDefinition);
