/**
 * Register generation package services with the core service locator.
 *
 * Call this once during app initialization (before any UI component mounts).
 */

import {
  registerProviderTypeRegistry,
  registerProviderRuntimeRegistry,
  registerGenerationService,
} from '@opendirector/core/services/service-locator';
import type {
  IProviderTypeRegistry,
  IProviderRuntimeRegistry,
  IGenerationService,
} from '@opendirector/core/types/service-interfaces';
import { i18n } from '@opendirector/core/i18n';
import { providerTypeRegistry } from './providers/type-registry';
import { providerRuntimeRegistry } from './providers/runtime-registry';
import {
  submitGenerationTask,
  refreshActiveGenerations,
  cancelGenerationTask,
  restoreProjectGenerations,
} from './tasks/bridge';
import { registerBuiltinProviderTypes } from './providers';
// Importing the controllers index auto-registers all built-in TaskControllers
// (seedance, minimax, gpt-image) at module load — mirrors the provider-type
// registration pattern. This must run before any task is submitted/cancelled/recovered.
import './tasks/controllers';

// providerTypeRegistry satisfies IProviderTypeRegistry — direct assignment
const typeRegistryAdapter: IProviderTypeRegistry = providerTypeRegistry;

// providerRuntimeRegistry methods match IProviderRuntimeRegistry — direct bind
const runtimeRegistryAdapter: IProviderRuntimeRegistry = {
  initializeInstance: providerRuntimeRegistry.initializeInstance.bind(providerRuntimeRegistry),
  getOrInitializeAssetProvider:
    providerRuntimeRegistry.getOrInitializeAssetProvider.bind(providerRuntimeRegistry),
  reinitializeInstance: providerRuntimeRegistry.reinitializeInstance.bind(providerRuntimeRegistry),
  dispose: providerRuntimeRegistry.dispose.bind(providerRuntimeRegistry),
  fetchVoices: (instanceId) => providerRuntimeRegistry.fetchVoices(instanceId),
};

const generationServiceAdapter: IGenerationService = {
  submitTask: submitGenerationTask,
  refreshActiveGenerations,
  cancelTask: cancelGenerationTask,
  restoreProjectGenerations,
};

export function registerGenerationServices(): void {
  registerBuiltinProviderTypes();
  registerProviderTypeRegistry(typeRegistryAdapter);
  registerProviderRuntimeRegistry(runtimeRegistryAdapter);
  registerGenerationService(generationServiceAdapter);
}

i18n.on('languageChanged', () => {
  registerBuiltinProviderTypes();
});
