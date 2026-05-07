/**
 * Project Store
 *
 * Pure state container for project data. Flow-orchestration logic
 * (open/save/import/export) has been moved to project-service.ts.
 * Store actions delegate to service functions.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import { Project, ProjectMeta, ProjectSettings } from '../types/project';
import { AutosaveTrigger } from '../types/persistence';
import { clearHistory, snapshotRefEqual, getSavedSnapshot } from './undoManager';
import { isDirtyTrackingSuppressed } from './dirty-tracking';
import { useTimelineStore } from './timelineStore';
import { useAssetStore } from './assetStore';
import { pushSnapshot } from './undoManager';

import {
  ensureProject as serviceEnsureProject,
  setupTempFolder as serviceSetupTempFolder,
  cleanupTempFolder as serviceCleanupTempFolder,
  createProject as serviceCreateProject,
  newProject as serviceNewProject,
  openProjectFromFolder as serviceOpenProjectFromFolder,
  openProjectDialog as serviceOpenProjectDialog,
  saveProject as serviceSaveProject,
  saveProjectAs as serviceSaveProjectAs,
  exportOtioProject as serviceExportOtioProject,
  importOtioProject as serviceImportOtioProject,
  exportXgesProject as serviceExportXgesProject,
  importXgesProject as serviceImportXgesProject,
  exportTimelineRenderProject as serviceExportTimelineRenderProject,
  exportXmeml as serviceExportXmeml,
  importXmemlProject as serviceImportXmemlProject,
  updateProjectName as serviceUpdateProjectName,
  triggerAutosave as serviceTriggerAutosave,
} from '../services/project-service';

// ============================================================================
// Project open callback mechanism
// ============================================================================

type ProjectOpenCallback = (project: import('../types/project').Project) => Promise<void>;
const projectOpenCallbacks: ProjectOpenCallback[] = [];

/**
 * Register a callback to be invoked after a project is opened and its data
 * is loaded into stores. Returns an unregister function.
 */
export function registerProjectOpenCallback(cb: ProjectOpenCallback): () => void {
  projectOpenCallbacks.push(cb);
  return () => {
    const idx = projectOpenCallbacks.indexOf(cb);
    if (idx >= 0) projectOpenCallbacks.splice(idx, 1);
  };
}

/**
 * Get the current list of project-open callbacks.
 * Used by project-service.ts to invoke callbacks after opening a project.
 */
export function getProjectOpenCallbacks(): readonly ProjectOpenCallback[] {
  return projectOpenCallbacks;
}

// ============================================================================
// Types
// ============================================================================

export interface ProjectState {
  // Current project
  currentProject: Project | null;
  recentProjects: ProjectMeta[];
  isLoading: boolean;
  isDirty: boolean;
  lastSavedAt: Date | null;

  // Autosave settings
  autosaveEnabled: boolean;
  autosaveInterval: number; // milliseconds
}

export interface ProjectActions {
  // Project lifecycle (delegated to project-service)
  createProject: (name: string, folderPath?: string) => Promise<Project>;
  newProject: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  openProjectFromFolder: (folderPath: string) => Promise<void>;
  openProjectDialog: () => Promise<void>;
  saveProject: () => Promise<void>;
  saveProjectAs: (name: string, folderPath: string) => Promise<void>;
  closeProject: () => void;
  deleteProject: (id: string) => Promise<void>;

  // Recent projects
  loadRecentProjects: () => Promise<void>;

  // Dirty tracking
  markDirty: () => void;
  setDirty: (dirty: boolean) => void;
  afterUndoRedo: (snapshot: import('./undoManager').UndoableSnapshot | null) => void;

  // Autosave
  enableAutosave: (interval?: number) => void;
  disableAutosave: () => void;
  triggerAutosave: (trigger: AutosaveTrigger) => Promise<void>;

  // Project data updates
  updateProjectSettings: (settings: Partial<ProjectSettings>) => void;
  updateProjectName: (name: string) => Promise<void>;

  // Media exchange
  exportOtio: () => Promise<void>;
  importOtio: () => Promise<void>;
  exportXges: () => Promise<void>;
  importXges: () => Promise<void>;
  exportTimelineRender: () => Promise<void>;
  exportXmeml: () => Promise<void>;
  importXmeml: () => Promise<void>;

  // Temp project management
  ensureProject: () => void;
  setupTempFolder: () => Promise<void>;
  cleanupTempFolder: () => Promise<void>;

  // Reset
  reset: () => void;
}

