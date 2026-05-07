import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
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

export const useGenerationStore = create<GenerationState>((set, get) => ({
  generations: [],

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

/**
 * React hook that returns generations filtered to the currently open project.
 * Prevents cross-project generation tasks from leaking into the UI.
 * Background Rust-side polling and downloads are unaffected.
 */
export function useCurrentProjectGenerations(): Generation[] {
  const projectId = useProjectStore((s) => s.currentProject?.id);
  return useGenerationStore(
    (s) => projectId ? s.generations.filter((g) => g.projectId === projectId) : [],
    shallow,
  );
}
