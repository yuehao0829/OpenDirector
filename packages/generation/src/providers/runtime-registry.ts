/**
 * ProviderRuntimeRegistry — runtime layer.
 *
 * Maps instanceId → GenerationProvider | AssetProvider.
 * Providers are initialized from instance configs + type definitions.
 * Only built-in types are supported.
 */

import type { AssetProvider } from '@opendirector/core/types/asset-provider';
import type {
  ProviderInstance,
  ProviderTypeDefinition,
} from '@opendirector/core/types/provider-system';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import type { GenerationProvider } from './types';
import { providerTypeRegistry } from './type-registry';

class ProviderRuntimeRegistry {
  private generationProviders = new Map<string, GenerationProvider>();
  private assetProviders = new Map<string, AssetProvider>();

  /**
   * Initialize a provider instance at runtime.
   * Built-in types use their known constructors; custom types get protocol adapters.
   */
  async initializeInstance(
    instance: ProviderInstance,
  ): Promise<void> {
    const typeDef = providerTypeRegistry.get(instance.typeId);
    if (!typeDef) {
      throw new Error(`Unknown provider type: ${instance.typeId}`);
    }

    if (typeDef.providerType === 'generation') {
      const provider = await this.buildGenerationProvider(instance, typeDef);
      this.generationProviders.set(instance.instanceId, provider);
    } else if (typeDef.providerType === 'asset') {
      const provider = await this.buildAssetProvider(instance, typeDef);
      this.assetProviders.set(instance.instanceId, provider);
    }
  }

  /**
   * Get a generation provider, lazily initializing if not yet loaded.
   * Reads instance config from providerInstanceStore.
   */
  async getOrInitializeGenerationProvider(instanceId: string): Promise<GenerationProvider | undefined> {
    const provider = this.generationProviders.get(instanceId);
    if (provider) return provider;

    const instance = useProviderInstanceStore.getState().get(instanceId);
    if (!instance) return undefined;

    await this.initializeInstance(instance);
    return this.generationProviders.get(instanceId);
  }

  /**
   * Get an asset provider, lazily initializing if not yet loaded.
   */
  async getOrInitializeAssetProvider(instanceId: string): Promise<AssetProvider | undefined> {
    const provider = this.assetProviders.get(instanceId);
    if (provider) return provider;

    const instance = useProviderInstanceStore.getState().get(instanceId);
    if (!instance) return undefined;

    await this.initializeInstance(instance);
    return this.assetProviders.get(instanceId);
  }

  /**
   * Fetch voice options for a generation provider instance.
   * Returns [] for non-voice providers (Seedance/GPT-Image) and unknown /
   * uninitialized instances.
   */
  async fetchVoices(instanceId: string): Promise<Array<{ value: string; label: string }>> {
    const provider = await this.getOrInitializeGenerationProvider(instanceId);
    return provider?.fetchVoices?.() ?? [];
  }

  private async buildGenerationProvider(
    instance: ProviderInstance,
    typeDef: ProviderTypeDefinition,
  ): Promise<GenerationProvider> {
    if (typeDef.builtIn) {
      switch (typeDef.typeId) {
        case 'seedance': {
          const { SeedanceProvider } = await import('./seedance');
          return new SeedanceProvider(instance.instanceId);
        }
        case BUILTIN_TYPE_IDS.OPENAI_IMAGE: {
          const { GptImageProvider } = await import('./gpt-image');
          return new GptImageProvider(instance.instanceId);
        }
        case BUILTIN_TYPE_IDS.MINIMAX: {
          const { MiniMaxProvider } = await import('./minimax');
          return new MiniMaxProvider(instance.instanceId);
        }
        case BUILTIN_TYPE_IDS.SEEDAUDIO: {
          const { SeedAudioProvider } = await import('./seedaudio');
          return new SeedAudioProvider(instance.instanceId);
        }
        default:
          throw new Error(`No constructor for built-in provider: ${typeDef.typeId}`);
      }
    }

    throw new Error(`Non-built-in provider types are not supported: ${typeDef.typeId}`);
  }

  private async buildAssetProvider(
    instance: ProviderInstance,
    typeDef: ProviderTypeDefinition,
  ): Promise<AssetProvider> {
    if (typeDef.builtIn) {
      switch (typeDef.typeId) {
        case BUILTIN_TYPE_IDS.VOLCENGINE: {
          const { VolcengineTosAssetProvider } = await import('./volcengine-tos');
          const provider = new VolcengineTosAssetProvider(instance.instanceId);
          // Pass encryption password from instance config (used to decrypt .enc file)
          const config = instance.config as Record<string, string>;
          const encPassword = config?._encPassword;
          if (encPassword) provider.setPassword(encPassword);
          return provider;
        }
        default:
          throw new Error(`No constructor for built-in asset provider: ${typeDef.typeId}`);
      }
    }

    throw new Error(`Custom asset providers are not yet supported.`);
  }

  getGenerationProvider(instanceId: string): GenerationProvider | undefined {
    return this.generationProviders.get(instanceId);
  }

  getAssetProvider(instanceId: string): AssetProvider | undefined {
    return this.assetProviders.get(instanceId);
  }

  has(instanceId: string): boolean {
    return this.generationProviders.has(instanceId) || this.assetProviders.has(instanceId);
  }

  /**
   * Reinitialize a provider instance (e.g. after credentials are updated).
   * Disposes the old instance and creates a fresh one.
   */
  async reinitializeInstance(instanceId: string): Promise<void> {
    this.dispose(instanceId);
    const instance = useProviderInstanceStore.getState().get(instanceId);
    if (instance) {
      await this.initializeInstance(instance);
    }
  }

  dispose(instanceId: string): void {
    this.generationProviders.delete(instanceId);
    this.assetProviders.delete(instanceId);
  }

  disposeAll(): void {
    this.generationProviders.clear();
    this.assetProviders.clear();
  }
}

export const providerRuntimeRegistry = new ProviderRuntimeRegistry();

/**
 * Resolve the default asset provider instance using the type registry.
 * Checks: 1) stored default (if valid), 2) auto-select if only one enabled asset instance.
 */
export function resolveDefaultAssetProvider(): ProviderInstance | undefined {
  const store = useProviderInstanceStore.getState();
  const defaultInst = store.getDefaultAssetProvider();
  if (defaultInst) return defaultInst;

  // Auto-select if only one enabled asset-type instance exists
  const assetTypeIds = new Set(
    providerTypeRegistry.getByType('asset').map((d) => d.typeId),
  );
  const enabled = store.instances.filter((i) => i.enabled && assetTypeIds.has(i.typeId));
  if (enabled.length === 1) return enabled[0];

  return undefined;
}
