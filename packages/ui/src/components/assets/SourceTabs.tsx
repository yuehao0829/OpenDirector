/**
 * Source Tabs Component
 *
 * Tabs for switching between Original and Generated assets
 */

import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { twMerge } from 'tailwind-merge';
import type { AssetSource } from '@opendirector/core/types/persistence';
import { getSourceTabs } from './constants';

interface SourceTabsProps {
  source: AssetSource;
  onSourceChange: (source: AssetSource) => void;
}

export function SourceTabs({ source, onSourceChange }: SourceTabsProps) {
  const { t } = useTranslation();
  const sourceTabs = getSourceTabs(t);

  return (
    <div className="flex bg-zinc-800 rounded-lg p-0.5 mx-1.5 mt-1.5 mb-0.5">
      {sourceTabs.map((tab) => (
        <button
          key={tab.value}
          className={twMerge(
            clsx(
              'flex-1 px-2 py-1 text-sm font-medium rounded-md transition-all duration-200',
              source === tab.value
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            )
          )}
          onClick={() => onSourceChange(tab.value)}
          data-testid={`source-tab-${tab.value}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
