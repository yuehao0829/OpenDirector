/**
 * Service locator — runtime registration and access for generation services.
 *
 * The generation package registers its concrete implementations here at startup.
 * UI code retrieves them via getXxx() so it never imports @opendirector/generation directly.
 */

import type { IProviderTypeRegistry, IProviderRuntimeRegistry, IGenerationService } from '../types/service-interfaces';

let _typeRegistry: IProviderTypeRegistry | null = null;
let _runtimeRegistry: IProviderRuntimeRegistry | null = null;
let _generationService: IGenerationService | null = null;

// ── Registration (called by generation package at init) ──

export function registerProviderTypeRegistry(registry: IProviderTypeRegistry): void {
  _typeRegistry = registry;
}

export function registerProviderRuntimeRegistry(registry: IProviderRuntimeRegistry): void {
  _runtimeRegistry = registry;
}

export function registerGenerationService(service: IGenerationService): void {
  _generationService = service;
}

// ── Access (called by UI) ──

export function getProviderTypeRegistry(): IProviderTypeRegistry {
  if (!_typeRegistry) throw new Error('ProviderTypeRegistry not registered. Call registerProviderTypeRegistry() during app initialization.');
  return _typeRegistry;
}

export function getProviderRuntimeRegistry(): IProviderRuntimeRegistry {
  if (!_runtimeRegistry) throw new Error('ProviderRuntimeRegistry not registered. Call registerProviderRuntimeRegistry() during app initialization.');
  return _runtimeRegistry;
}

export function getGenerationService(): IGenerationService {
  if (!_generationService) throw new Error('GenerationService not registered. Call registerGenerationService() during app initialization.');
  return _generationService;
}

export function resetServiceLocator(): void {
  _typeRegistry = null;
  _runtimeRegistry = null;
  _generationService = null;
}
