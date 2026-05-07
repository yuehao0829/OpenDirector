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
});
