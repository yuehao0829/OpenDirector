import type { GenerationParams, GenerationResult } from '@opendirector/core/types/generation';
import type { CapabilityParams } from '@opendirector/core/types/provider-system';

/**
 * A model provided by a generation provider
 */
export interface ProviderModel {
  id: string;
  name: string;
  params?: CapabilityParams;
}

export interface GenerationProvider {
  id: string;
  name: string;

  models: ProviderModel[];
  getModel(id: string): ProviderModel | undefined;

  generate?(params: GenerationParams): Promise<GenerationResult>;
  estimateDuration(params: GenerationParams): number;
  estimateCost?(params: GenerationParams): { credits: number; currency: string };

  checkStatus?(): Promise<ProviderStatus>;
  getQuota?(): Promise<QuotaInfo>;
}

export interface ProviderStatus {
  available: boolean;
  message?: string;
}

export interface QuotaInfo {
  used: number;
  total: number;
  resetAt?: Date;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

/** Build ProviderModel[] from a ProviderTypeDefinition */
export function buildProviderModels(typeDef: { modelFamilies: Array<{ models: Array<{ modelId: string; name: string; params?: CapabilityParams }> }> }): ProviderModel[] {
  return typeDef.modelFamilies.flatMap((family) =>
    family.models.map((variant) => ({
      id: variant.modelId,
      name: variant.name,
      params: variant.params,
    }))
  );
}
