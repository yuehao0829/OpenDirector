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
        references: [],
        status: 'draft',
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
      },
      {
        id: 'fragment-2',
        trackId: 'track-1',
        start: 1_000,
        duration: 2_000,
        prompt: 'Focused fragment',
        references: [],
        status: 'draft',
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
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

const providerInstanceStoreState = vi.hoisted(() => ({
  current: {
    instances: [],
    get: vi.fn(() => null),
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
    },
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
  GenerationParamsSection: () => null,
}));

vi.mock('../layout/Panel', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../common/Button', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock('./ReferenceSelector', () => ({
  ReferenceSelector: () => null,
  groupReferences: () => [],
  ASSET_TYPE_LABELS: {},
  AssetThumbnail: () => null,
  IMAGE_ROLE_LABELS: {},
}));

vi.mock('./PlaybackSourceSelector', () => ({
  PlaybackSourceSelector: () => null,
}));

import { FragmentInspector } from './FragmentInspector';

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
        status: 'draft',
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
      },
      {
        id: 'fragment-2',
        trackId: 'track-1',
        start: 1_000,
        duration: 2_000,
        prompt: 'Focused fragment',
        references: [],
        status: 'draft',
        createdAt: new Date('2026-04-30T00:00:00.000Z'),
        updatedAt: new Date('2026-04-30T00:00:00.000Z'),
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
              { modelId: 'seedance-2.0', name: 'Seedance 2.0', params: { resolution: ['480p', '720p', '1080p'] } },
              { modelId: 'seedance-2.0-fast', name: 'Seedance 2.0 Fast', params: { resolution: ['480p', '720p'] } },
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
});
