/**
 * Autosave Service
 *
 * Manages automatic saving of project data at intervals and before risky operations
 */

import type { Project } from '../types/project';
import type { AutosaveTrigger } from '../types/persistence';
import type { FileSystemAdapter } from '../adapters/types';
import { i18n, normalizeLanguage, t } from '../i18n';
import { useProjectStore } from '../stores/projectStore';
import { saveAutosaveSnapshot, cleanupAutosaves } from './project-io';

// ============================================================================
// Types
// ============================================================================

export interface AutosaveConfig {
  enabled: boolean;
  intervalMs: number;
  keepCount: number;
}

export interface AutosaveResult {
  path: string;
  timestamp: Date;
  trigger: AutosaveTrigger;
}

type AutosaveCallback = (result: AutosaveResult) => void;

// ============================================================================
// Autosave Manager
// ============================================================================

export class AutosaveManager {
  private config: AutosaveConfig;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private project: Project | null = null;
  private fs: FileSystemAdapter | null = null;
  private folderPath: string = '';
  private onAutosave: AutosaveCallback | null = null;
  private isSaving: boolean = false;

  constructor(config?: Partial<AutosaveConfig>) {
    this.config = {
      enabled: true,
      intervalMs: 5 * 60 * 1000, // 5 minutes
      keepCount: 20,
      ...config,
    };
  }

  /**
   * Configure autosave settings
   */
  configure(config: Partial<AutosaveConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart timer if interval changed
    if (this.timerId !== null && config.intervalMs !== undefined) {
      this.stopTimer();
      this.startTimer();
    }
  }

  /**
   * Set the current project to autosave
   */
  setProject(project: Project, fs: FileSystemAdapter, folderPath: string): void {
    this.project = project;
    this.fs = fs;
    this.folderPath = folderPath;

    if (this.config.enabled && !this.timerId) {
      this.startTimer();
    }
  }

  /**
   * Set callback for autosave events
   */
  setCallback(callback: AutosaveCallback): void {
    this.onAutosave = callback;
  }

  /**
   * Start the autosave timer
   */
  private startTimer(): void {
    if (this.timerId !== null) return;

    this.timerId = setInterval(() => {
      if (!useProjectStore.getState().isDirty) return;
      this.trigger('timer').catch(() => { /* autosave is best-effort */ });
    }, this.config.intervalMs);
  }

  /**
   * Stop the autosave timer
   */
  private stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Enable autosave
   */
  enable(): void {
    this.config.enabled = true;
    if (this.project && this.fs && !this.timerId) {
      this.startTimer();
    }
  }

  /**
   * Disable autosave
   */
  disable(): void {
    this.config.enabled = false;
    this.stopTimer();
  }

  /**
   * Trigger manual autosave
   */
  async trigger(trigger: AutosaveTrigger = 'timer'): Promise<AutosaveResult | null> {
    if (!this.project || !this.fs || !this.folderPath) {
      return null;
    }

    if (this.isSaving) {
      return null;
    }

    this.isSaving = true;

    try {
      const path = await saveAutosaveSnapshot(this.project, this.fs, this.folderPath);

      const result: AutosaveResult = {
        path,
        timestamp: new Date(),
        trigger,
      };

      // Cleanup old autosaves
      await cleanupAutosaves(this.fs, this.folderPath, this.config.keepCount);

      // Notify callback
      if (this.onAutosave) {
        this.onAutosave(result);
      }

      return result;
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopTimer();
    this.project = null;
    this.fs = null;
    this.onAutosave = null;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let autosaveManager: AutosaveManager | null = null;

/**
 * Get the global autosave manager instance
 */
export function getAutosaveManager(): AutosaveManager {
  if (!autosaveManager) {
    autosaveManager = new AutosaveManager();
  }
  return autosaveManager;
}

/**
 * Initialize autosave for a project
 */
export function initializeAutosave(
  project: Project,
  fs: FileSystemAdapter,
  folderPath: string,
  config?: Partial<AutosaveConfig>
): AutosaveManager {
  const manager = getAutosaveManager();

  if (config) {
    manager.configure(config);
  }

  manager.setProject(project, fs, folderPath);

  return manager;
}

/**
 * Shutdown autosave
 */
export function shutdownAutosave(): void {
  if (autosaveManager) {
    autosaveManager.destroy();
    autosaveManager = null;
  }
}

// ============================================================================
// Browser Event Handlers
// ============================================================================

interface EventHandler {
  event: string;
  handler: () => void;
  target: EventTarget;
}

/**
 * Setup browser event handlers for autosave triggers
 */
export function setupAutosaveEventHandlers(
  manager: AutosaveManager,
  isDirty: () => boolean
): () => void {
  const handlers: EventHandler[] = [];

  // Before unload (page close)
  const beforeUnloadHandler = (e: BeforeUnloadEvent): string | void => {
    if (isDirty()) {
      // Trigger autosave before close
      manager.trigger('before_close').catch(() => {
        // Ignore errors on page close
      });

      // Show confirmation dialog
      const message = t('autosave.leaveWithUnsavedChanges');
      e.returnValue = message;
      return message;
    }
  };

  window.addEventListener('beforeunload', beforeUnloadHandler as EventListener);
  handlers.push({ event: 'beforeunload', handler: beforeUnloadHandler as () => void, target: window });

  // Visibility change (tab switch)
  const visibilityHandler = (): void => {
    if (document.visibilityState === 'hidden' && isDirty()) {
      manager.trigger('timer').catch(() => {
        // Ignore errors
      });
    }
  };

  document.addEventListener('visibilitychange', visibilityHandler);
  handlers.push({ event: 'visibilitychange', handler: visibilityHandler, target: document });

  // Return cleanup function
  return () => {
    for (const { event, handler, target } of handlers) {
      target.removeEventListener(event, handler);
    }
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format autosave timestamp for display
 */
export function formatAutosaveTime(date: Date): string {
  return date.toLocaleString(normalizeLanguage(i18n.language), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Get relative time string for autosave
 */
export function getRelativeAutosaveTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return t('autosave.justNow');
  if (diffMins < 60) return t('autosave.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('autosave.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('autosave.daysAgo', { count: diffDays });

  return formatAutosaveTime(date);
}
