import type { GenerationParams } from '@opendirector/core/types/generation';
import { buildProviderModels } from './types';
import type { GenerationProvider, ProviderModel } from './types';
import { seedaudioTypeDefinition } from './builtin-types/seedaudio-type';

export class SeedAudioProvider implements GenerationProvider {
  id: string;
  name: string;

  constructor(instanceId: string) {
    this.id = instanceId;
    this.name = instanceId;
  }

  models = buildProviderModels(seedaudioTypeDefinition);

  getModel(id: string): ProviderModel | undefined {
    return this.models.find((m) => m.id === id);
  }

  estimateDuration(params: GenerationParams): number {
    // SeedAudio single-shot synthesis is capped at 120s of audio. Estimate audio
    // length from text (~chars / 12 ≈ seconds, plus ~5s overhead) and clamp to
    // the 120s API ceiling.
    const textLength = params.prompt?.length ?? 0;
    return Math.min(120, Math.max(10, Math.round(textLength / 12) + 5));
  }

  // No fetchVoices — SeedAudio has no voice-listing endpoint. The speaker voice
  // ID is a free-form value entered manually in the inspector.
}