const initialState: ProjectState = {
  currentProject: null,
  recentProjects: [],
  isLoading: false,
  isDirty: false,
  lastSavedAt: null,
  autosaveEnabled: true,
  autosaveInterval: 5 * 60 * 1000, // 5 minutes default
};

// ============================================================================
// Store
// ============================================================================

export const useProjectStore = create<ProjectState & ProjectActions>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,

    // ========================================================================
    // Project Lifecycle — thin delegates to project-service
    // ========================================================================

    ensureProject: () => serviceEnsureProject(),

    setupTempFolder: () => serviceSetupTempFolder(),

    cleanupTempFolder: () => serviceCleanupTempFolder(),

    createProject: (name: string, folderPath?: string) => serviceCreateProject(name, folderPath),

    newProject: () => serviceNewProject(),

    openProject: (_id: string) => {
      return Promise.resolve();
    },

    openProjectFromFolder: (folderPath: string) => serviceOpenProjectFromFolder(folderPath),

    openProjectDialog: () => serviceOpenProjectDialog(),

    saveProject: () => serviceSaveProject(),

    saveProjectAs: (name: string, folderPath: string) => serviceSaveProjectAs(name, folderPath),

    closeProject: () => {
      clearHistory();
      set({
        currentProject: null,
        isDirty: false,
        lastSavedAt: null,
      });
    },

    deleteProject: async (id: string) => {
      const { recentProjects } = get();
      set({
        recentProjects: recentProjects.filter((p) => p.id !== id),
      });
    },

    // ========================================================================
    // Recent Projects
    // ========================================================================

    loadRecentProjects: async () => {
      // recent projects are persisted via SQLite on the Rust side
    },

    // ========================================================================
    // Dirty Tracking
    // ========================================================================

    markDirty: () => {
      const { currentProject } = get();
      if (!currentProject) return;
      set({ isDirty: true });
    },

    setDirty: (dirty: boolean) => {
      set({ isDirty: dirty });
    },

    afterUndoRedo: (snapshot: import('./undoManager').UndoableSnapshot | null) => {
      if (!get().currentProject) return;

      const saved = getSavedSnapshot();
      if (saved === null) {
        set({ isDirty: true });
        return;
      }

      if (snapshot === null) {
        set({ isDirty: true });
        return;
      }

      set({ isDirty: !snapshotRefEqual(snapshot, saved) });
    },

    // ========================================================================
    // Autosave
    // ========================================================================

    enableAutosave: (interval?: number) => {
      set({
        autosaveEnabled: true,
        autosaveInterval: interval ?? get().autosaveInterval,
      });
    },

    disableAutosave: () => {
      set({ autosaveEnabled: false });
    },

    triggerAutosave: (trigger: AutosaveTrigger) => serviceTriggerAutosave(trigger),

    // ========================================================================
    // XMEML — delegated to project-service
    // ========================================================================

    exportOtio: () => serviceExportOtioProject(),

    importOtio: () => serviceImportOtioProject(),

    exportXges: () => serviceExportXgesProject(),

    importXges: () => serviceImportXgesProject(),

    exportTimelineRender: () => serviceExportTimelineRenderProject(),

    exportXmeml: () => serviceExportXmeml(),

    importXmeml: () => serviceImportXmemlProject(),

    // ========================================================================
    // Project Data Updates
    // ========================================================================

    updateProjectSettings: (settings: Partial<ProjectSettings>) => {
      const { currentProject } = get();
      if (!currentProject) return;

      set({
        currentProject: {
          ...currentProject,
          settings: { ...currentProject.settings, ...settings },
          updatedAt: new Date(),
        },
        isDirty: true,
      });
    },

    updateProjectName: (name: string) => serviceUpdateProjectName(name),

    // ========================================================================
    // Reset
    // ========================================================================

    reset: () => {
      clearHistory();
      set(initialState);
    },
  }))
);

// ============================================================================
// Cross-store subscriptions
// ============================================================================

// Mark project dirty when timeline data changes
useTimelineStore.subscribe(
  (state) => [state.tracks, state.fragments, state.scenes, state.duration] as const,
  () => {
    if (!isDirtyTrackingSuppressed() && useProjectStore.getState().currentProject) {
      pushSnapshot();
      useProjectStore.getState().markDirty();
    }
  },
  { equalityFn: shallow }
);

// Mark project dirty when assets change
useAssetStore.subscribe(
  (state) => state.assets,
  () => {
    if (!isDirtyTrackingSuppressed() && useProjectStore.getState().currentProject) {
      pushSnapshot();
      useProjectStore.getState().markDirty();
    }
  },
  { equalityFn: shallow }
);
