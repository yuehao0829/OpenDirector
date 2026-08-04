import { describe, expect, it } from 'vitest';
import type { Reference } from '@opendirector/core/types/asset';
import type { InputRequirements, ReferenceMarkerConfig } from '@opendirector/core/types/provider-system';
import { t as realT, changeI18nLanguage } from '@opendirector/core/i18n';
import {
  renderMarker,
  markerToRegex,
  getReferenceLabels,
  buildMentionItems,
  parsePromptLabels,
  resolveMarkerForUi,
} from './mentionUtils';

// Seedance: bracketed `[图片1]` / `[视频2]` — fixed Chinese type names.
const seedanceMarker: ReferenceMarkerConfig = {
  template: '[{{type}}{{index}}]',
  typeNames: { image: '图片', video: '视频', audio: '音频' },
  mentionableTypes: ['image', 'video', 'audio'],
};

// SeedAudio: `@`-prefixed `@音频1` — only audio is mentionable (image is a
// cloning source, not a prompt citation).
const seedaudioMarker: ReferenceMarkerConfig = {
  template: '@{{type}}{{index}}',
  typeNames: { audio: '音频', image: '图片', video: '视频' },
  mentionableTypes: ['audio'],
};

function ref(id: string, type: Reference['type']): Reference {
  return { id, assetId: `asset-${id}`, type };
}

describe('renderMarker', () => {
  it('renders the bracketed Seedance form', () => {
    expect(renderMarker(seedanceMarker, 'image', 1)).toBe('[图片1]');
    expect(renderMarker(seedanceMarker, 'video', 2)).toBe('[视频2]');
    expect(renderMarker(seedanceMarker, 'audio', 3)).toBe('[音频3]');
  });

  it('renders the @-prefixed SeedAudio form', () => {
    expect(renderMarker(seedaudioMarker, 'audio', 1)).toBe('@音频1');
    expect(renderMarker(seedaudioMarker, 'audio', 2)).toBe('@音频2');
  });
});

describe('markerToRegex', () => {
  it('matches the bracketed Seedance tokens', () => {
    const regex = markerToRegex(seedanceMarker);
    expect('[图片1]'.match(regex)).not.toBeNull();
    expect('[视频2]'.match(regex)).not.toBeNull();
    // The SeedAudio @-form must NOT match the Seedance marker.
    expect('@音频1'.match(regex)).toBeNull();
  });

  it('matches @音频N for the SeedAudio marker (regression: UI used to insert the bracketed [音频N])', () => {
    const regex = markerToRegex(seedaudioMarker);
    expect('@音频1'.match(regex)).not.toBeNull();
    expect('@音频2'.match(regex)).not.toBeNull();
    // The old hardcoded bracketed form must NOT match the SeedAudio marker.
    expect('[音频1]'.match(regex)).toBeNull();
  });

  it('captures the ordinal digit (group 2 = {{index}})', () => {
    const regex = markerToRegex(seedaudioMarker);
    // Use exec (like parsePromptLabels does) — String.match with a global flag
    // returns only full matches, not capture groups.
    const match = regex.exec('@音频3');
    expect(match).not.toBeNull();
    expect(match?.[0]).toBe('@音频3');
    expect(match?.[1]).toBe('音频'); // {{type}}
    expect(match?.[2]).toBe('3');    // {{index}}
  });

  it('escapes regex metacharacters in the template literal segments', () => {
    // Brackets are regex metacharacters — they must be escaped so the regex
    // matches the literal `[图片1]` rather than treating it as a char class.
    const regex = markerToRegex(seedanceMarker);
    expect(() => new RegExp(regex.source)).not.toThrow();
    expect('x图片1y'.match(regex)).toBeNull(); // missing brackets → no match
  });
});

describe('getReferenceLabels', () => {
  it('numbers within each type group (1-based)', () => {
    const labels = getReferenceLabels(
      [ref('a', 'image'), ref('b', 'image'), ref('c', 'audio')],
      seedanceMarker,
    );
    expect(labels.get('a')).toBe('[图片1]');
    expect(labels.get('b')).toBe('[图片2]');
    expect(labels.get('c')).toBe('[音频1]');
  });

  it('uses the @-prefixed SeedAudio form for audio references', () => {
    const labels = getReferenceLabels(
      [ref('a', 'audio'), ref('b', 'audio')],
      seedaudioMarker,
    );
    expect(labels.get('a')).toBe('@音频1');
    expect(labels.get('b')).toBe('@音频2');
  });

  it('skips non-mentionable types (S1: SeedAudio image is not cited in the prompt)', () => {
    // seedaudioMarker.mentionableTypes = ['audio']; an image ref gets no label.
    const labels = getReferenceLabels(
      [ref('img', 'image'), ref('a', 'audio')],
      seedaudioMarker,
    );
    expect(labels.has('img')).toBe(false);
    expect(labels.get('a')).toBe('@音频1');
  });
});

describe('buildMentionItems (mentionableTypes)', () => {
  it('excludes non-mentionable references from the mention list (S1)', () => {
    const items = buildMentionItems(
      [ref('img', 'image'), ref('a', 'audio')],
      [],
      seedaudioMarker,
    );
    // Only the audio ref is offered; image (a cloning source) is not mentionable.
    expect(items.map((i) => i.reference.id)).toEqual(['a']);
    expect(items[0].label).toBe('@音频1');
  });

  it('includes all types when mentionableTypes is the full set', () => {
    const items = buildMentionItems(
      [ref('img', 'image'), ref('vid', 'video')],
      [],
      seedanceMarker,
    );
    expect(items.map((i) => i.reference.id).sort()).toEqual(['img', 'vid']);
  });
});

