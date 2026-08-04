import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const providerRegistryState = vi.hoisted(() => ({
  current: {
    get: vi.fn(),
  },
}));

const selectionState = vi.hoisted(() => ({
  current: {
    primaryType: 'fragment' as const,
    primaryIds: ['fragment-1', 'fragment-2'],
    primaryFocusId: 'fragment-2',
    clear: vi.fn(),
  },
}));

const timelineState = vi.hoisted(() => ({
  current: {
    fragments: [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        prompt: 'Fragment one',
        references: [] as never[],
        status: 'draft' as const,
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
        providerSelection: undefined as { instanceId: string; modelId: string } | undefined,
      },
      {
        id: 'fragment-2',
        trackId: 'track-1',
        start: 1_000,
        duration: 2_000,
        prompt: 'Focused fragment',
        references: [] as never[],
        status: 'draft' as const,
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
        providerSelection: undefined as { instanceId: string; modelId: string } | undefined,
      },
    ],
    tracks: [{ id: 'track-1', type: 'video', order: 0 }],
    scenes: [],
    updateFragment: vi.fn(),
    resizeFragment: vi.fn(),
    draftFragment: null,
    draftPrompt: '',
    confirmDraftFragment: vi.fn(),
    setDraftPrompt: vi.fn(),
    cancelDraftFragment: vi.fn(),
  },
}));

const assetStoreState = vi.hoisted(() => ({
  current: {
    assets: [],
    getAssetById: vi.fn(() => null),
  },
}));

type MockProviderInstance = { instanceId: string; typeId: string; displayName: string; enabled: boolean; config: Record<string, unknown>; createdAt: string; updatedAt: string };

const providerInstanceStoreState = vi.hoisted(() => ({
  current: {
    instances: [] as MockProviderInstance[],
    get: vi.fn<[string], MockProviderInstance | null>(() => null),
  },
}));

const settingsStoreState = vi.hoisted(() => ({
  current: {
    defaultGenerationParams: {
      aspectRatio: '16:9',
      resolution: '720p',
      enableAudio: true,
      enableMusic: true,
      enableSubtitle: true,
      enableWatermark: false,
      enableWebSearch: false,
    } as Record<string, unknown>,
  },
}));

const mockHelpers = vi.hoisted(() => {
  const createMockStoreHook = <T extends object>(stateRef: { current: T }) =>
    Object.assign((selector: (state: T) => unknown) => selector(stateRef.current), {
      getState: () => stateRef.current,
    });

  return { createMockStoreHook };
});

vi.mock('@opendirector/core/services/service-locator', () => ({
  getGenerationService: () => ({ submitTask: vi.fn() }),
  getProviderTypeRegistry: () => providerRegistryState.current,
}));

vi.mock('@opendirector/core/stores/assetStore', () => ({
  useAssetStore: mockHelpers.createMockStoreHook(assetStoreState),
}));

vi.mock('@opendirector/core/stores/generationStore', () => ({
  useCurrentProjectGenerations: () => [],
}));

vi.mock('@opendirector/core/stores/providerInstanceStore', () => ({
  useProviderInstanceStore: mockHelpers.createMockStoreHook(providerInstanceStoreState),
}));

vi.mock('@opendirector/core/stores/selectionStore', () => ({
  useSelectionStore: mockHelpers.createMockStoreHook(selectionState),
}));

vi.mock('@opendirector/core/stores/settingsStore', () => ({
  useSettingsStore: mockHelpers.createMockStoreHook(settingsStoreState),
}));

vi.mock('@opendirector/core/stores/timelineStore', () => ({
  useTimelineStore: mockHelpers.createMockStoreHook(timelineState),
}));

vi.mock('./PromptBuilder', () => ({
  PromptBuilder: ({ prompt }: { prompt: string }) => <div data-testid="prompt-builder">{prompt}</div>,
}));

vi.mock('./TaskOverview', () => ({
  TaskOverview: () => <div data-testid="task-overview" />,
}));

