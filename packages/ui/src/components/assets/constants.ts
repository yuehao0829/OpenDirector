/**
 * Asset Panel constants
 */

import type { AssetType } from '@opendirector/core/types/persistence';

export const FILE_CATEGORIES: { value: 'all' | AssetType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Image' },
  { value: 'audio', label: 'Audio' },
];

export const SOURCE_TABS = [
  { value: 'original' as const, label: 'Original' },
  { value: 'generated' as const, label: 'Generated' },
];

export const THUMBNAIL_WIDTH = 80;
export const THUMBNAIL_HEIGHT = 45;

export const GENERATED_CARD_THUMBNAIL_WIDTH = 96;
export const GENERATED_CARD_THUMBNAIL_HEIGHT = 54;
