import type { GenerationParams } from '@opendirector/core/types/generation';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { getProviderPassword } from '@opendirector/core/types/provider-system';
import { buildProviderModels } from './types';
import type { GenerationProvider, ProviderModel } from './types';
import { minimaxTypeDefinition } from './builtin-types/minimax-type';

export class MiniMaxProvider implements GenerationProvider {
  id: string;
  name: string;

  constructor(instanceId: string) {
    this.id = instanceId;
    this.name = instanceId;
  }

  models = buildProviderModels(minimaxTypeDefinition);

  getModel(id: string): ProviderModel | undefined {
    return this.models.find((m) => m.id === id);
  }

  estimateDuration(params: GenerationParams): number {
    // TTS latency scales with text length (~chars / 12 ≈ seconds of audio, plus ~5s overhead).
    const textLength = (params.prompt?.length ?? 0);
    return Math.max(10, Math.round(textLength / 12) + 5);
  }

  /**
   * Fetch cloud voices (system / cloned / designed) on demand.
   * Password is read lazily at call time (not cached on the instance) so that
   * re-saving the MiniMax API key (which re-encrypts the .enc with a fresh
   * password) doesn't leave a stale password that fails to decrypt.
   */
  async fetchVoices(): Promise<Array<{ value: string; label: string }>> {
    const inst = useProviderInstanceStore.getState().get(this.id);
    const password = getProviderPassword(inst);
    if (!password) throw new Error('MiniMax credentials not available');
    const result = await tauriBridge.minimaxTtsApi.getVoices(this.id, password);
    return result.voices.map((v) => ({ value: v.voice_id, label: v.name ?? v.voice_id }));
  }
}
