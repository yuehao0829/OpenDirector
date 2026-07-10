/**
 * MiniMax built-in type definition — Phase 1: async TTS.
 *
 * MiniMax TTS is async: create → poll → download. Credentials are pure Bearer;
 * base_url defaults to https://api.minimaxi.com.
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

const minimaxTtsInputRequirements: InputRequirements = {
  promptRequired: true,
  maxPromptLength: 50000,
  references: {
    image: {
      required: false,
      min: 0,
      max: 0,
      description: 'Image references are not supported by this generator.',
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
      max: 0,
      description: 'Audio references are not supported by this generator.',
    },
    maxTotal: 0,
  },
};

/**
 * Static default system voices (a curated subset of MiniMax system voices).
 * Cloud-fetched voices (cloned / designed) merge in at runtime via /v1/get_voice.
 */
const DEFAULT_MINIMAX_VOICES = [
  { value: 'male-qn-qingse', label: '青涩青年 (Male · Youth)', labelEn: 'Male · Youth' },
  { value: 'male-qn-jingying', label: '精英青年 (Male · Elite)', labelEn: 'Male · Elite' },
  { value: 'male-qn-badao', label: '霸道青年 (Male · Dominant)', labelEn: 'Male · Dominant' },
  { value: 'male-qn-daxuesheng', label: '大学生青年 (Male · Student)', labelEn: 'Male · Student' },
  { value: 'female-shaonv', label: '少女 (Female · Girl)', labelEn: 'Female · Girl' },
  { value: 'female-yujie', label: '御姐 (Female · Mature)', labelEn: 'Female · Mature' },
  { value: 'female-chengshu', label: '成熟女性 (Female · Adult)', labelEn: 'Female · Adult' },
  { value: 'female-tianmei', label: '甜美女性 (Female · Sweet)', labelEn: 'Female · Sweet' },
  { value: 'presenter_male', label: '男主持人 (Male · Presenter)', labelEn: 'Male · Presenter' },
  { value: 'presenter_female', label: '女主持人 (Female · Presenter)', labelEn: 'Female · Presenter' },
  { value: 'audiobook_male_1', label: '男声有声书 (Male · Audiobook)', labelEn: 'Male · Audiobook' },
  { value: 'audiobook_female_1', label: '女声有声书 (Female · Audiobook)', labelEn: 'Female · Audiobook' },
];

/**
 * MiniMax emotion enums — model-version dependent.
 * - speech-2.8 series: BASE only (happy/sad/angry/fearful/disgusted/surprised/calm).
 * - speech-2.6 series: BASE + fluent/whisper (style emotions); 'whisper' is rejected by 2.8.
 * The global list's 'neutral' is rejected by the API (returns no task_id), so we use MiniMax's
 * own enum; 'calm' is the neutral equivalent and the default.
 */
const MINIMAX_BASE_EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];
const MINIMAX_EMOTIONS_WITH_STYLE = [...MINIMAX_BASE_EMOTIONS, 'fluent', 'whisper'];

/**
 * MiniMax TTS capability params (emotions are per-model, injected by createModel).
 * - audioFormats: 'opus' added (the global list omits it); pcmu_raw/pcmu_wav are omitted
 *   (edge formats with a fixed 8kHz rate).
 * - sampleRateByFormat: opus supports [8/12/16/24/48kHz], non-opus supports
 *   [8/16/22.05/24/32/44.1kHz]. 48000 is opus-only — mp3+48000 is rejected by the API, so it
 *   must not appear in the non-opus list.
 */
