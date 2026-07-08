/**
 * Service interfaces for decoupling UI from the generation package.
 *
 * UI layer depends on these interfaces (via core), while the generation
 * package registers concrete implementations at startup.
 */

import type { ProviderTypeDefinition, ProviderType, ProviderInstance, InputRequirements, ModelVariant } from './provider-system';
import type { GenerationParams } from './generation';
import type { AssetProvider } from './asset-provider';

// ── Provider Type Registry ──

export interface IProviderTypeRegistry {
  get(typeId: string): ProviderTypeDefinition | undefined;
  getAll(): ProviderTypeDefinition[];
  getByType(providerType: ProviderType): ProviderTypeDefinition[];
  has(typeId: string): boolean;
  findModelVariant(modelId: string): ModelVariant | undefined;
}

// ── Provider Runtime Registry ──

export interface IProviderRuntimeRegistry {
  initializeInstance(instance: ProviderInstance): Promise<void>;
  getOrInitializeAssetProvider(instanceId: string): Promise<AssetProvider | undefined>;
  reinitializeInstance(instanceId: string): Promise<void>;
  dispose(instanceId: string): void;
  fetchVoices(instanceId: string): Promise<Array<{ value: string; label: string }>>;
}

// ── Generation Service ──

export interface SubmitGenerationOptions {
  firstFrameUrl?: string;
  returnLastFrame?: boolean;
  continuousMode?: boolean;
  continuousPlan?: number[];
  currentSegmentIndex?: number;
  continuousGroupId?: string;
  inputRequirements?: InputRequirements;
}

export interface IGenerationService {
  submitTask(
    fragmentId: string,
    instanceId: string,
    modelId: string,
    params: GenerationParams,
    options?: SubmitGenerationOptions,
  ): Promise<string>;
  refreshActiveGenerations(): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  restoreProjectGenerations(projectId: string): Promise<void>;
}
