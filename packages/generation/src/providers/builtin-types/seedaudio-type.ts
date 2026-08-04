/**
 * SeedAudio built-in type definition — ByteDance openspeech non-streaming TTS.
 *
 * Single-shot API: POST /api/v3/tts/create (X-Api-Key auth, NOT Bearer) returns
 * base64 audio + url in one response (max 120s). No voice-listing endpoint — the
 * speaker is a free-form voice ID entered manually. Supports optional reference
 * audio / reference image for voice cloning (mutually exclusive with speaker).
 *
 * Credentials: `api_key` + `base_url` (default https://openspeech.bytedance.com).
 */

import type {
  CapabilityParams,
  InputRequirements,
  ProviderTypeDefinition,
} from '@opendirector/core/types/provider-system';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import { t } from '@opendirector/core/i18n';
import type { ParamLayoutItem, VisibleWhenCondition } from '@opendirector/core/types/param-layout';
import { formatAsString, formatAsUpperCase } from '@opendirector/core/types/param-layout';
import { ratesForFormat, pickSampleRate } from '@opendirector/core/utils/audio-params';

const seedaudioInputRequirements: InputRequirements = {
  promptRequired: true,
  maxPromptLength: 3000,
  references: {
    image: {
      required: false,
      min: 0,
      max: 1,
      description: 'Optional reference image for voice cloning (mutually exclusive with audio / speaker).',
    },
    video: {
      required: false,
      min: 0,
      max: 0,
      description: 'Video references are not supported by this generator.',
    },
    audio: {
      required: false,
      min: 0,
      // ByteDance openspeech allows up to 3 reference audios for voice cloning,
      // referenced positionally in the prompt as @音频1 / @音频2 / @音频3.
      max: 3,
      description: 'Optional reference audio for voice cloning (mutually exclusive with image / speaker). Up to 3 clips, referenced as @音频N.',
    },
    maxTotal: 3,
  },
  // SeedAudio cites references in the prompt as `@音频N` / `@AudioN` (`@`
  // prefix, no brackets) — ByteDance openspeech rejects the bracketed `[音频N]`
  // form with `TTSInvalidText:text unreadable`. The template is i18n-driven
  // (resources.ts `generation.referenceMarker.seedaudio`); type names localize
  // from `common.*`, so the token follows the UI language. A literal `template`
  // fallback ensures a missing/typo'd templateKey degrades to the `@` form the
  // server accepts, not the bracketed default.
  referenceMarker: {
    templateKey: 'generation.referenceMarker.seedaudio.template',
    template: '@{{type}}{{index}}',
    // Only audio is cited in the prompt; an image reference is a voice-cloning
    // source passed out-of-band, not a prompt citation — keep it out of the
    // mention UI so users can't insert an `@图片N` the server won't recognize.
    mentionableTypes: ['audio'],
  },
  referenceAssetConstraints: {
    audio: {
      allowedFormats: ['audio/mpeg', 'audio/wav', 'audio/pcm', 'audio/ogg'],
      maxFileSize: 10 * 1024 * 1024, // 10 MB
      durationRange: { min: 0, max: 30 }, // ≤ 30s per clip
      maxTotalDuration: 90, // ≤ 90s across all reference audios
    },
    image: {
      allowedFormats: ['image/jpeg', 'image/png', 'image/webp'],
      maxFileSize: 10 * 1024 * 1024, // 10 MB
    },
  },
  // SeedAudio forbids mixing a reference image with reference audio (the API
  // treats speaker / audio / image as mutually exclusive cloning sources).
  crossConstraints: [
    {
      rule: 'forbid_image_audio_mix',
      message: t('generation.validation.imageAudioMixForbidden'),
    },
  ],
};

/**
 * SeedAudio TTS capability params.
 *
 * - voiceIds: empty — SeedAudio has no voice-listing endpoint, so the speaker
 *   voice ID is entered manually via a free-text `text-input` control.
 * - audioFormats: wav / mp3 / pcm / ogg_opus. `ogg_opus` maps to the `.ogg`
 *   file extension.
 * - sampleRateByFormat: ogg_opus supports [8/16/24/48kHz]; other formats use the
 *   default rate set.
 * - speed / volume / pitch map to the API's speech_rate / loudness_rate /
 *   pitch_rate (offset ranges, 0 = no adjustment).
 */
const seedaudioParams: CapabilityParams = {
  outputType: 'audio',
  voiceIds: [],
  audioFormats: ['wav', 'mp3', 'pcm', 'ogg_opus'],
  sampleRateByFormat: {
    ogg_opus: ['8000', '16000', '24000', '48000'],
    default: ['8000', '16000', '24000', '32000', '44100', '48000'],
  },
  speedRange: { min: -50, max: 100, step: 1 },
  volumeRange: { min: -50, max: 100, step: 1 },
  pitchRange: { min: -12, max: 12, step: 1 },
  // Summary bar shows only the essentials.
  summaryFields: ['voiceId', 'audioFormat', 'sampleRate'],
};

/** Default sample rate (Hz) — reused when switching audio format picks a new rate. */
const DEFAULT_SEEDAUDIO_SAMPLE_RATE = '24000';