const minimaxTtsParams: CapabilityParams = {
  outputType: 'audio',
  voiceIds: DEFAULT_MINIMAX_VOICES,
  audioFormats: ['mp3', 'wav', 'pcm', 'flac', 'opus'],
  sampleRateByFormat: {
    opus: ['8000', '12000', '16000', '24000', '48000'],
    default: ['8000', '16000', '22050', '24000', '32000', '44100'],
  },
  speedRange: { min: 0.5, max: 2, step: 0.1 },
  volumeRange: { min: 0.1, max: 10, step: 0.1 },
  pitchRange: { min: -12, max: 12, step: 1 },
  bitrates: [32000, 64000, 128000, 256000],
  channels: [1, 2],
  languageBoostOptions: ['auto', 'Chinese', 'Chinese,Yue', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Russian', 'Arabic', 'Portuguese', 'Italian', 'Thai', 'Vietnamese', 'Indonesian', 'Hindi', 'Turkish', 'Dutch', 'Ukrainian', 'Polish', 'Romanian', 'Greek', 'Czech', 'Finnish', 'Bulgarian', 'Danish', 'Hebrew', 'Malay', 'Persian', 'Slovak', 'Swedish', 'Croatian', 'Filipino', 'Hungarian', 'Norwegian', 'Slovenian', 'Catalan', 'Nynorsk', 'Tamil', 'Afrikaans'],
  voiceModifyPitchRange: { min: -100, max: 100, step: 1 },
  voiceModifyIntensityRange: { min: -100, max: 100, step: 1 },
  voiceModifyTimbreRange: { min: -100, max: 100, step: 1 },
  voiceModifySoundEffects: [
    { value: 'spacious_echo', label: '空旷回音' },
    { value: 'auditorium_echo', label: '礼堂广播' },
    { value: 'lofi_telephone', label: '电话失真' },
    { value: 'robotic', label: '电音' },
  ],
  supportsPronunciationDict: true,
  supportsAigcWatermark: true,
  supportsEnglishNormalization: true,
  // Summary bar shows only the essentials — advanced params live in the collapsible section
  summaryFields: ['voiceId', 'emotion', 'audioFormat', 'channel', 'sampleRate'],
  voiceModifyFormats: ['mp3', 'wav', 'flac'],
};

/** Reusable condition: model is audio (outputType === 'audio' or voiceIds present). */
const AUDIO_MODEL: VisibleWhenCondition = {
  any: [
    { paramsField: 'outputType', op: 'equals', value: 'audio' },
    { paramsField: 'voiceIds', op: 'truthy' },
  ],
};

/**
 * Build a visibleWhen condition that checks whether the current audioFormat
 * is in the provider-declared `voiceModifyFormats` list. Uses the `'in'`
 * operator from the VisibleWhenCondition DSL. This keeps the
 * "which formats support voice_modify" knowledge in one place
 * (CapabilityParams.voiceModifyFormats) instead of hardcoding it in the
 * layout and the submitter.
 */
function voiceModifyFormatCondition(
  voiceModifyFormats: string[] | undefined,
): VisibleWhenCondition {
  return { valueField: 'audioFormat', op: 'in', value: voiceModifyFormats ?? [] };
}

/** Build the MiniMax TTS declarative parameter layout. */
function buildMinimaxLayout(params: CapabilityParams): ParamLayoutItem[] {
  return [
    // 1. Voice (音色)
    {
      id: 'voiceId',
      label: 'generationParams.voiceId',
      icon: 'mic',
      valueKey: 'voiceId',
      summaryFormat: (v, params, ctx) => {
        const voiceVal = String(v);
        const fromParams = params.voiceIds?.find((vo: { value: string; label: string; labelEn?: string }) => vo.value === voiceVal);
        const fromFetched = ctx.fetchedVoices?.find((vo: { value: string; label: string }) => vo.value === voiceVal);
        const isEnglish = ctx.lang?.startsWith('en') ?? false;
        if (fromParams) {
          return isEnglish && fromParams.labelEn ? fromParams.labelEn : fromParams.label;
        }
        return fromFetched?.label ?? voiceVal;
      },
      visibleWhen: AUDIO_MODEL,
      control: {
        type: 'voice-selector',
        options: [],
        optionsFrom: 'voiceIds',
        showFetchButton: true,
      },
    },
    // 2. Emotion (情绪)
    {
      id: 'emotion',
      label: 'generationParams.emotion',
      valueKey: 'emotion',
      summaryFormat: formatAsString,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'emotions', op: 'truthy' }] },
      control: {
        type: 'button-group',
        options: [],
        optionsFrom: 'emotions',
        wrap: true,
        buttonSize: 'sm',
      },
    },
    // 3. Speed (语速)
    {
      id: 'speed',
      label: 'generationParams.speed',
      valueKey: 'speed',
      summaryFormat: (v) => `${v}x`,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'speedRange', op: 'exists' }] },
      control: {
        type: 'slider',
        min: 0, max: 0, step: 0.1,
        rangeFrom: 'speedRange',
        valueFormat: (v) => `${v.toFixed(1)}x`,
        decimals: 1,
      },
    },
    // 4. Pitch / 语调
    {
      id: 'pitch',
      label: 'generationParams.pitch',
      valueKey: 'pitch',
      summaryFormat: (v) => `语调 ${v}`,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'pitchRange', op: 'exists' }] },
      control: {
        type: 'slider',
        min: 0, max: 0, step: 1,
        rangeFrom: 'pitchRange',
        decimals: 0,
      },
    },
    // 5. Voice modify group (声音变化: 音高/强度/音色 + 声音效果器)
    {
      id: 'voice-modify',
      label: 'generationParams.voiceModify',
      icon: 'sliders',
      visibleWhen: {
        all: [
          AUDIO_MODEL,
          voiceModifyFormatCondition(params.voiceModifyFormats),
          {
            any: [
              { paramsField: 'voiceModifyPitchRange', op: 'exists' },
              { paramsField: 'voiceModifyIntensityRange', op: 'exists' },
              { paramsField: 'voiceModifyTimbreRange', op: 'exists' },
              { paramsField: 'voiceModifySoundEffects', op: 'truthy' },
            ],
          },
        ],
      },
      control: {
        type: 'slider-group',
        icon: 'sliders',
        sliders: [
          {
            key: 'voiceModifyPitch',
            label: 'generationParams.voiceModifyPitch',
            min: 0, max: 0, step: 1,
            rangeFrom: 'voiceModifyPitchRange',
            rangeLabels: { min: 'generationParams.voiceModifyPitchMin', max: 'generationParams.voiceModifyPitchMax' },
          },
          {
            key: 'voiceModifyIntensity',
            label: 'generationParams.voiceModifyIntensity',
            min: 0, max: 0, step: 1,
            rangeFrom: 'voiceModifyIntensityRange',
            rangeLabels: { min: 'generationParams.voiceModifyIntensityMin', max: 'generationParams.voiceModifyIntensityMax' },
          },
          {
            key: 'voiceModifyTimbre',
            label: 'generationParams.voiceModifyTimbre',
            min: 0, max: 0, step: 1,
            rangeFrom: 'voiceModifyTimbreRange',
            rangeLabels: { min: 'generationParams.voiceModifyTimbreMin', max: 'generationParams.voiceModifyTimbreMax' },
          },
        ],
        trailingSelect: {
          key: 'voiceModifySoundEffects',
          label: 'generationParams.voiceModifySoundEffects',
          options: [],
          optionsFrom: 'voiceModifySoundEffects',
          includeNone: true,
          placeholder: 'common.none',
        },
      },
    },
    // 6. Volume (音量)
    {
      id: 'volume',
      label: 'generationParams.volume',
      valueKey: 'volume',
      summaryFormat: (v) => `音量 ${v}`,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'volumeRange', op: 'exists' }] },
      control: {
        type: 'slider',
        min: 0, max: 0, step: 0.1,
        rangeFrom: 'volumeRange',
        decimals: 1,
      },
    },
    // 7. Audio format (音频格式)
    {
      id: 'audioFormat',
      label: 'generationParams.audioFormat',
      valueKey: 'audioFormat',
      summaryFormat: formatAsUpperCase,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'audioFormats', op: 'truthy' }] },
      adjustOnChange: (newVal) => {
        const rates = ratesForFormat(params.sampleRateByFormat, params.sampleRates, (newVal.audioFormat as string) ?? '');
        if (rates?.length && !rates.includes((newVal.sampleRate as string) ?? '')) {
          return { ...newVal, sampleRate: pickSampleRate(rates) };
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
    // 8. Channel (声道)
    {
      id: 'channel',
      label: 'generationParams.channel',
      valueKey: 'channel',
      summaryFormat: (v, _p, ctx) => Number(v) === 1 ? ctx.t('generationParams.channelMono') : ctx.t('generationParams.channelStereo'),
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'channels', op: 'truthy' }] },
      control: {
        type: 'button-group',
        options: [
          { value: 1, label: 'generationParams.channelMono' },
          { value: 2, label: 'generationParams.channelStereo' },
        ],
      },
    },
    // 9. Sample rate (采样率)
    {
      id: 'sampleRate',
      label: 'generationParams.sampleRate',
      valueKey: 'sampleRate',
      summaryFormat: (v) => `${v}Hz`,
      row: 'audio-quality',
      visibleWhen: AUDIO_MODEL,
      control: {
        type: 'select',
        options: [],
        optionsFrom: 'sampleRates',
        placeholder: 'generationParams.sampleRate',
      },
    },
    // 10. Bitrate (比特率) — only effective for mp3
    {
      id: 'bitrate',
      label: 'generationParams.bitrate',
      valueKey: 'bitrate',
      summaryFormat: (v) => `${Math.round(Number(v) / 1000)}kbps`,
      row: 'audio-quality',
      visibleWhen: {
        all: [
          AUDIO_MODEL,
          { paramsField: 'bitrates', op: 'truthy' },
          { valueField: 'audioFormat', op: 'equals', value: 'mp3' },
        ],
      },
      control: {
        type: 'select',
        options: [],
        optionsFrom: 'bitrates',
        placeholder: 'generationParams.bitrate',
      },
    },
    // ── Advanced options ──
    // 11. Language boost (小语种增强)
    {
      id: 'languageBoost',
      label: 'generationParams.languageBoost',
      valueKey: 'languageBoost',
      advanced: true,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'languageBoostOptions', op: 'truthy' }] },
      control: {
        type: 'select',
        options: [],
        optionsFrom: 'languageBoostOptions',
        placeholder: 'generationParams.languageBoost',
      },
    },
    // 12. English normalization + AIGC watermark toggles
    {
      id: 'tts-advanced-toggles',
      advanced: true,
      visibleWhen: {
        all: [
          AUDIO_MODEL,
          {
            any: [
              { paramsField: 'supportsEnglishNormalization', op: 'truthy' },
              { paramsField: 'supportsAigcWatermark', op: 'truthy' },
            ],
          },
        ],
      },
      control: {
        type: 'toggle-pill-grid',
        toggles: [
          { key: 'englishNormalization', icon: 'languages', labelKey: 'generationParams.englishNormalization' },
          { key: 'aigcWatermark', icon: 'stamp', labelKey: 'generationParams.aigcWatermark' },
        ],
      },
    },
    // 13. Pronunciation dict (发音词典)
    {
      id: 'pronunciationTone',
      label: 'generationParams.pronunciationDict',
      valueKey: 'pronunciationTone',
      advanced: true,
      visibleWhen: { all: [AUDIO_MODEL, { paramsField: 'supportsPronunciationDict', op: 'truthy' }] },
      control: {
        type: 'text-input-list',
        placeholder: 'generationParams.pronunciationPlaceholder',
        addLabel: 'generationParams.addPronunciationRule',
      },
    },
  ];
}

