import { describe, expect, it } from 'vitest';
import { seedaudioTypeDefinition } from './seedaudio-type';
import type { InputRequirements } from '@opendirector/core/types/provider-system';

/** The (shared) input requirements for the SeedAudio model. */
function seedaudioRequirements(): InputRequirements {
  const model = seedaudioTypeDefinition.modelFamilies
    .flatMap((f) => f.models)
    .find((m) => m.modelId === 'seed-audio-1.0');
  return model!.inputRequirements!;
}

describe('seedaudioTypeDefinition', () => {
  it('uses snake_case `api_key` as the storage key for the API Key password field', () => {
    const apiKeyField = seedaudioTypeDefinition.credentialFields?.find(
      (f) => f.type === 'password',
    );
    expect(apiKeyField?.key).toBe('api_key');
  });

  describe('reference slots (multi-reference audio)', () => {
    it('allows up to 3 audio references (ByteDance openspeech @音频N)', () => {
      const refs = seedaudioRequirements().references;
      expect(refs.audio?.max).toBe(3);
      expect(refs.image?.max).toBe(1);
      expect(refs.video?.max).toBe(0);
      expect(refs.maxTotal).toBe(3);
    });
  });

  describe('referenceAssetConstraints', () => {
    it('limits reference audio to ≤10MB, ≤30s, wav/mp3/pcm/ogg with 90s total', () => {
      const audio = seedaudioRequirements().referenceAssetConstraints?.audio;
      expect(audio).toBeDefined();
      expect(audio?.allowedFormats).toEqual([
        'audio/mpeg',
        'audio/wav',
        'audio/pcm',
        'audio/ogg',
      ]);
      expect(audio?.maxFileSize).toBe(10 * 1024 * 1024);
      expect(audio?.durationRange).toEqual({ min: 0, max: 30 });
      expect(audio?.maxTotalDuration).toBe(90);
    });

    it('limits reference images to ≤10MB, jpeg/png/webp', () => {
      const image = seedaudioRequirements().referenceAssetConstraints?.image;
      expect(image).toBeDefined();
      expect(image?.allowedFormats).toEqual([
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
      expect(image?.maxFileSize).toBe(10 * 1024 * 1024);
    });
  });

  describe('crossConstraints', () => {
    it('forbids mixing reference image with reference audio', () => {
      const rules = seedaudioRequirements().crossConstraints?.map((c) => c.rule) ?? [];
      expect(rules).toContain('forbid_image_audio_mix');
    });
  });

  describe('referenceMarker', () => {
    it('declares the @音频N / @AudioN citation form via an i18n templateKey with an @ literal fallback', () => {
      const marker = seedaudioRequirements().referenceMarker;
      expect(marker?.templateKey).toBe('generation.referenceMarker.seedaudio.template');
      // Literal fallback so a missing/typo'd templateKey degrades to the `@`
      // form the server accepts, not the bracketed default.
      expect(marker?.template).toBe('@{{type}}{{index}}');
      // Only audio is cited in the prompt; an image reference is a cloning
      // source passed out-of-band, not a prompt citation.
      expect(marker?.mentionableTypes).toEqual(['audio']);
      expect(marker?.typeNames).toBeUndefined();
    });
  });
});
