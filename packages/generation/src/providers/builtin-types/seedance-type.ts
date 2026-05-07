/**
 * Seedance built-in type definition.
 *
 * Declarative blueprint for the Seedance provider, including model families,
 * variants, and their input requirements / params.
 */

import type {
  ProviderTypeDefinition,
  InputRequirements,
  CapabilityParams,
} from '@opendirector/core/types/provider-system';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import { GLOBAL_GENERATION_OPTIONS } from '@opendirector/core/types/generation';
import { t } from '@opendirector/core/i18n';

function createSeedanceInputRequirements(): InputRequirements {
  return {
    promptRequired: false,
    maxPromptLength: 2000,
    promptSuggestions: [
      {
        type: 'maxChineseChars',
        limit: 500,
        message: t('generation.provider.promptSuggestionChinese'),
      },
      {
        type: 'maxEnglishWords',
        limit: 1000,
        message: t('generation.provider.promptSuggestionEnglish'),
      },
    ],
    references: {
      image: {
        required: false,
        min: 0,
        max: 9,
        description: t('generation.provider.referenceImage'),
      },
      video: {
        required: false,
        min: 0,
        max: 3,
        description: t('generation.provider.referenceVideo'),
      },
      audio: {
        required: false,
        min: 0,
        max: 3,
        description: t('generation.provider.referenceAudio'),
      },
      maxTotal: 15,
    },
    referenceAssetConstraints: {
      image: {
        allowedFormats: [
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/bmp',
          'image/tiff',
          'image/gif',
        ],
        aspectRatioRange: { min: 0.4, max: 2.5 },
        widthRange: { min: 300, max: 6000 },
        heightRange: { min: 300, max: 6000 },
        maxFileSize: 30 * 1024 * 1024, // 30 MB
      },
      video: {
        allowedFormats: ['video/mp4', 'video/quicktime'],
        durationRange: { min: 2, max: 15 },
        maxTotalDuration: 15,
        aspectRatioRange: { min: 0.4, max: 2.5 },
        widthRange: { min: 300, max: 6000 },
        heightRange: { min: 300, max: 6000 },
        pixelCountRange: { min: 409600, max: 927408 },
        maxFileSize: 50 * 1024 * 1024, // 50 MB
        fpsRange: { min: 24, max: 60 },
      },
      audio: {
        allowedFormats: ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'],
        maxFileSize: 15 * 1024 * 1024, // 15 MB
        durationRange: { min: 2, max: 15 },
        maxTotalDuration: 15,
      },
    },
    crossConstraints: [
      {
        rule: 'require_non_audio_reference',
        message: t('generation.provider.nonAudioReferenceRequired'),
      },
    ],
  };
}

const seedanceBaseParams: CapabilityParams = {
  aspectRatios: [...GLOBAL_GENERATION_OPTIONS.aspectRatios],
  durationRange: { min: 4, max: 15, step: 1 },
  enableAudio: GLOBAL_GENERATION_OPTIONS.enableAudio,
  enableMusic: GLOBAL_GENERATION_OPTIONS.enableMusic,
  enableSubtitle: GLOBAL_GENERATION_OPTIONS.enableSubtitle,
  enableWatermark: GLOBAL_GENERATION_OPTIONS.enableWatermark,
  enableWebSearch: GLOBAL_GENERATION_OPTIONS.enableWebSearch,
};

const seedance20Params: CapabilityParams = {
  ...seedanceBaseParams,
  resolution: [...GLOBAL_GENERATION_OPTIONS.resolution],
};

const seedance20FastParams: CapabilityParams = {
  ...seedanceBaseParams,
  resolution: [...GLOBAL_GENERATION_OPTIONS.resolution].filter((r) => r !== '1080p'),
};