/** Reusable condition: model is audio (outputType === 'audio' or voiceIds present). */
const AUDIO_MODEL: VisibleWhenCondition = {
  any: [
    { paramsField: 'outputType', op: 'equals', value: 'audio' },
    { paramsField: 'voiceIds', op: 'truthy' },
  ],
};

/** Build a slider param bound to an audio range field (speed / pitch / volume). */
function audioSliderItem(
  id: string,
  label: string,
  valueKey: string,
  rangeField: string,
  summaryFormat: (value: unknown) => string,
): ParamLayoutItem {
  return {
    id,
    label,
    valueKey,
    summaryFormat,
    visibleWhen: { all: [AUDIO_MODEL, { paramsField: rangeField, op: 'exists' }] },
    control: {
      type: 'slider',
      min: 0, max: 0, step: 1,
      rangeFrom: rangeField,
      decimals: 0,
    },
  };
}

/** Build the SeedAudio TTS declarative parameter layout. */
function buildSeedAudioLayout(params: CapabilityParams): ParamLayoutItem[] {
  return [
    // 1. Voice / speaker (音色 ID，手动输入 — no voice-listing endpoint)
    {
      id: 'voiceId',
      label: 'generationParams.voiceId',
      icon: 'mic',
      valueKey: 'voiceId',
      summaryFormat: formatAsString,
      visibleWhen: AUDIO_MODEL,
      control: {
        type: 'text-input',
        placeholder: 'generationParams.voiceId',
        inputType: 'text',
      },
    },
    // 2. Speed (语速 → speech_rate)
    audioSliderItem('speed', 'generationParams.speed', 'speed', 'speedRange', (v) => `${v}`),
    // 3. Pitch (语调 → pitch_rate)
    audioSliderItem('pitch', 'generationParams.pitch', 'pitch', 'pitchRange', (v) => `语调 ${v}`),
    // 4. Volume (音量 → loudness_rate)
    audioSliderItem('volume', 'generationParams.volume', 'volume', 'volumeRange', (v) => `音量 ${v}`),
    // 5. Audio format (音频格式)
    {
      id: 'audioFormat',
      label: 'generationParams.audioFormat',
      valueKey: 'audioFormat',
      summaryFormat: formatAsUpperCase,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'audioFormats', op: 'truthy' }] },
      adjustOnChange: (newVal) => {
        const rates = ratesForFormat(params.sampleRateByFormat, params.sampleRates, (newVal.audioFormat as string) ?? '');
        if (rates?.length && !rates.includes((newVal.sampleRate as string) ?? '')) {
          return { ...newVal, sampleRate: pickSampleRate(rates, DEFAULT_SEEDAUDIO_SAMPLE_RATE) };
        }
        return newVal;
      },
      control: {
        type: 'button-group',
        options: [],
        optionsFrom: 'audioFormats',
        uppercase: true,
      },
    },
    // 6. Sample rate (采样率)
    {
      id: 'sampleRate',
      label: 'generationParams.sampleRate',
      valueKey: 'sampleRate',
      summaryFormat: (v) => `${v}Hz`,
      visibleWhen: AUDIO_MODEL,
      control: {
        type: 'select',
        options: [],
        optionsFrom: 'sampleRates',
        placeholder: 'generationParams.sampleRate',
      },
    },
  ];
}

// Apply layout to seedaudioParams
seedaudioParams.paramLayout = buildSeedAudioLayout(seedaudioParams);

function createModel(
  modelId: string,
  name: string,
  shortName: string,
  recommended = false,
) {
  return {
    modelId,
    name,
    shortName,
    familyId: 'seedaudio-tts',
    inputRequirements: seedaudioInputRequirements,
    params: { ...seedaudioParams },
    metadata: {
      ...(recommended ? { recommended: true } : {}),
      defaultVoiceId: '',
      defaultAudioFormat: 'mp3',
      defaultSampleRate: DEFAULT_SEEDAUDIO_SAMPLE_RATE,
      defaultSpeed: 0,
      defaultVolume: 0,
      defaultPitch: 0,
    },
  };
}

export function createSeedAudioTypeDefinition(): ProviderTypeDefinition {
  return {
    typeId: BUILTIN_TYPE_IDS.SEEDAUDIO,
    name: 'SeedAudio',
    providerType: 'generation',
    builtIn: true,
    description: t('generation.provider.seedaudioDescription'),
    credentialFields: [
      {
        key: 'base_url',
        label: 'Base URL',
        type: 'url',
        placeholder: 'https://openspeech.bytedance.com',
        defaultValue: 'https://openspeech.bytedance.com',
        description: 'SeedAudio API base URL (X-Api-Key auth).',
      },
      {
        key: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: t('generation.provider.apiKeyPlaceholder'),
      },
    ],
    modelFamilies: [
      {
        id: 'seedaudio-tts',
        name: 'SeedAudio TTS',
        models: [
          createModel('seed-audio-1.0', 'SeedAudio 1.0', 'SeedAudio', true),
        ],
      },
    ],
  };
}

export const seedaudioTypeDefinition = createSeedAudioTypeDefinition();
