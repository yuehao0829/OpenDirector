/**
 * Project types for project management
 */

import type { Track, Fragment, Scene } from './timeline';
import type { Asset } from './asset';
import type { ProjectProviderConfig } from './provider-system';

/**
 * Main project interface
 */
export interface Project {
  id: string;
  name: string;
  description?: string;

  // Folder path for desktop projects
  folderPath?: string;

  // Whether this is a temporary unsaved project (temp folder, not yet saved by user)
  isTemp?: boolean;

  // .odp filename (e.g. "MyProject.odp")
  fileName?: string;

  // Timeline data
  tracks: Track[];
  fragments: Fragment[];
  scenes: Scene[];

  // Assets
  assets: Asset[];

  // Settings
  settings: ProjectSettings;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt?: Date;
}

/**
 * Project settings that travel with the project
 */
export interface ProjectSettings {
  fps: number;
  resolution: { width: number; height: number };
  defaultProvider: string;
  defaultAspectRatio: string;
  providerConfig: ProjectProviderConfig;
}

/**
 * Project metadata for list display
 */
export interface ProjectMeta {
  id: string;
  name: string;
  folderPath?: string;
  thumbnailUrl?: string;
  duration: number;
  fragmentCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt?: Date;
}
