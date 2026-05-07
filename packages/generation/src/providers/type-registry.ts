/**
 * ProviderTypeRegistry — blueprint layer.
 *
 * Maps typeId → ProviderTypeDefinition. Built-in types are registered
 * at startup.
 */

import type {
  ProviderTypeDefinition,
  ProviderType,
  ModelVariant,
} from '@opendirector/core/types/provider-system';

class ProviderTypeRegistry {
  private types = new Map<string, ProviderTypeDefinition>();

  registerBuiltin(definition: ProviderTypeDefinition): void {
    this.types.set(definition.typeId, definition);
  }

  get(typeId: string): ProviderTypeDefinition | undefined {
    return this.types.get(typeId);
  }

  getAll(): ProviderTypeDefinition[] {
    return Array.from(this.types.values());
  }

  getByType(providerType: ProviderType): ProviderTypeDefinition[] {
    return this.getAll().filter((d) => d.providerType === providerType);
  }

  has(typeId: string): boolean {
    return this.types.has(typeId);
  }

  /** Find a ModelVariant by modelId across all registered type definitions. */
  findModelVariant(modelId: string): ModelVariant | undefined {
    for (const typeDef of this.types.values()) {
      for (const family of typeDef.modelFamilies) {
        const found = family.models.find((m) => m.modelId === modelId);
        if (found) return found;
      }
    }
    return undefined;
  }
}

export const providerTypeRegistry = new ProviderTypeRegistry();
