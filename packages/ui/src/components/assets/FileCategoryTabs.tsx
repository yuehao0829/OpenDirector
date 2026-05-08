/**
 * File Category Tabs Component
 *
 * Tabs for filtering assets by file type
 */

import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { twMerge } from 'tailwind-merge';
import type { AssetType } from '@opendirector/core/types/persistence';
import { CloudUpload } from 'lucide-react';
import { getFileCategories } from './constants';

export type FileCategory = 'all' | AssetType;

interface FileCategoryTabsProps {
  category: FileCategory;
  onCategoryChange: (category: FileCategory) => void;
  showUploadedOnly?: boolean;
  onShowUploadedOnlyChange?: (show: boolean) => void;
  hasUploadedAssets?: boolean;
}

export function FileCategoryTabs({ category, onCategoryChange, showUploadedOnly, onShowUploadedOnlyChange, hasUploadedAssets }: FileCategoryTabsProps) {
  const { t } = useTranslation();
  const fileCategories = getFileCategories(t);

  return (
    <div className="flex items-center justify-between px-1.5 py-1 border-b border-zinc-800">
      <div className="flex gap-1">
        {fileCategories.map((cat) => (
          <button
            key={cat.value}
            className={twMerge(
              clsx(
                'px-3 py-1 text-xs rounded transition-colors',
                category === cat.value
                  ? 'bg-zinc-700 text-white'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
              )
            )}
            onClick={() => onCategoryChange(cat.value)}
            data-testid={`file-category-${cat.value}`}
          >
            {cat.label}
          </button>
        ))}
      </div>
      {hasUploadedAssets && onShowUploadedOnlyChange && (
        <button
          className={twMerge(
            clsx(
              'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors',
              showUploadedOnly
                ? 'bg-blue-600/30 text-blue-300'
                : 'bg-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-600'
            )
          )}
          onClick={() => onShowUploadedOnlyChange(!showUploadedOnly)}
          data-testid="filter-uploaded-only"
        >
          <CloudUpload className="w-3 h-3" />
          {t('assetPanel.status.copyrightLibrary')}
        </button>
      )}
    </div>
  );
}