vi.mock('./InspectorHeader', () => ({
  InspectorHeader: ({
    models,
    selectedCompositeKey,
    onModelChange,
  }: {
    models: Array<{ modelId: string; instanceId: string; label: string }>;
    selectedCompositeKey: string;
    onModelChange: (modelId: string, instanceId: string) => void;
  }) => (
    <select
      data-testid="model-select"
      value={selectedCompositeKey}
      onChange={(e) => {
        const value = e.target.value;
        const model = models.find((item) => `${item.instanceId}::${item.modelId}` === value);
        if (model) onModelChange(model.modelId, model.instanceId);
      }}
    >
      {models.map((model) => (
        <option key={`${model.instanceId}::${model.modelId}`} value={`${model.instanceId}::${model.modelId}`}>
          {model.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('./GenerationParamsSection', () => ({
  GenerationParamsSection: ({ value }: { value: unknown }) => (
    <div data-testid="gen-params">{JSON.stringify(value)}</div>
  ),
}));

vi.mock('../layout/Panel', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../common/Button', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock('./ReferenceSelector', () => ({
  ReferenceSelector: () => <div data-testid="reference-selector" />,
  groupReferences: () => [],
  ASSET_TYPE_LABELS: {},
  AssetThumbnail: () => null,
  IMAGE_ROLE_LABELS: {},
}));

vi.mock('./PlaybackSourceSelector', () => ({
  PlaybackSourceSelector: () => null,
}));

import type { InputRequirements } from '@opendirector/core/types/provider-system';
import type { Reference } from '@opendirector/core/types/asset';
import { FragmentInspector } from './FragmentInspector';

/** Build a minimal fragment matching the mocked timelineStore shape. */
function makeFragment(
  id: string,
  trackId: string,
  references: Reference[],
  providerSelection?: { instanceId: string; modelId: string },
): any {
  return {
    id,
    trackId,
    start: 0,
    duration: 2_000,
    prompt: 'test',
    references,
    status: 'draft' as const,
    createdAt: new Date('2026-04-30T00:00:00.000Z'),
    updatedAt: new Date('2026-04-30T00:00:00.000Z'),
    providerSelection,
  };
}

/** Configure a single model + instance + fragment so currentModel resolves. */
function setupModelFragment(opts: {
  trackType: 'video' | 'audio';
  typeId: string;
  modelId: string;
  outputType: 'video' | 'image' | 'audio';
  inputRequirements?: InputRequirements;
  references?: Reference[];
}) {
  timelineState.current.tracks = [{ id: 'track-1', type: opts.trackType, order: 0 }];
  providerRegistryState.current.get.mockImplementation((typeId: string) => {
    if (typeId !== opts.typeId) return undefined;
    return {
      typeId: opts.typeId,
      providerType: 'generation',
      modelFamilies: [{
        id: 'fam',
        name: 'Fam',
        models: [{
          modelId: opts.modelId,
          name: opts.modelId,
          inputRequirements: opts.inputRequirements,
          params: { outputType: opts.outputType },
        }],
      }],
    };
  });
  providerInstanceStoreState.current.instances = [{
    instanceId: 'inst-1',
    typeId: opts.typeId,
    displayName: 'Inst',
    enabled: true,
    config: {},
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  }];
  timelineState.current.fragments = [
    makeFragment('fragment-2', 'track-1', opts.references ?? [], { instanceId: 'inst-1', modelId: opts.modelId }),
  ];
}

/** Full MiniMax model mock (params + metadata) for default-param tests. */
const MINIMAX_MODEL = {
  modelId: 'speech-2.8-hd',
  name: 'Speech 2.8 HD',
  inputRequirements: { promptRequired: true, references: { image: { required: false, min: 0, max: 0 }, video: { required: false, min: 0, max: 0 }, audio: { required: false, min: 0, max: 0 }, maxTotal: 0 } },
  params: {
    outputType: 'audio',
    voiceIds: [{ value: 'female-shaonv', label: '少女' }, { value: 'male-qn-qingse', label: '青涩' }],
    emotions: ['happy', 'sad', 'calm'],
    audioFormats: ['mp3', 'wav', 'pcm', 'flac', 'opus'],
    sampleRateByFormat: { opus: ['8000', '16000', '24000', '48000'], default: ['8000', '16000', '22050', '24000', '32000', '44100'] },
    speedRange: { min: 0.5, max: 2, step: 0.1 },
    volumeRange: { min: 0.1, max: 10, step: 0.1 },
    pitchRange: { min: -12, max: 12, step: 1 },
    bitrates: [32000, 64000, 128000, 256000],
    channels: [1, 2],
    languageBoostOptions: ['auto', 'Chinese'],
    supportsPronunciationDict: true,
    supportsAigcWatermark: true,
    supportsEnglishNormalization: true,
  },
  metadata: {
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
  },
};

/** Full SeedAudio model mock — voiceIds empty, defaultSpeed=0, defaultSampleRate=24000. */
const SEEDAUDIO_MODEL = {
  modelId: 'seed-audio-1.0',
  name: 'SeedAudio 1.0',
  inputRequirements: { promptRequired: true, references: { image: { required: false, min: 0, max: 1 }, video: { required: false, min: 0, max: 0 }, audio: { required: false, min: 0, max: 1 }, maxTotal: 1 } },
  params: {
    outputType: 'audio',
    voiceIds: [],
    audioFormats: ['wav', 'mp3', 'pcm', 'ogg_opus'],
    sampleRateByFormat: { ogg_opus: ['8000', '16000', '24000', '48000'], default: ['8000', '16000', '24000', '32000', '44100', '48000'] },
    speedRange: { min: -50, max: 100, step: 1 },
    volumeRange: { min: -50, max: 100, step: 1 },
    pitchRange: { min: -12, max: 12, step: 1 },
  },
  metadata: {
    defaultVoiceId: '',
    defaultSpeed: 0,
    defaultAudioFormat: 'mp3',
    defaultSampleRate: '24000',
    defaultVolume: 0,
    defaultPitch: 0,
  },
};

describe('FragmentInspector', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    providerRegistryState.current.get.mockReset();
    providerRegistryState.current.get.mockImplementation(() => undefined);

    providerInstanceStoreState.current.instances = [];
    providerInstanceStoreState.current.get.mockReset();
    providerInstanceStoreState.current.get.mockImplementation((instanceId: string) =>
      providerInstanceStoreState.current.instances.find((inst) => inst.instanceId === instanceId) ?? null
    );

    timelineState.current.fragments = [
      {
        id: 'fragment-1',
        trackId: 'track-1',
        start: 0,
        duration: 1_000,
        prompt: 'Fragment one',
        references: [],
        status: 'draft' as const,
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
        providerSelection: undefined,
      },
      {
        id: 'fragment-2',
        trackId: 'track-1',
        start: 1_000,
        duration: 2_000,
        prompt: 'Focused fragment',
        references: [],
        status: 'draft' as const,
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
        providerSelection: undefined,
      },
    ];
    timelineState.current.updateFragment.mockReset();
    timelineState.current.updateFragment.mockImplementation((id: string, updates: Record<string, unknown>) => {
      timelineState.current.fragments = timelineState.current.fragments.map((fragment) =>
        fragment.id === id
          ? { ...fragment, ...updates, updatedAt: new Date('2026-05-02T00:00:00.000Z') }
          : fragment
      );
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows the focused fragment while preserving a multi-selection', async () => {
    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="fragment-inspector"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-overview"]')).toBeNull();
    expect(container.querySelector('[data-testid="prompt-builder"]')?.textContent).toContain('Focused fragment');
  });

  it('updates the selected model from the fragment inspector dropdown', async () => {
    providerRegistryState.current.get.mockImplementation((typeId: string) => {
      if (typeId !== 'seedance') return undefined;
      return {
        typeId: 'seedance',
        providerType: 'generation',
        modelFamilies: [
          {
            id: 'seedance-2',
            name: 'Seedance 2',
            models: [
              {
                modelId: 'seedance-2.0',
                name: 'Seedance 2.0',
                inputRequirements: { promptRequired: true, references: { image: { required: false, min: 0, max: 9 }, video: { required: false, min: 0, max: 3 }, audio: { required: false, min: 0, max: 3 }, maxTotal: 15 } },
                params: { resolution: ['480p', '720p', '1080p'], outputType: 'video' },
              },
              {
                modelId: 'seedance-2.0-fast',
                name: 'Seedance 2.0 Fast',
                inputRequirements: { promptRequired: true, references: { image: { required: false, min: 0, max: 9 }, video: { required: false, min: 0, max: 3 }, audio: { required: false, min: 0, max: 3 }, maxTotal: 15 } },
                params: { resolution: ['480p', '720p'], outputType: 'video' },
              },
            ],
          },
        ],
      };
    });

    providerInstanceStoreState.current.instances = [
      {
        instanceId: 'seedance-1',
        typeId: 'seedance',
        displayName: 'Seedance',
        enabled: true,
        config: {},
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z',
      },
    ];

    timelineState.current.fragments = timelineState.current.fragments.map((fragment) =>
      fragment.id === 'fragment-2'
        ? {
            ...fragment,
            providerSelection: { instanceId: 'seedance-1', modelId: 'seedance-2.0' },
          }
        : fragment
    );

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    const select = container.querySelector('select') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select?.value).toBe('seedance-1::seedance-2.0');

    await act(async () => {
      if (!select) return;
      select.value = 'seedance-1::seedance-2.0-fast';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(timelineState.current.fragments.find((fragment) => fragment.id === 'fragment-2')?.providerSelection).toEqual({
      instanceId: 'seedance-1',
      modelId: 'seedance-2.0-fast',
    });

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect((container.querySelector('select') as HTMLSelectElement | null)?.value).toBe('seedance-1::seedance-2.0-fast');
  });

  // ── Reference panel visibility (SeedAudio reference audio/image integration) ──
  it('shows the reference panel for an audio fragment whose model supports references (SeedAudio)', async () => {
    setupModelFragment({
      trackType: 'audio',
      typeId: 'seed-audio',
      modelId: 'seed-audio-1.0',
      outputType: 'audio',
      inputRequirements: {
        promptRequired: true,
        references: {
          image: { required: false, min: 0, max: 1 },
          video: { required: false, min: 0, max: 0 },
          audio: { required: false, min: 0, max: 1 },
          maxTotal: 1,
        },
      },
    });

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="reference-selector"]')).not.toBeNull();
  });

  it('shows the reference panel for a video fragment with a Seedance model (regression guard)', async () => {
    setupModelFragment({
      trackType: 'video',
      typeId: 'seedance',
      modelId: 'seedance-2.0',
      outputType: 'video',
      inputRequirements: {
        promptRequired: true,
        references: {
          image: { required: false, min: 0, max: 9 },
          video: { required: false, min: 0, max: 3 },
          audio: { required: false, min: 0, max: 3 },
          maxTotal: 15,
        },
      },
    });

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="reference-selector"]')).not.toBeNull();
  });

  it('hides the reference panel for an audio model with no reference support (MiniMax)', async () => {
    setupModelFragment({
      trackType: 'audio',
      typeId: 'minimax',
      modelId: 'speech-02',
      outputType: 'audio',
      inputRequirements: {
        promptRequired: true,
        references: {
          image: { required: false, min: 0, max: 0 },
          video: { required: false, min: 0, max: 0 },
          audio: { required: false, min: 0, max: 0 },
          maxTotal: 0,
        },
      },
    });

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="reference-selector"]')).toBeNull();
  });

  it('hides the reference panel for an image model with no reference support (GPT-Image)', async () => {
    setupModelFragment({
      trackType: 'video',
      typeId: 'openai-image',
      modelId: 'gpt-image-2',
      outputType: 'image',
      inputRequirements: {
        promptRequired: true,
        references: {
          image: { required: false, min: 0, max: 0 },
          video: { required: false, min: 0, max: 0 },
          audio: { required: false, min: 0, max: 0 },
          maxTotal: 0,
        },
      },
    });

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="reference-selector"]')).toBeNull();
  });

  it('keeps the reference panel visible for existing refs after switching to an unsupported model (escape hatch)', async () => {
    setupModelFragment({
      trackType: 'video',
      typeId: 'openai-image',
      modelId: 'gpt-image-2',
      outputType: 'image',
      inputRequirements: {
        promptRequired: true,
        references: {
          image: { required: false, min: 0, max: 0 },
          video: { required: false, min: 0, max: 0 },
          audio: { required: false, min: 0, max: 0 },
          maxTotal: 0,
        },
      },
      references: [
        { id: 'ref-1', assetId: 'asset-1', type: 'image', role: 'reference_image' } as Reference,
      ],
    });

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="reference-selector"]')).not.toBeNull();
  });

  it('falls back to track type when no model is selected: video track shows the panel', async () => {
    timelineState.current.tracks = [{ id: 'track-1', type: 'video', order: 0 }];
    timelineState.current.fragments = [makeFragment('fragment-2', 'track-1', [])];

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="reference-selector"]')).not.toBeNull();
  });

  it('falls back to track type when no model is selected: audio track hides the panel', async () => {
    timelineState.current.tracks = [{ id: 'track-1', type: 'audio', order: 0 }];
    timelineState.current.fragments = [makeFragment('fragment-2', 'track-1', [])];

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="reference-selector"]')).toBeNull();
  });

  // ── Audio model default gen params ──
  it('applies MiniMax default gen params when MiniMax is selected on a new audio fragment', async () => {
    providerRegistryState.current.get.mockImplementation((typeId: string) => {
      if (typeId !== 'minimax') return undefined;
      return { typeId: 'minimax', providerType: 'generation', modelFamilies: [{ id: 'minimax-tts', name: 'MiniMax TTS', models: [MINIMAX_MODEL] }] };
    });
    providerInstanceStoreState.current.instances = [{ instanceId: 'minimax-1', typeId: 'minimax', displayName: 'MiniMax', enabled: true, config: {}, createdAt: '', updatedAt: '' }];
    timelineState.current.tracks = [{ id: 'track-1', type: 'audio', order: 0 }];
    timelineState.current.fragments = [makeFragment('fragment-2', 'track-1', [], { instanceId: 'minimax-1', modelId: 'speech-2.8-hd' })];

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    const genParams = JSON.parse(container.querySelector('[data-testid="gen-params"]')?.textContent ?? '{}');
    expect(genParams.voiceId).toBe('female-shaonv');
    expect(genParams.emotion).toBe('calm');
    expect(genParams.audioFormat).toBe('mp3');
    expect(genParams.sampleRate).toBe('44100');
    expect(genParams.speed).toBe(1);
  });

  it('re-applies MiniMax defaults after switching from SeedAudio (no stale SeedAudio defaults)', async () => {
    providerRegistryState.current.get.mockImplementation((typeId: string) => {
      if (typeId === 'seed-audio') return { typeId: 'seed-audio', providerType: 'generation', modelFamilies: [{ id: 'seedaudio-tts', name: 'SeedAudio', models: [SEEDAUDIO_MODEL] }] };
      if (typeId === 'minimax') return { typeId: 'minimax', providerType: 'generation', modelFamilies: [{ id: 'minimax-tts', name: 'MiniMax', models: [MINIMAX_MODEL] }] };
      return undefined;
    });
    providerInstanceStoreState.current.instances = [
      { instanceId: 'seedaudio-1', typeId: 'seed-audio', displayName: 'SeedAudio', enabled: true, config: {}, createdAt: '', updatedAt: '' },
      { instanceId: 'minimax-1', typeId: 'minimax', displayName: 'MiniMax', enabled: true, config: {}, createdAt: '', updatedAt: '' },
    ];
    timelineState.current.tracks = [{ id: 'track-1', type: 'audio', order: 0 }];
    // Start with SeedAudio selected.
    timelineState.current.fragments = [makeFragment('fragment-2', 'track-1', [], { instanceId: 'seedaudio-1', modelId: 'seed-audio-1.0' })];

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    // Switch to MiniMax.
    await act(async () => {
      timelineState.current.fragments = [makeFragment('fragment-2', 'track-1', [], { instanceId: 'minimax-1', modelId: 'speech-2.8-hd' })];
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    const genParams = JSON.parse(container.querySelector('[data-testid="gen-params"]')?.textContent ?? '{}');
    expect(genParams.voiceId).toBe('female-shaonv');
    expect(genParams.speed).toBe(1); // SeedAudio defaultSpeed=0 → must become MiniMax 1
    expect(genParams.sampleRate).toBe('44100'); // SeedAudio 24000 → must become MiniMax 44100
  });

  it('overwrites stale persisted audio defaults (speed=0/volume=0) with model defaults', async () => {
    // Simulate localStorage persist residue from an older version: defaultGenerationParams
    // carries stale audio fields (speed=0, volume=0). New fragments inherit these via
    // getDefaultGenParams() = {...defaultGenerationParams}, so prev.speed=0 (not undefined).
    // useEffect 358 must still reset out-of-range values to the model's defaults.
    settingsStoreState.current.defaultGenerationParams = {
      ...settingsStoreState.current.defaultGenerationParams,
      speed: 0,
      volume: 0,
      pitch: 0,
    };
    providerRegistryState.current.get.mockImplementation((typeId: string) => {
      if (typeId !== 'minimax') return undefined;
      return { typeId: 'minimax', providerType: 'generation', modelFamilies: [{ id: 'minimax-tts', name: 'MiniMax TTS', models: [MINIMAX_MODEL] }] };
    });
    providerInstanceStoreState.current.instances = [{ instanceId: 'minimax-1', typeId: 'minimax', displayName: 'MiniMax', enabled: true, config: {}, createdAt: '', updatedAt: '' }];
    timelineState.current.tracks = [{ id: 'track-1', type: 'audio', order: 0 }];
    timelineState.current.fragments = [makeFragment('fragment-2', 'track-1', [], { instanceId: 'minimax-1', modelId: 'speech-2.8-hd' })];

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    const genParams = JSON.parse(container.querySelector('[data-testid="gen-params"]')?.textContent ?? '{}');
    expect(genParams.speed).toBe(1);  // MiniMax defaultSpeed=1, not stale 0
    expect(genParams.volume).toBe(1); // MiniMax defaultVolume=1, not stale 0
  });

  it('applies MiniMax defaults on a brand-new audio fragment (empty providerSelection)', async () => {
    // Real "create audio fragment" scenario: providerSelection is empty, so
    // resolvedModelSelection auto-picks filteredModels[0] (speech-2.8-hd).
    providerRegistryState.current.get.mockImplementation((typeId: string) => {
      if (typeId !== 'minimax') return undefined;
      return { typeId: 'minimax', providerType: 'generation', modelFamilies: [{ id: 'minimax-tts', name: 'MiniMax TTS', models: [MINIMAX_MODEL] }] };
    });
    providerInstanceStoreState.current.instances = [{ instanceId: 'minimax-1', typeId: 'minimax', displayName: 'MiniMax', enabled: true, config: {}, createdAt: '', updatedAt: '' }];
    timelineState.current.tracks = [{ id: 'track-1', type: 'audio', order: 0 }];
    timelineState.current.fragments = [makeFragment('fragment-2', 'track-1', [])];

    await act(async () => {
      root.render(<FragmentInspector />);
      await Promise.resolve();
    });

    const genParams = JSON.parse(container.querySelector('[data-testid="gen-params"]')?.textContent ?? '{}');
    expect(genParams.voiceId).toBe('female-shaonv');
    expect(genParams.emotion).toBe('calm');
    expect(genParams.audioFormat).toBe('mp3');
    expect(genParams.sampleRate).toBe('44100');
    expect(genParams.speed).toBe(1);
    expect(genParams.volume).toBe(1);
  });
});
