/**
 * OpenAI GPT Image built-in type definition.
 */

import type {
  CapabilityParams,
  InputRequirements,
  ProviderTypeDefinition,
} from '@opendirector/core/types/provider-system';
import { BUILTIN_TYPE_IDS, isImageModel } from '@opendirector/core/types/provider-system';
import type { ParamLayoutItem } from '@opendirector/core/types/param-layout';
import { formatAsString, formatAsUpperCase } from '@opendirector/core/types/param-layout';

const gptImageInputRequirements: InputRequirements = {
  promptRequired: true,
  maxPromptLength: 32000,
  references: {
    image: {
      required: false,
      min: 0,
      max: 0,
      description: 'Image references are not supported by this generator yet.',
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

const gptImage2Params: CapabilityParams = {
  outputType: 'image',
  resolution: ['720p', '1080p', '2k', '4k'],
  aspectRatios: ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', 'adaptive'],
  imageQuality: ['auto', 'low', 'medium', 'high'],
  imageOutputFormats: ['png', 'jpeg', 'webp'],
  imageBackgrounds: ['auto', 'transparent', 'opaque'],
  enableAudio: false,
  enableMusic: false,
  enableSubtitle: false,
  enableWatermark: false,
};

/** Build the GPT Image declarative parameter layout. */
function buildGptImageLayout(): ParamLayoutItem[] {
  return [
    // 1. Resolution
    {
      id: 'resolution',
      label: 'settings.generationDefaults.resolution',
      valueKey: 'resolution',
      summaryIcon: 'monitor',
      summaryFormat: formatAsString,
      visibleWhen: (p) => isImageModel(p) && !!p.resolution?.length,
      control: {
        type: 'button-group',
        options: [],
        optionsFrom: 'resolution',
        buttonSize: 'md',
      },
    },
    // 2. Aspect ratio
    {
      id: 'aspectRatio',
      label: 'settings.generationDefaults.aspectRatio',
      valueKey: 'aspectRatio',
      summaryIcon: 'rectangle-horizontal',
      summaryFormat: formatAsString,
      visibleWhen: (p) => isImageModel(p) && !!p.aspectRatios?.length,
      control: {
        type: 'button-group',
        options: [],
        optionsFrom: 'aspectRatios',
        flexibleWidth: true,
        extraWideValue: 'adaptive',
        buttonClassName: 'px-1 py-2 text-sm',
      },
    },
    // 3. Image quality
    {
      id: 'imageQuality',
      label: 'generationParams.imageQuality',
      valueKey: 'imageQuality',
      summaryFormat: formatAsString,
      visibleWhen: (p) => isImageModel(p) && !!p.imageQuality?.length,
      control: {
        type: 'button-group',
        options: [],
        optionsFrom: 'imageQuality',
      },
    },
    // 4. Image output format
    {
      id: 'imageOutputFormat',
      label: 'generationParams.imageOutputFormat',
      valueKey: 'imageOutputFormat',
      summaryFormat: formatAsUpperCase,
      visibleWhen: (p) => isImageModel(p) && !!p.imageOutputFormats?.length,
      adjustOnChange: (newVal) => {
        // JPEG doesn't support transparent background — auto-correct
        if (newVal.imageOutputFormat === 'jpeg' && newVal.imageBackground === 'transparent') {
          return { ...newVal, imageBackground: 'auto' };
        }
        return newVal;
      },
      control: {
        type: 'button-group',
        options: [],
        optionsFrom: 'imageOutputFormats',
        uppercase: true,
      },
    },
    // 5. Image background
    {
      id: 'imageBackground',
      label: 'generationParams.imageBackground',
      valueKey: 'imageBackground',
      summaryFormat: formatAsString,
      visibleWhen: (p) => isImageModel(p) && !!p.imageBackgrounds?.length,
      adjustOnChange: (newVal) => {
        // Transparent background requires png/webp — auto-correct
        if (newVal.imageBackground === 'transparent' && newVal.imageOutputFormat === 'jpeg') {
          return { ...newVal, imageOutputFormat: 'png' };
        }
        return newVal;
      },
      control: {
        type: 'button-group',
        options: [],
        optionsFrom: 'imageBackgrounds',
      },
    },
    // 6. Image output compression (only for jpeg/webp)
    {
      id: 'imageOutputCompression',
      label: 'generationParams.imageOutputCompression',
      valueKey: 'imageOutputCompression',
      summaryFormat: (v) => `${v}%`,
      visibleWhen: (p, v) => isImageModel(p) && (v.imageOutputFormat === 'jpeg' || v.imageOutputFormat === 'webp'),
      control: {
        type: 'slider',
        min: 0,
        max: 100,
        step: 1,
        valueFormat: (v) => `${v}%`,
        decimals: 0,
      },
    },
  ];
}

// Apply layout to gptImage2Params
gptImage2Params.paramLayout = buildGptImageLayout();

export function createGptImageTypeDefinition(): ProviderTypeDefinition {
  return {
    typeId: BUILTIN_TYPE_IDS.OPENAI_IMAGE,
    name: 'GPT Image',
    providerType: 'generation',
    builtIn: true,
    description: 'OpenAI GPT image generation',
    credentialFields: [
      {
        key: 'base_url',
        label: 'Endpoint URL',
        type: 'url',
        placeholder: 'https://api.openai.com/v1/images/generations',
        defaultValue: 'https://api.openai.com/v1/images/generations',
        description: 'OpenAI-compatible endpoint, or a third-party proxy URL.',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'API Key',
      },
      {
        key: 'auth_mode',
        label: 'Auth Mode',
        type: 'select',
        defaultValue: 'bearer',
        advanced: true,
        options: [
          { value: 'bearer', label: 'Bearer Token' },
          { value: 'query_param', label: 'Query Parameter' },
        ],
        description:
          'Bearer: API key sent in Authorization header. Query Parameter: API key appended to URL as a query string.',
      },
      {
        key: 'auth_query_key',
        label: 'Query Key',
        type: 'text',
        defaultValue: 'ak',
        advanced: true,
        placeholder: 'ak',
        description: 'Query parameter name for the API key (only used when Auth Mode is Query Parameter).',
      },
    ],
    modelFamilies: [
      {
        id: 'gpt-image',
        name: 'GPT Image',
        models: [
          {
            modelId: 'gpt-image-2',
            name: 'GPT Image 2',
            shortName: 'GPT Image',
            familyId: 'gpt-image',
            inputRequirements: gptImageInputRequirements,
            params: gptImage2Params,
            metadata: {
              recommended: true,
              defaultQuality: 'high',
              defaultOutputFormat: 'jpeg',
              defaultBackground: 'opaque',
              defaultModeration: 'low',
            },
          },
        ],
      },
    ],
  };
}

export const gptImageTypeDefinition = createGptImageTypeDefinition();
