import { describe, expect, it } from 'vitest';
import { buildProviderModels } from '../types';
import { seedanceTypeDefinition } from './seedance-type';

describe('seedanceTypeDefinition', () => {
  it('enables 1080p for Seedance 2.0 but keeps Seedance 2.0 Fast at 720p and below', () => {
    const models = buildProviderModels(seedanceTypeDefinition);
    const seedance20 = models.find((model) => model.id === 'seedance-2.0');
    const seedance20Fast = models.find((model) => model.id === 'seedance-2.0-fast');

    expect(seedance20?.params?.resolution).toContain('1080p');
    expect(seedance20Fast?.params?.resolution).not.toContain('1080p');
  });

  it('uses snake_case `api_key` as the storage key for the API Key password field', () => {
    // The credentials object is serialized verbatim into the Rust pure-KV
    // Credentials map, so the field key must match what the backend reads
    // (`require("api_key")`). Guard against a regression to `apiKey`.
    const apiKeyField = seedanceTypeDefinition.credentialFields?.find(
      (f) => f.type === 'password',
    );
    expect(apiKeyField?.key).toBe('api_key');
  });

  it('declares the [图片N] / [Image N] citation form via an i18n templateKey', () => {
    const req = seedanceTypeDefinition.modelFamilies[0].models[0].inputRequirements;
    expect(req?.referenceMarker?.templateKey).toBe('generation.referenceMarker.seedance.template');
    // No literal template/typeNames — the template localizes via i18n (zh no
    // space, en with space) and type names come from common.* at render time.
    expect(req?.referenceMarker?.template).toBeUndefined();
    expect(req?.referenceMarker?.typeNames).toBeUndefined();
  });
});
