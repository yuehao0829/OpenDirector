import type { AssetGroup } from '@opendirector/core/types/ai-video';
import { ChevronDown, RefreshCw } from 'lucide-react';

interface AssetGroupSelectorProps {
  groups: AssetGroup[];
  selectedGroupId: string;
  selectedGroupName: string;
  loading: boolean;
  disabled?: boolean;
  onGroupChange: (groupId: string, groupName: string) => void;
  onGroupNameChange: (name: string) => void;
  onRefresh: () => void;
}

export function AssetGroupSelector({
  groups,
  selectedGroupId,
  selectedGroupName,
  loading,
  disabled,
  onGroupChange,
  onGroupNameChange,
  onRefresh,
}: AssetGroupSelectorProps) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-zinc-300">Asset Group</label>
      <div className="flex items-center gap-2">
        {groups.length > 0 ? (
          <div className="relative flex-1">
            <select
              value={selectedGroupId}
              onChange={(e) => {
                const gid = e.target.value;
                const group = groups.find((g) => g.group_id === gid);
                onGroupChange(gid, group?.name ?? '');
              }}
              className="w-full appearance-none bg-zinc-800 border border-zinc-700 rounded-lg pl-3 pr-8 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
            >
              <option value="">-- 选择 Asset Group --</option>
              {groups.map((g) => (
                <option key={g.group_id} value={g.group_id}>
                  {g.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
          </div>
        ) : (
          <input
            type="text"
            value={selectedGroupName}
            onChange={(e) => onGroupNameChange(e.target.value)}
            placeholder="点击刷新按钮加载 Group 列表"
            className="flex-1 w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 text-white placeholder-zinc-500 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || disabled}
          className="p-2 text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
          title="刷新 Group 列表"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  );
}
