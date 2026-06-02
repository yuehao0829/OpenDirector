/**
 * OpenAI GPT Image built-in type definition.
 */

import type {
  CapabilityParams,
  InputRequirements,
  ProviderTypeDefinition,
} from '@opendirector/core/types/provider-system';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';

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
  enableWebSearch: false,
};

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
