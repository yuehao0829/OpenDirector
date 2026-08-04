import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationParams } from '@opendirector/core/types/generation';
import type { InputRequirements } from '@opendirector/core/types/provider-system';
import { providerRuntimeRegistry } from '../../providers/runtime-registry';

// Mutable holders shared with the hoisted mock factories. vi.hoisted runs
// before vi.mock factories, so the factories can close over these.
const { assetState, providerState, startGenMock, failGenMock, resetMock, updateFragMock, autoProcessMock, fsState } = vi.hoisted(() => ({
  assetState: { assets: [] as unknown[] },
  providerState: { defaultAssetProvider: undefined as unknown, tosProvider: undefined as unknown },
  startGenMock: vi.fn(async () => {}),
  failGenMock: vi.fn(async () => true),
  resetMock: vi.fn(),
  updateFragMock: vi.fn(),
  autoProcessMock: vi.fn(async () => ({ assetIdMap: new Map<string, string>(), newAssets: [] as unknown[] })),
  fsState: { fs: null as unknown },
}));

vi.mock('@opendirector/core/services/tauri-bridge', () => ({
  tauriBridge: {
    seedaudioTtsApi: {
      startGeneration: startGenMock,
      cancelGeneration: vi.fn(async () => true),
      resumeGeneration: vi.fn(async () => true),
    },
  },
}));
vi.mock('@opendirector/core/stores/assetStore', () => ({
  useAssetStore: { getState: () => ({ assets: assetState.assets, addAsset: vi.fn() }) },
}));
vi.mock('@opendirector/core/stores/generationStore', () => ({
  useGenerationStore: { getState: () => ({ addGeneration: vi.fn(), updateGeneration: vi.fn() }) },
}));
vi.mock('@opendirector/core/stores/projectStore', () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: 'p1', folderPath: '/proj' } }) },
}));
vi.mock('@opendirector/core/stores/providerInstanceStore', () => ({
  useProviderInstanceStore: { getState: () => ({ get: () => ({ displayName: 'SA', config: {} }) }) },
}));
vi.mock('@opendirector/core/stores/timelineStore', () => ({
  useTimelineStore: { getState: () => ({ updateFragment: updateFragMock }) },
}));
// Auto-process path: return no fs so the auto-process block is skipped (we test
// the TOS / base64 decision in isolation).
vi.mock('@opendirector/core/adapters', () => ({ getPlatformAdapter: vi.fn(async () => ({ fs: fsState.fs })) }));
vi.mock('@opendirector/core/services/reference-auto-processor', () => ({
  autoProcessReferences: autoProcessMock,
}));
vi.mock('@opendirector/core/i18n', () => ({ t: (k: string) => k }));
vi.mock('@opendirector/core/utils/common', () => ({ getErrorMessage: (e: unknown) => String(e) }));
vi.mock('@opendirector/core/utils/id', () => ({ generateId: vi.fn(() => 'task-1') }));
vi.mock('../../providers/runtime-registry', () => ({
  resolveDefaultAssetProvider: () => providerState.defaultAssetProvider,
  providerRuntimeRegistry: { getOrInitializeAssetProvider: vi.fn(async () => providerState.tosProvider) },
}));
vi.mock('../../providers/type-registry', () => ({
  providerTypeRegistry: { findModelVariant: vi.fn(() => ({ name: 'SeedAudio' })) },
}));
vi.mock('../generation-xml-repository', () => ({
  updateGenerationsXml: vi.fn(async () => {}),
  resolveFragmentContext: vi.fn(() => ({ fragmentName: 'frag' })),
  buildProviderParams: vi.fn(() => ({ model: 'seed-audio-1.0' })),
  getProviderPassword: vi.fn(() => 'pwd'),
  resolveLocalFilePath: vi.fn((assetId: string) => `/proj/${assetId}.wav`),
}));
vi.mock('../fragment-utils', () => ({ resetFragmentIfGenerating: resetMock }));
vi.mock('../store-sync', () => ({ failGeneration: failGenMock }));
vi.mock('../task-log', () => ({ taskLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Import the SUT AFTER all mocks are registered.
import { seedaudioController } from './seedaudio-controller';

function makeParams(over: Partial<GenerationParams>): GenerationParams {
  return {
    prompt: 'hello',
    references: [],
    voiceId: '',
    audioFormat: 'mp3',
    sampleRate: '24000',
    speed: 0,
    volume: 0,
    pitch: 0,
    ...over,
  } as GenerationParams;
}

const audioRef = (id: string, assetId: string) => ({ id, assetId, type: 'audio' as const });
const imageRef = (id: string, assetId: string) => ({ id, assetId, type: 'image' as const });

async function start(params: GenerationParams, inputRequirements?: InputRequirements): Promise<string> {
  // Populate the asset store with the referenced asset ids so the controller's
  // asset-existence guard (F5) can resolve them. resolveLocalFilePath is also
  // mocked to return /proj/<assetId>.wav for any id.
  assetState.assets = params.references.map((r) => ({ id: r.assetId }));
  return seedaudioController.start({
    fragmentId: 'frag-1',
    instanceId: 'inst-1',
    modelId: 'seed-audio-1.0',
    params,
    instance: { displayName: 'SA', config: {} } as never,
    options: inputRequirements ? { inputRequirements } : undefined,
  });
}

/** Read the `references` array passed to the most recent startGeneration call. */
function lastReferences(): unknown {
  const calls = startGenMock.mock.calls as unknown as Array<[{ references: unknown }]>;
  return calls[calls.length - 1][0].references;
}

describe('seedaudioController.start — reference pipeline', () => {
  beforeEach(() => {
    startGenMock.mockClear();
    failGenMock.mockClear();
    resetMock.mockClear();
    autoProcessMock.mockClear();
    assetState.assets = [];
    providerState.defaultAssetProvider = undefined;
    providerState.tosProvider = undefined;
    fsState.fs = null;
  });

  it('uploads multiple audio refs to TOS and passes audio_url entries in @音频N order', async () => {
    // Audio refs default to TOS (audio_url) when an asset provider is
    // configured — `audio_url` is a documented SeedAudio reference field.
    providerState.defaultAssetProvider = { instanceId: 'vol-1' };
    providerState.tosProvider = {
      uploadLocalFile: vi.fn(async (p: string) => ({ presignedUrl: `tos://${p}` })),
    };

    await start(makeParams({ references: [audioRef('r1', 'a1'), audioRef('r2', 'a2')] }));

    expect(startGenMock).toHaveBeenCalledTimes(1);
    expect(lastReferences()).toEqual([
      { audio_url: 'tos:///proj/a1.wav' },
      { audio_url: 'tos:///proj/a2.wav' },
    ]);
  });

  it('falls back to audio_file_path (base64 inline) when no asset provider is configured', async () => {
    await start(makeParams({ references: [audioRef('r1', 'a1')] }));

    expect(startGenMock).toHaveBeenCalledTimes(1);
    expect(lastReferences()).toEqual([{ audio_file_path: '/proj/a1.wav' }]);
  });

  it('uses image_url via TOS for an image reference', async () => {
    providerState.defaultAssetProvider = { instanceId: 'vol-1' };
    providerState.tosProvider = {
      uploadLocalFile: vi.fn(async (p: string) => ({ presignedUrl: `tos://${p}` })),
    };

    await start(makeParams({ references: [imageRef('r1', 'a1')] }));

    expect(lastReferences()).toEqual([{ image_url: 'tos:///proj/a1.wav' }]);
  });

  it('honours priority audio > image > speaker', async () => {
    // audio beats voiceId
    await start(makeParams({ references: [audioRef('r1', 'a1')], voiceId: 'voice-9' }));
    expect(lastReferences()).toEqual([{ audio_file_path: '/proj/a1.wav' }]);

    // image beats voiceId
    await start(makeParams({ references: [imageRef('r1', 'a1')], voiceId: 'voice-9' }));
    expect(lastReferences()).toEqual([{ image_file_path: '/proj/a1.wav' }]);

    // voiceId only → speaker
    await start(makeParams({ references: [], voiceId: 'voice-9' }));
    expect(lastReferences()).toEqual([{ speaker: 'voice-9' }]);

    // nothing → empty (pure-text)
    await start(makeParams({ references: [], voiceId: '' }));
    expect(lastReferences()).toEqual([]);
  });

  it('aborts with failGeneration (no startGeneration) when an audio TOS upload fails', async () => {
    // Audio refs use the TOS path when a provider is configured, so a TOS
    // upload failure is reachable via an audio reference.
    providerState.defaultAssetProvider = { instanceId: 'vol-1' };
    providerState.tosProvider = {
      uploadLocalFile: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    await start(makeParams({ references: [audioRef('r1', 'a1')] }));

    expect(startGenMock).not.toHaveBeenCalled();
    expect(failGenMock).toHaveBeenCalledTimes(1);
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to audio base64 when TOS asset provider init THROWS (not hard-fail)', async () => {
    // F2: an init throw (bad credentials / module load error) must degrade to the
    // base64 inline path, not hard-fail the task. Audio refs are the TOS path now.
    providerState.defaultAssetProvider = { instanceId: 'vol-1' };
    vi.mocked(providerRuntimeRegistry.getOrInitializeAssetProvider).mockRejectedValueOnce(new Error('init boom'));

    await start(makeParams({ references: [audioRef('r1', 'a1')] }));

    expect(startGenMock).toHaveBeenCalledTimes(1);
    expect(lastReferences()).toEqual([{ audio_file_path: '/proj/a1.wav' }]);
    expect(failGenMock).not.toHaveBeenCalled();
  });

  it('fails with asset-not-found when a reference asset is missing from the store', async () => {
    // F5: a missing asset must surface a clear "asset not found" error, not let
    // the raw assetId (UUID) slip through as a file path.
    assetState.assets = [];
    await seedaudioController.start({
      fragmentId: 'frag-1',
      instanceId: 'inst-1',
      modelId: 'seed-audio-1.0',
      params: makeParams({ references: [audioRef('r1', 'a1')] }),
      instance: { displayName: 'SA', config: {} } as never,
    });

    expect(startGenMock).not.toHaveBeenCalled();
    expect(failGenMock).toHaveBeenCalledTimes(1);
    const errorMsg = (failGenMock.mock.calls[0] as unknown[])[1] as string;
    expect(errorMsg).toContain('reference audio asset');
  });

  it('invokes autoProcessReferences when inputRequirements + fs are available', async () => {
    // #14: the auto-process path (compress/transcode over-limit refs) was
    // previously untested because start() never passed inputRequirements. With
    // a non-null fs and inputRequirements present, the controller must call
    // autoProcessReferences before resolving references.
    fsState.fs = {} as never;
    autoProcessMock.mockClear();
    const req: InputRequirements = {
      promptRequired: true,
      references: {
        image: { required: false, min: 0, max: 1 },
        video: { required: false, min: 0, max: 0 },
        audio: { required: false, min: 0, max: 3 },
        maxTotal: 3,
      },
      referenceAssetConstraints: {
        audio: { allowedFormats: ['audio/wav'], maxFileSize: 10 * 1024 * 1024 },
      },
    };
    await start(makeParams({ references: [audioRef('r1', 'a1')] }), req);
    expect(autoProcessMock).toHaveBeenCalledTimes(1);
    expect(startGenMock).toHaveBeenCalledTimes(1);
  });

  it('skips autoProcessReferences when inputRequirements are absent', async () => {
    fsState.fs = {} as never;
    autoProcessMock.mockClear();
    await start(makeParams({ references: [audioRef('r1', 'a1')] }));
    expect(autoProcessMock).not.toHaveBeenCalled();
    expect(startGenMock).toHaveBeenCalledTimes(1);
  });
});
