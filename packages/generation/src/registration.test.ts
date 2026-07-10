import { afterEach, describe, expect, it } from 'vitest';
import { getProviderTypeRegistry, resetServiceLocator } from '@opendirector/core/services/service-locator';
import { registerGenerationServices } from './registration';
import { getTaskController } from './tasks/task-controller-registry';

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

  // Guards against the silent mis-dispatch class: a generation provider type
  // with no registered TaskController would fall through submitGenerationTask's
  // dispatch and route into the wrong provider's submit path. Every generation
  // type must have a controller so dispatch is fully registry-driven.
  it('registers a TaskController for every generation provider type (no silent mis-dispatch)', () => {
    registerGenerationServices();

    const typeRegistry = getProviderTypeRegistry();
    const generationTypes = typeRegistry
      .getAll()
      .filter((type) => type.providerType === 'generation');

    expect(generationTypes.length).toBeGreaterThan(0);
    for (const type of generationTypes) {
      expect(
        getTaskController(type.typeId),
        `generation type "${type.typeId}" has no registered TaskController — submitGenerationTask would mis-dispatch it`,
      ).toBeDefined();
    }
  });
});