export function createSeedanceTypeDefinition(): ProviderTypeDefinition {
  const seedanceInputRequirements = createSeedanceInputRequirements();
  return {
    typeId: 'seedance',
    name: 'Seedance',
    providerType: 'generation',
    builtIn: true,
    description: t('generation.provider.seedanceDescription'),
    credentialFields: [
      {
        key: 'base_url',
        label: 'Base URL',
        type: 'url',
        placeholder: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
        defaultValue: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: t('generation.provider.apiKeyPlaceholder'),
      },
    ],
    modelConfigFields: [
      {
        key: 'ark_model_id',
        label: t('generation.provider.endpointModelLabel'),
        type: 'text',
      },
    ],
    modelFamilies: [
      {
        id: 'seedance-2',
        name: 'Seedance 2',
        models: [
          {
            modelId: 'seedance-2.0',
            name: 'Seedance 2.0',
            shortName: 'Seedance',
            familyId: 'seedance-2',
            inputRequirements: seedanceInputRequirements,
            params: seedance20Params,
            metadata: {
              arkModelId: 'doubao-seedance-2-0-260128',
              recommended: true,
              description: t('generation.provider.standardModelDescription'),
            },
          },
          {
            modelId: 'seedance-2.0-fast',
            name: 'Seedance 2.0 Fast',
            shortName: 'Seedance',
            familyId: 'seedance-2',
            inputRequirements: seedanceInputRequirements,
            params: seedance20FastParams,
            metadata: {
              arkModelId: 'doubao-seedance-2-0-fast-260128',
              speedFactor: 1.5,
              description: t('generation.provider.fastModelDescription'),
            },
          },
        ],
      },
    ],
  };
}

/** Volcengine asset provider type definition */
export function createVolcengineTosTypeDefinition(): ProviderTypeDefinition {
  return {
    typeId: BUILTIN_TYPE_IDS.VOLCENGINE,
    name: 'Volcengine',
    providerType: 'asset',
    builtIn: true,
    description: t('generation.provider.volcengineDescription'),
    credentialFields: [
      {
        key: 'ak',
        label: 'Access Key ID',
        type: 'text',
        required: true,
        placeholder: t('generation.provider.accessKeyPlaceholder'),
        section: 'common',
      },
      {
        key: 'sk',
        label: 'Secret Access Key',
        type: 'password',
        required: true,
        placeholder: t('generation.provider.secretKeyPlaceholder'),
        section: 'common',
      },
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: true,
        defaultValue: 'cn-beijing',
        placeholder: 'cn-beijing',
        section: 'common',
      },
      {
        key: 'tos_endpoint',
        label: 'Endpoint',
        type: 'url',
        required: false,
        defaultValue: 'https://tos-cn-beijing.volces.com',
        placeholder: 'https://tos-cn-beijing.volces.com',
        section: 'tos',
      },
      {
        key: 'tos_bucket',
        label: 'Bucket',
        type: 'text',
        required: false,
        placeholder: t('generation.provider.bucketPlaceholder'),
        section: 'tos',
      },
      {
        key: 'asset_endpoint',
        label: 'Endpoint',
        type: 'url',
        required: false,
        defaultValue: 'https://ark.cn-beijing.volcengineapi.com',
        placeholder: 'https://ark.cn-beijing.volcengineapi.com',
        section: 'asset',
      },
      {
        key: 'asset_project',
        label: t('generation.provider.assetProjectLabel'),
        type: 'text',
        required: false,
        defaultValue: 'default',
        placeholder: 'default',
        section: 'asset',
      },
      {
        key: 'asset_group_name',
        label: t('generation.provider.assetGroupNameLabel'),
        type: 'hidden',
        required: false,
        section: 'asset',
      },
      {
        key: 'asset_group_id',
        label: 'Asset Group ID',
        type: 'hidden',
        required: false,
        section: 'asset',
        description: t('generation.provider.assetGroupDescription'),
      },
    ],
    modelFamilies: [],
  };
}

export const seedanceTypeDefinition = createSeedanceTypeDefinition();
export const volcengineTosTypeDefinition = createVolcengineTosTypeDefinition();
