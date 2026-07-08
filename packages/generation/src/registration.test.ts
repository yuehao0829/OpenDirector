import { afterEach, describe, expect, it } from 'vitest';
import { getProviderTypeRegistry, resetServiceLocator } from '@opendirector/core/services/service-locator';
import { registerGenerationServices } from './registration';

describe('registerGenerationServices', () => {
  afterEach(() => {
    resetServiceLocator();
  });

  it('registers built-in provider types before exposing the type registry', () => {
    registerGenerationServices();

    const typeRegistry = getProviderTypeRegistry();
    const typeIds = typeRegistry.getAll().map((type) => type.typeId);

    expect(typeIds).toContain('seedance');
    expect(typeIds).toContain('volcengine');
    expect(typeIds).toContain('openai-image');
    expect(typeIds).toContain('minimax');
  });
});
