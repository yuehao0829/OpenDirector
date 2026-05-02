/**
 * Search Bar Component
 *
 * Search input for asset panel
 */

import { Search, Plus } from 'lucide-react';

interface SearchBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onImportClick?: () => void;
  placeholder?: string;
}

export function SearchBar({
  searchQuery,
  onSearchChange,
  onImportClick,
  placeholder = '搜索资源...',
}: SearchBarProps) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 border-b border-zinc-800">
      <div className="relative flex-1">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-8 pr-2 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
          data-testid="asset-search"
        />
      </div>
      {onImportClick && (
        <button
          className="p-1.5 bg-blue-600 rounded hover:bg-blue-700 transition-colors"
          onClick={onImportClick}
          data-testid="import-asset"
          title="导入资源"
        >
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}
