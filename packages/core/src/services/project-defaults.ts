/**
 * Default project structure helpers
 *
 * Shared between project-hydration and timelineStore to avoid duplication.
 * Extracted into a separate file to prevent circular dependencies.
 */

import type { Track, Scene } from '../types/timeline';
import { t } from '../i18n';

export const DEFAULT_SCENE_DURATION_MS = 60_000;

export function createDefaultTracks(): Track[] {
  return [
    {
      id: 'track-video-1',
      type: 'video',
      name: t('timeline.videoTrack', { index: 1 }),
      muted: false,
      locked: false,
      order: 0,
    },
    {
      id: 'track-video-2',
      type: 'video',
      name: t('timeline.videoTrack', { index: 2 }),
      muted: false,
      locked: false,
      order: 1,
    },
    {
      id: 'track-audio-1',
      type: 'audio',
      name: t('timeline.audioTrack', { index: 1 }),
      muted: false,
      locked: false,
      order: 0,
    },
    {
      id: 'track-audio-2',
      type: 'audio',
      name: t('timeline.audioTrack', { index: 2 }),
      muted: false,
      locked: false,
      order: 1,
    },
  ];
}

export function createDefaultScene(): Scene {
  return {
    id: 'scene-1',
    name: t('timeline.scene', { index: 1 }),
    start: 0,
    duration: DEFAULT_SCENE_DURATION_MS,
    referenceIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
