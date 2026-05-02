import type { GenerationParams } from '@opendirector/core/types/generation';
import type {
  SeedanceContentRole,
} from '@opendirector/core/types/ai-video';
import type { ImageRole } from '@opendirector/core/types/asset';
import {
  GenerationProvider,
  ProviderModel,
} from './types';
import { buildProviderModels } from './types';
import { seedanceTypeDefinition } from './builtin-types/seedance-type';

export class SeedanceProvider implements GenerationProvider {
  id: string;
  name: string;

  /**
   * @param instanceId — the runtime instance ID (e.g. 'seedance-1')
   */
  constructor(instanceId: string) {
    this.id = instanceId;
    this.name = instanceId;
  }

  /** Build models from the declarative type definition */
  models = buildProviderModels(seedanceTypeDefinition);

  getModel(id: string): ProviderModel | undefined {
    return this.models.find((m) => m.id === id);
  }

  estimateDuration(params: GenerationParams): number {
    const base = params.duration * 4;
    const refPenalty = params.references.length > 0 ? 60 : 0;
    return base + refPenalty;
  }
}

// ── Exported content-building utilities ──

/**
 * Map a reference type to the corresponding Seedance content role.
 * When an explicit role is provided (user-selected), it takes precedence.
 * Otherwise falls back to reference_image as the default.
 */
export function refTypeToRole(refType: string, explicitRole?: ImageRole): SeedanceContentRole {
  if (refType === 'video') return 'reference_video';
  if (refType === 'audio') return 'reference_audio';
  if (explicitRole) return explicitRole as SeedanceContentRole;
  return 'reference_image';
}
