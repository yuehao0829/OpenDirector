import { describe, expect, it } from 'vitest';
import {
  supportsAnyReference,
  validateInputRequirements,
  computeReferenceIndicators,
  resolveReferenceMarker,
  type InputRequirements,
} from './provider-system';
import type { Asset, Reference } from './asset';

describe('supportsAnyReference', () => {
  it('returns false when requirements are undefined (no model / undeclared)', () => {
    expect(supportsAnyReference(undefined)).toBe(false);
  });

  it('returns false when references block is absent', () => {
    const req = { promptRequired: true } as InputRequirements;
    expect(supportsAnyReference(req)).toBe(false);
  });

  it('returns true when image max > 0', () => {
    const req: InputRequirements = {
      promptRequired: true,
      references: { image: { required: false, min: 0, max: 9 } },
    };
    expect(supportsAnyReference(req)).toBe(true);
  });

  it('returns true when video max > 0', () => {
    const req: InputRequirements = {
      promptRequired: true,
      references: { video: { required: false, min: 0, max: 3 } },
    };
    expect(supportsAnyReference(req)).toBe(true);
  });

  it('returns true when audio max > 0', () => {
    const req: InputRequirements = {
      promptRequired: true,
      references: { audio: { required: false, min: 0, max: 1 } },
    };
    expect(supportsAnyReference(req)).toBe(true);
  });

  it('returns false when all types are explicitly max: 0 (MiniMax / GPT-Image)', () => {
    const req: InputRequirements = {
      promptRequired: true,
      references: {
        image: { required: false, min: 0, max: 0 },
        video: { required: false, min: 0, max: 0 },
        audio: { required: false, min: 0, max: 0 },
        maxTotal: 0,
      },
    };
    expect(supportsAnyReference(req)).toBe(false);
  });

  it('treats undefined max as unlimited (supported), matching validateInputRequirements', () => {
    const req: InputRequirements = {
      promptRequired: true,
      references: { image: { required: false, min: 0 } }, // max omitted
    };
    expect(supportsAnyReference(req)).toBe(true);
  });

  it('returns true when at least one type is supported even if others are max: 0 (SeedAudio)', () => {
    const req: InputRequirements = {
      promptRequired: true,
      references: {
        image: { required: false, min: 0, max: 1 },
        video: { required: false, min: 0, max: 0 },
        audio: { required: false, min: 0, max: 1 },
        maxTotal: 1,
      },
    };
    expect(supportsAnyReference(req)).toBe(true);
  });
});

describe('SeedAudio-style crossConstraint + referenceAssetConstraints', () => {
  const SEEDAUDIO_LIKE_REQ: InputRequirements = {
    promptRequired: true,
    references: {
      image: { required: false, min: 0, max: 1 },
      video: { required: false, min: 0, max: 0 },
      audio: { required: false, min: 0, max: 3 },
      maxTotal: 3,
    },
    referenceAssetConstraints: {
      audio: {
        allowedFormats: ['audio/mpeg', 'audio/wav', 'audio/pcm', 'audio/ogg'],
        maxFileSize: 10 * 1024 * 1024,
        durationRange: { min: 0, max: 30 },
        maxTotalDuration: 90,
      },
      image: {
        allowedFormats: ['image/jpeg', 'image/png', 'image/webp'],
        maxFileSize: 10 * 1024 * 1024,
      },
    },
    crossConstraints: [{ rule: 'forbid_image_audio_mix', message: 'no mix' }],
  };

  function audioAsset(over: Partial<Asset>): Asset {
    return {
      id: 'a1',
      name: 'clip',
      type: 'audio',
      source: 'original',
      url: '',
      fileSize: 1024,
      mimeType: 'audio/mpeg',
      duration: 1000,
      tags: [],
      favorite: false,
      usageCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...over,
    } as Asset;
  }

  describe('forbid_image_audio_mix (validateInputRequirements)', () => {
    it('blocks when both image and audio references are present', () => {
      const refs: Reference[] = [
        { id: 'r1', assetId: 'a1', type: 'image' },
        { id: 'r2', assetId: 'a2', type: 'audio' },
      ];
      const result = validateInputRequirements({ prompt: 'hi', references: refs }, SEEDAUDIO_LIKE_REQ);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('no mix');
    });

    it('does not block audio-only references', () => {
      const refs: Reference[] = [{ id: 'r1', assetId: 'a1', type: 'audio' }];
      const result = validateInputRequirements({ prompt: 'hi', references: refs }, SEEDAUDIO_LIKE_REQ);
      expect(result.errors).not.toContain('no mix');
      expect(result.valid).toBe(true);
    });

    it('does not block image-only references', () => {
      const refs: Reference[] = [{ id: 'r1', assetId: 'a1', type: 'image' }];
      const result = validateInputRequirements({ prompt: 'hi', references: refs }, SEEDAUDIO_LIKE_REQ);
      expect(result.errors).not.toContain('no mix');
      expect(result.valid).toBe(true);
    });
  });

  describe('referenceAssetConstraints (computeReferenceIndicators)', () => {
    it('flags >10MB audio as a size warning (auto-compressible, not blocking)', () => {
      const refs: Reference[] = [{ id: 'r1', assetId: 'a1', type: 'audio' }];
      const asset = audioAsset({ fileSize: 11 * 1024 * 1024, duration: 5000 });
      const result = computeReferenceIndicators(
        { references: refs, getAsset: () => asset },
        SEEDAUDIO_LIKE_REQ,
      );
      const inds = result.indicators.get('r1') ?? [];
      expect(inds.some((i) => i.type === 'size_over_limit')).toBe(true);
      expect(inds.find((i) => i.type === 'size_over_limit')?.severity).toBe('warning');
      expect(result.hasErrors).toBe(false);
    });

    it('flags >30s audio as a duration error (blocking — needs manual trim)', () => {
      const refs: Reference[] = [{ id: 'r1', assetId: 'a1', type: 'audio' }];
      const asset = audioAsset({ duration: 40_000, fileSize: 1024 });
      const result = computeReferenceIndicators(
        { references: refs, getAsset: () => asset },
        SEEDAUDIO_LIKE_REQ,
      );
      const inds = result.indicators.get('r1') ?? [];
      expect(inds.some((i) => i.type === 'duration_over_limit')).toBe(true);
      expect(result.hasErrors).toBe(true);
    });

    it('flags an unsupported audio format as a format warning (auto-transcodable)', () => {
      const refs: Reference[] = [{ id: 'r1', assetId: 'a1', type: 'audio' }];
      const asset = audioAsset({ mimeType: 'audio/flac', fileSize: 1024, duration: 5000 });
      const result = computeReferenceIndicators(
        { references: refs, getAsset: () => asset },
        SEEDAUDIO_LIKE_REQ,
      );
      const inds = result.indicators.get('r1') ?? [];
      expect(inds.some((i) => i.type === 'format_not_supported')).toBe(true);
      expect(inds.find((i) => i.type === 'format_not_supported')?.severity).toBe('warning');
      expect(result.hasErrors).toBe(false);
    });

    it('passes a compliant audio reference with no indicators', () => {
      const refs: Reference[] = [{ id: 'r1', assetId: 'a1', type: 'audio' }];
      const asset = audioAsset({ mimeType: 'audio/wav', fileSize: 5 * 1024 * 1024, duration: 20_000 });
      const result = computeReferenceIndicators(
        { references: refs, getAsset: () => asset },
        SEEDAUDIO_LIKE_REQ,
      );
      expect(result.indicators.has('r1')).toBe(false);
      expect(result.hasErrors).toBe(false);
    });
  });
});

