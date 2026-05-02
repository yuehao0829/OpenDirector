import { create } from 'zustand';
import { Generation, isActiveGenerationStatus } from '../types';
import type { GenerationRecord } from '../utils/xml';
import { recordToGeneration } from '../utils/xml';
import { getGenerationTimestamp } from '../utils/time';
import { useProjectStore } from './projectStore';

interface GenerationState {
  // Generation records (persistent)
  generations: Generation[];

  // Generation actions
  loadGenerationsFromXml: (projectId: string, records: GenerationRecord[]) => void;
  addGeneration: (generation: Generation) => void;
  updateGeneration: (id: string, updates: Partial<Generation>) => void;
  deleteGeneration: (id: string) => void;

  // Queries
  getGenerationsByFragmentId: (fragmentId: string) => Generation[];
}

const __DEV__ = (globalThis as Record<string, unknown>).__DEV__ === true;

// Mock data for development
function getMockGenerations(): Generation[] {
  if (!__DEV__) return [];
  return [
  {
    id: 'gen-5',
    projectId: 'project-1',
    fragmentId: 'fragment-4',
    fragmentName: '背景音乐',
    promptText: '轻柔的钢琴旋律，带有自然氛围音效',
    references: [],
    providerInstanceId: 'suno-ai-1',
    providerDisplayName: 'Suno AI',
    providerParams: {},
    outputType: 'audio',
    resultAssetId: 'asset-gen-5',
    status: 'completed',
    completedAt: new Date(Date.now() - 900000),
    isSelected: false,
    createdAt: new Date(Date.now() - 2400000),
  },
  {
    id: 'gen-3',
    projectId: 'project-1',
    fragmentId: 'fragment-2',
    fragmentName: '城市夜景',
    promptText: '霓虹灯闪烁的城市街道，车流如织，现代都市夜景',
    references: [],
    providerInstanceId: 'seedance-1',
    providerDisplayName: 'Seedance 2.0',
    providerParams: {},
    outputType: 'video',
    resultAssetId: 'asset-gen-3',
    status: 'completed',
    completedAt: new Date(Date.now() - 1800000),
    isSelected: false,
    createdAt: new Date(Date.now() - 3600000),
  },
  {
    id: 'gen-4',
    projectId: 'project-1',
    fragmentId: 'fragment-3',
    fragmentName: '森林漫步',
    promptText: '阳光透过树叶洒下斑驳光影，森林小径蜿蜒向前',
    references: [],
    providerInstanceId: 'seedance-1',
    providerDisplayName: 'Seedance 2.0',
    providerParams: {},
    outputType: 'video',
    status: 'processing',
    isSelected: false,
    createdAt: new Date(Date.now() - 1800000),
  },
  {
    id: 'gen-1',
    projectId: 'project-1',
    fragmentId: 'fragment-1',
    fragmentName: '开场镜头',
    promptText: '一个美丽的日落海滩，金色阳光洒在波浪上，海鸥在天空中飞翔',
    references: [],
    providerInstanceId: 'seedance-1',
    providerDisplayName: 'Seedance 2.0',
    providerParams: {},
    outputType: 'video',
    resultAssetId: 'asset-gen-1',
    status: 'completed',
    completedAt: new Date(Date.now() - 3600000),
    isSelected: true,
    createdAt: new Date(Date.now() - 7200000),
  },
  {
    id: 'gen-2',
    projectId: 'project-1',
    fragmentId: 'fragment-1',
    fragmentName: '开场镜头',
    promptText: '夕阳下的海滩，海浪轻轻拍打着沙滩，远处有渔船',
    references: [],
    providerInstanceId: 'seedance-1',
    providerDisplayName: 'Seedance 2.0',
    providerParams: {},
    outputType: 'video',
    resultAssetId: 'asset-gen-2',
    status: 'completed',
    completedAt: new Date(Date.now() - 7200000),
    isSelected: false,
    createdAt: new Date(Date.now() - 10800000),
  },
  ];
}

export const useGenerationStore = create<GenerationState>((set, get) => ({
  generations: getMockGenerations(),

  // Generation actions
  loadGenerationsFromXml: (projectId: string, records: GenerationRecord[]) => {
    const loaded = records.map((r) => recordToGeneration(r, projectId));

    set((state) => {
      const recordIds = new Set(loaded.map((g) => g.id));
      // Preserve in-memory active generations that belong to the current project
      // and haven't been persisted to XML yet.
      // Cross-project active generations are excluded to prevent UI leak
      // (their Rust-side polling and download continue unaffected).
      const activeInMemory = state.generations.filter(
        (g) => !recordIds.has(g.id) && isActiveGenerationStatus(g.status) && g.projectId === projectId,
      );
      const merged = [...loaded, ...activeInMemory];
      merged.sort((a, b) => getGenerationTimestamp(b) - getGenerationTimestamp(a));
      return { generations: merged };
    });
  },

  addGeneration: (generation) => set((state) => {
    // Skip if a generation with the same ID already exists (prevents race on project reload)
    if (state.generations.some((g) => g.id === generation.id)) return state;
    const genTime = getGenerationTimestamp(generation);
    const idx = state.generations.findIndex((g) => getGenerationTimestamp(g) < genTime);
    if (idx < 0) return { generations: [...state.generations, generation] };
    const next = [...state.generations];
    next.splice(idx, 0, generation);
    return { generations: next };
  }),

  updateGeneration: (id, updates) => set((state) => {
    const idx = state.generations.findIndex((g) => g.id === id);
    if (idx < 0) return state;
    const updated = { ...state.generations[idx], ...updates };
    // Skip if nothing actually changed (shallow compare updated fields)
    const keys = Object.keys(updates) as (keyof Generation)[];
    if (keys.every((k) => state.generations[idx][k] === updated[k])) return state;
    const next = [...state.generations];
    next[idx] = updated;
    return { generations: next };
  }),

  deleteGeneration: (id) => set((state) => ({
    generations: state.generations.filter((g) => g.id !== id),
  })),

  // Queries
  getGenerationsByFragmentId: (fragmentId) => {
    const { generations } = get();
    return generations.filter((g) => g.fragmentId === fragmentId);
  },
}));

/** Shallow array equality: same length and same item references */
function arraysRefEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * React hook that returns generations filtered to the currently open project.
 * Prevents cross-project generation tasks from leaking into the UI.
 * Background Rust-side polling and downloads are unaffected.
 */
export function useCurrentProjectGenerations(): Generation[] {
  const projectId = useProjectStore((s) => s.currentProject?.id);
  return useGenerationStore(
    (s) => projectId ? s.generations.filter((g) => g.projectId === projectId) : [],
    arraysRefEqual,
  );
}
