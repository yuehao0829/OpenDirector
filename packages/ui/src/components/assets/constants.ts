/**
 * Asset Panel constants
 */

import type { AssetType } from '@opendirector/core/types/persistence';
import type { TFunction } from 'i18next';

export function getFileCategories(t: TFunction): { value: 'all' | AssetType; label: string }[] {
  return [
    { value: 'all', label: t('assetPanel.tabs.all') },
    { value: 'video', label: t('common.video') },
    { value: 'image', label: t('common.image') },
    { value: 'audio', label: t('common.audio') },
  ];
}

export function getSourceTabs(t: TFunction) {
  return [
    { value: 'original' as const, label: t('assetPanel.tabs.original') },
    { value: 'generated' as const, label: t('assetPanel.tabs.generated') },
  ];
}

export const THUMBNAIL_WIDTH = 80;
export const THUMBNAIL_HEIGHT = 45;

export const GENERATED_CARD_THUMBNAIL_WIDTH = 96;
export const GENERATED_CARD_THUMBNAIL_HEIGHT = 54;