describe('parsePromptLabels (round-trip)', () => {
  it('parses @音频N tokens back to their references for the SeedAudio marker', () => {
    const refs = [ref('a', 'audio'), ref('b', 'audio')];
    const labels = getReferenceLabels(refs, seedaudioMarker);
    const labelToRef = new Map<string, string>();
    for (const r of refs) labelToRef.set(labels.get(r.id)!, r.id);

    const out = parsePromptLabels(
      '朗读 @音频1 然后 @音频2',
      labelToRef,
      seedaudioMarker,
      (_label, info) => `[REF:${info}]`,
      (text) => text,
    );

    expect(out).toEqual(['朗读 ', '[REF:a]', ' 然后 ', '[REF:b]']);
  });

  it('parses bracketed [图片N] tokens back to their references for the Seedance marker', () => {
    const refs = [ref('a', 'image'), ref('b', 'image')];
    const labels = getReferenceLabels(refs, seedanceMarker);
    const labelToRef = new Map<string, string>();
    for (const r of refs) labelToRef.set(labels.get(r.id)!, r.id);

    const out = parsePromptLabels(
      '使用[图片1]和[图片2]',
      labelToRef,
      seedanceMarker,
      (_label, info) => `[REF:${info}]`,
      (text) => text,
    );

    expect(out).toEqual(['使用', '[REF:a]', '和', '[REF:b]']);
  });

  it('leaves an unrecognized token as plain text', () => {
    const out = parsePromptLabels(
      '见 @音频1',
      new Map<string, string>(),
      seedaudioMarker,
      (_label, info) => `[REF:${info}]`,
      (text) => text,
    );
    // No entry in labelToRef → the token is rendered as plain text.
    expect(out).toEqual(['见 ', '@音频1']);
  });

  it('does not absorb a digit typed after a delimiter-less marker (E3 regression)', () => {
    // User inserts `@音频1` then types `2` → text `@音频12`. Non-greedy `(\d+?)`
    // matches `@音频1` (index 1); the `2` stays plain text instead of being
    // swallowed into a nonexistent reference 12.
    const out = parsePromptLabels(
      '@音频12',
      new Map<string, string>([['@音频1', 'a']]),
      seedaudioMarker,
      (_label, info) => `[REF:${info}]`,
      (text) => text,
    );
    expect(out).toEqual(['[REF:a]', '2']);
  });

  it('still captures a multi-digit index for a bracketed (anchored) marker', () => {
    // `(\d+?)` backtracks against the literal `]` so `[图片12]` → index 12.
    const out = parsePromptLabels(
      '[图片12]',
      new Map<string, string>([['[图片12]', 'a']]),
      seedanceMarker,
      (_label, info) => `[REF:${info}]`,
      (text) => text,
    );
    expect(out).toEqual(['[REF:a]']);
  });
});

describe('resolveMarkerForUi', () => {
  it('falls back to the default template and localized type names when no requirements', () => {
    const marker = resolveMarkerForUi(undefined, (key) =>
      key === 'common.image' ? '图片' : key === 'common.video' ? '视频' : '音频',
    );
    expect(marker.template).toBe('[{{type}}{{index}}]');
    expect(marker.typeNames).toEqual({ image: '图片', video: '视频', audio: '音频' });
  });

  it('uses a literal template + localized (common.*) type names when typeNames is omitted', () => {
    const marker = resolveMarkerForUi(
      { promptRequired: true, referenceMarker: { template: '@{{type}}{{index}}' } } as InputRequirements,
      (key) => (key === 'common.audio' ? '音频' : key === 'common.image' ? '图片' : '视频'),
    );
    expect(marker.template).toBe('@{{type}}{{index}}');
    expect(marker.typeNames.audio).toBe('音频');
    expect(renderMarker(marker, 'audio', 1)).toBe('@音频1');
  });

  it('resolves a declared templateKey via t(), preserving {{type}}/{{index}} placeholders (zh)', () => {
    const marker = resolveMarkerForUi(
      {
        promptRequired: true,
        referenceMarker: { templateKey: 'generation.referenceMarker.seedance.template' },
      } as InputRequirements,
      realT,
    );
    // Placeholders must survive i18next (skipOnVariables) — renderMarker
    // substitutes them afterwards.
    expect(marker.template).toBe('[{{type}}{{index}}]');
    expect(marker.typeNames.image).toBe('图片');
    expect(renderMarker(marker, 'image', 1)).toBe('[图片1]');
  });

  it('localizes the Seedance template to [Image 1] / [Video 2] (with space) in English', async () => {
    await changeI18nLanguage('en-US');
    try {
      const marker = resolveMarkerForUi(
        {
          promptRequired: true,
          referenceMarker: { templateKey: 'generation.referenceMarker.seedance.template' },
        } as InputRequirements,
        realT,
      );
      expect(marker.template).toBe('[{{type}} {{index}}]');
      expect(marker.typeNames.video).toBe('Video');
      expect(renderMarker(marker, 'video', 2)).toBe('[Video 2]');
      expect(renderMarker(marker, 'image', 1)).toBe('[Image 1]');
    } finally {
      await changeI18nLanguage('zh-CN');
    }
  });

  it('localizes the SeedAudio template to @Audio2 (no space) in English', async () => {
    await changeI18nLanguage('en-US');
    try {
      const marker = resolveMarkerForUi(
        {
          promptRequired: true,
          referenceMarker: { templateKey: 'generation.referenceMarker.seedaudio.template' },
        } as InputRequirements,
        realT,
      );
      expect(marker.template).toBe('@{{type}}{{index}}');
      expect(marker.typeNames.audio).toBe('Audio');
      expect(renderMarker(marker, 'audio', 2)).toBe('@Audio2');
    } finally {
      await changeI18nLanguage('zh-CN');
    }
  });
});