describe('resolveReferenceMarker', () => {
  const FALLBACK = { image: '图片', video: '视频', audio: '音频' };

  it('defaults to the [{{type}}{{index}}] template when referenceMarker is absent', () => {
    const m = resolveReferenceMarker(undefined, FALLBACK);
    expect(m.template).toBe('[{{type}}{{index}}]');
  });

  it('uses localized fallbacks from common.* when no fallbackTypeNames is supplied', () => {
    // The default fallback uses translate('common.*') — zh-CN in the test env.
    const m = resolveReferenceMarker();
    expect(m.typeNames).toEqual({ image: '图片', video: '视频', audio: '音频' });
    expect(m.template).toBe('[{{type}}{{index}}]');
  });

  it('keeps the declared template (SeedAudio @-prefixed form)', () => {
    const req = {
      promptRequired: true,
      referenceMarker: { template: '@{{type}}{{index}}', typeNames: { audio: '音频' } },
    } as InputRequirements;
    const m = resolveReferenceMarker(req, FALLBACK);
    expect(m.template).toBe('@{{type}}{{index}}');
  });

  it('provider-declared typeNames win over fallbacks; gaps are filled from fallback', () => {
    const req = {
      promptRequired: true,
      referenceMarker: {
        template: '@{{type}}{{index}}',
        typeNames: { audio: '音频', image: '图片' },
      },
    } as InputRequirements;
    const m = resolveReferenceMarker(req, { image: 'Image', video: 'Video', audio: 'Audio' });
    expect(m.typeNames.audio).toBe('音频'); // declared wins
    expect(m.typeNames.image).toBe('图片'); // declared wins
    expect(m.typeNames.video).toBe('Video'); // gap filled from fallback
  });

  it('falls back to the default template when the declared template is blank', () => {
    const req = {
      promptRequired: true,
      referenceMarker: { template: '   ' },
    } as InputRequirements;
    const m = resolveReferenceMarker(req, FALLBACK);
    expect(m.template).toBe('[{{type}}{{index}}]');
  });

  it('always returns a fully-populated typeNames object (no optionals)', () => {
    const m = resolveReferenceMarker(
      { promptRequired: true, referenceMarker: { template: '@{{type}}{{index}}' } } as InputRequirements,
      FALLBACK,
    );
    expect(m.typeNames).toEqual({ image: '图片', video: '视频', audio: '音频' });
  });

  it('resolves a declared templateKey via i18n translate (zh)', () => {
    const req = {
      promptRequired: true,
      referenceMarker: { templateKey: 'generation.referenceMarker.seedance.template' },
    } as InputRequirements;
    const m = resolveReferenceMarker(req, FALLBACK);
    // The zh resource value is '[{{type}}{{index}}]' (no space).
    expect(m.template).toBe('[{{type}}{{index}}]');
  });

  it('falls back to the literal template when a templateKey is unresolved (missing key)', () => {
    const req = {
      promptRequired: true,
      referenceMarker: { templateKey: 'missing.key', template: '@{{type}}{{index}}' },
    } as InputRequirements;
    const m = resolveReferenceMarker(req, FALLBACK);
    // i18next returns the key itself when missing → treated as unresolved → literal.
    expect(m.template).toBe('@{{type}}{{index}}');
  });

  it('defaults mentionableTypes to all asset types when not declared', () => {
    const m = resolveReferenceMarker(undefined, FALLBACK);
    expect(m.mentionableTypes).toEqual(['image', 'video', 'audio']);
  });

  it('honors a declared mentionableTypes (e.g. SeedAudio audio-only)', () => {
    const req = {
      promptRequired: true,
      referenceMarker: { template: '@{{type}}{{index}}', mentionableTypes: ['audio'] },
    } as InputRequirements;
    const m = resolveReferenceMarker(req, FALLBACK);
    expect(m.mentionableTypes).toEqual(['audio']);
  });
});