// Apply layout to minimaxTtsParams
minimaxTtsParams.paramLayout = buildMinimaxLayout(minimaxTtsParams);

function createModel(
  modelId: string,
  name: string,
  shortName: string,
  recommended = false,
  emotions: string[] = MINIMAX_BASE_EMOTIONS,
) {
  return {
    modelId,
    name,
    shortName,
    familyId: 'minimax-tts',
    inputRequirements: minimaxTtsInputRequirements,
    params: { ...minimaxTtsParams, emotions },
    metadata: {
      ...(recommended ? { recommended: true } : {}),
      defaultVoiceId: 'female-shaonv',
      defaultSpeed: 1,
      defaultEmotion: 'calm',
      defaultAudioFormat: 'mp3',
      defaultSampleRate: '44100',
      defaultVolume: 1,
      defaultPitch: 0,
      defaultBitrate: 256000,
      defaultChannel: 1,
      defaultLanguageBoost: 'auto',
      defaultVoiceModifyPitch: 0,
      defaultVoiceModifyIntensity: 0,
      defaultVoiceModifyTimbre: 0,
      defaultVoiceModifySoundEffects: undefined,
      defaultPronunciationTone: [],
      defaultAigcWatermark: false,
      defaultEnglishNormalization: false,
    },
  };
}

