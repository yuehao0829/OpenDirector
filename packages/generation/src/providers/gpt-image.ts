import type { GenerationParams } from '@opendirector/core/types/generation';
import { buildProviderModels } from './types';
import type { GenerationProvider, ProviderModel } from './types';
import { gptImageTypeDefinition } from './builtin-types/gpt-image-type';

export class GptImageProvider implements GenerationProvider {
  id: string;
  name: string;

  constructor(instanceId: string) {
    this.id = instanceId;
    this.name = instanceId;
  }

  models = buildProviderModels(gptImageTypeDefinition);

  getModel(id: string): ProviderModel | undefined {
    return this.models.find((m) => m.id === id);
  }

  estimateDuration(_params: GenerationParams): number {
    return 45;
  }
}
