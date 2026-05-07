/**
 * Project Hydration
 *
 * Handles loading project data into multiple stores (timeline, asset, generation)
 * and resetting undo history. Extracted from projectStore to separate
 * state hydration from state ownership.
 */

import type { Project } from '../types/project';
import type { GenerationRecord } from '../utils/xml';
import { generateId } from '../utils/id';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_FPS, DEFAULT_PROVIDER, DEFAULT_ASPECT_RATIO } from '../constants';
import { useTimelineStore } from '../stores/timelineStore';
import { useAssetStore } from '../stores/assetStore';
import { useGenerationStore } from '../stores/generationStore';
import { withoutDirtyTracking } from '../stores/dirty-tracking';
import { clearHistory, pushBaseSnapshot } from '../stores/undoManager';
import { useProjectStore } from '../stores/projectStore';
import { createDefaultTracks, createDefaultScene } from './project-defaults';

// Re-export for backward compatibility
export { createDefaultTracks, createDefaultScene };

// ============================================================================
// Hydration functions
// ============================================================================

/**
 * Build a new blank Project and hydrate all stores.
 * Used by ensureProject() and createProject().
 */
export function hydrateNewProject(opts: {
  name: string;
  folderPath?: string;
  fileName?: string;
  isTemp?: boolean;
}): Project {
  const project: Project = {
    id: generateId(),
    name: opts.name,
    folderPath: opts.folderPath,
    fileName: opts.fileName,
    isTemp: opts.isTemp,
    tracks: createDefaultTracks(),
    fragments: [],
    scenes: [createDefaultScene()],
    assets: [],
    settings: {
      fps: DEFAULT_FPS,
      resolution: { ...DEFAULT_PROJECT_SETTINGS.resolution },
      defaultProvider: DEFAULT_PROVIDER,
      defaultAspectRatio: DEFAULT_ASPECT_RATIO,
      providerConfig: {},
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  useProjectStore.setState({ currentProject: project, isDirty: false, lastSavedAt: null });

  withoutDirtyTracking(() => {
    const tl = useTimelineStore.getState();
    tl.reset();
    for (const track of project.tracks) tl.addTrack(track);
    for (const scene of project.scenes) tl.addScene(scene);
    useAssetStore.setState({ assets: project.assets, pendingDeletions: [] });
  });

  // Reset generation state for the new project
  useGenerationStore.setState({ generations: [] });

  clearHistory();
  pushBaseSnapshot();

  return project;
}

/**
 * Hydrate stores from a loaded project (opened from disk).
 * Sets currentProject, syncs timeline/asset/generation stores,
 * and resets undo history.
 */
export function hydrateLoadedProject(
  project: Project,
  generations: GenerationRecord[]
): void {
  useProjectStore.setState({ currentProject: project });

  // Sync to timelineStore and assetStore (suppress dirty during initial load)
  withoutDirtyTracking(() => {
    const timelineStore = useTimelineStore.getState();
    timelineStore.reset();
    for (const track of project.tracks) {
      timelineStore.addTrack(track);
    }
    for (const fragment of project.fragments) {
      timelineStore.addFragment(fragment);
    }
    for (const scene of project.scenes) {
      timelineStore.addScene(scene);
    }
    useAssetStore.setState({ assets: project.assets, pendingDeletions: [] });
  });

  clearHistory();
  pushBaseSnapshot();

  // Load generation history
  useGenerationStore.getState().loadGenerationsFromXml(project.id, generations);
}

/**
 * Hydrate stores from an imported project (e.g. XMEML import).
 * Sets currentProject, syncs timeline/asset stores, and resets undo history.
 */
export function hydrateImportedProject(project: Project): void {
  useProjectStore.setState({ currentProject: project });

  // Sync to stores
  withoutDirtyTracking(() => {
    const timelineStore = useTimelineStore.getState();
    timelineStore.reset();
    for (const track of project.tracks) {
      timelineStore.addTrack(track);
    }
    for (const fragment of project.fragments) {
      timelineStore.addFragment(fragment);
    }
    useAssetStore.setState({ assets: project.assets, pendingDeletions: [] });
  });

  clearHistory();
  pushBaseSnapshot();

  useProjectStore.setState({ isDirty: true, isLoading: false });
}