export function createMinimaxTypeDefinition(): ProviderTypeDefinition {
  return {
    typeId: BUILTIN_TYPE_IDS.MINIMAX,
    name: 'MiniMax',
    providerType: 'generation',
    builtIn: true,
    description: t('generation.provider.minimaxDescription'),
    credentialFields: [
      {
        key: 'base_url',
        label: 'Base URL',
        type: 'url',
        placeholder: 'https://api.minimaxi.com',
        defaultValue: 'https://api.minimaxi.com',
        description: 'MiniMax API base URL (pure Bearer auth).',
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
        id: 'minimax-tts',
        name: 'MiniMax TTS',
        models: [
          createModel('speech-2.8-hd', 'Speech 2.8 HD', 'MiniMax', true),
          createModel('speech-2.8-turbo', 'Speech 2.8 Turbo', 'MiniMax'),
          createModel('speech-2.6-hd', 'Speech 2.6 HD', 'MiniMax', false, MINIMAX_EMOTIONS_WITH_STYLE),
          createModel('speech-2.6-turbo', 'Speech 2.6 Turbo', 'MiniMax', false, MINIMAX_EMOTIONS_WITH_STYLE),
        ],
      },
    ],
  };
}

export const minimaxTypeDefinition = createMinimaxTypeDefinition();
