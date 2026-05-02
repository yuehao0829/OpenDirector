import { useMemo, useState } from 'react';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useCurrentProjectGenerations } from '@opendirector/core/stores/generationStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import { GeneratedCard } from './GeneratedCard';
import { TimeGroupSidebar } from './TimeGroupSidebar';
import type { DayGroup, HourGroup } from './TimeGroupSidebar';

function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDateKey(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number);
  return [y, m - 1, d];
}

export function GeneratedPanel() {
  const generations = useCurrentProjectGenerations();
  const searchQuery = useAssetStore((s) => s.searchQuery);
  const fileCategory = useAssetStore((s) => s.fileCategory);
  const primaryType = useSelectionStore((s) => s.primaryType);
  const primaryFocusId = useSelectionStore((s) => s.primaryFocusId);

  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);

  const selectedFragmentId = primaryType === 'fragment' ? (primaryFocusId ?? null) : null;

  const categoryFilteredGenerations = useMemo(() => {
    if (fileCategory === 'all') return generations;
    return generations.filter((g) => g.outputType === fileCategory);
  }, [generations, fileCategory]);

  // Only enter fragment view if the selected fragment has generated content;
  // otherwise show the full history list.
  const hasFragmentGenerations = useMemo(() => {
    if (!selectedFragmentId) return false;
    return categoryFilteredGenerations.some((g) => g.fragmentId === selectedFragmentId);
  }, [categoryFilteredGenerations, selectedFragmentId]);
  const isFragmentView = primaryType === 'fragment' && !!selectedFragmentId && hasFragmentGenerations;

  const dayGroups = useMemo((): DayGroup[] => {
    const todayKey = formatDateKey(new Date());
    const dayMap = new Map<string, Map<number, number>>();

    for (const gen of categoryFilteredGenerations) {
      const date = gen.completedAt ?? gen.createdAt;
      if (!date) continue;

      const dateKey = formatDateKey(date);
      const hour = date.getHours();

      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, new Map());
      }
      const hourMap = dayMap.get(dateKey)!;
      hourMap.set(hour, (hourMap.get(hour) ?? 0) + 1);
    }

    const result: DayGroup[] = [];
    for (const [dateKey, hourMap] of dayMap) {
      const isToday = dateKey === todayKey;
      const label = isToday ? '今天' : dateKey.slice(5);

      const hours: HourGroup[] = [];
      let totalCount = 0;

      const sortedHours = [...hourMap.entries()].sort((a, b) => b[0] - a[0]);
      for (const [hour, count] of sortedHours) {
        const [year, month, day] = parseDateKey(dateKey);
        const hourDate = new Date(year, month, day, hour);
        hours.push({
          key: hourDate.toISOString(),
          label: `${String(hour).padStart(2, '0')}:00`,
          count,
        });
        totalCount += count;
      }

      result.push({ dateKey, label, hours, totalCount, isToday });
    }

    result.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
    return result;
  }, [categoryFilteredGenerations]);

  const dayKeySet = useMemo(() => new Set(dayGroups.map((d) => d.dateKey)), [dayGroups]);
  const allGroupKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const d of dayGroups) {
      keys.add(d.dateKey);
      for (const h of d.hours) keys.add(h.key);
    }
    return keys;
  }, [dayGroups]);

  const effectiveGroupKey = useMemo(() => {
    if (isFragmentView) return null;
    if (selectedGroupKey !== null && allGroupKeys.has(selectedGroupKey)) {
      return selectedGroupKey;
    }
    return dayGroups.length > 0 ? dayGroups[0].dateKey : null;
  }, [isFragmentView, selectedGroupKey, allGroupKeys, dayGroups]);

  const filteredGenerations = useMemo(() => {
    let result = categoryFilteredGenerations;

    if (isFragmentView && selectedFragmentId) {
      result = result.filter((g) => g.fragmentId === selectedFragmentId);
    }

    if (!isFragmentView && effectiveGroupKey !== null) {
      if (dayKeySet.has(effectiveGroupKey)) {
        const [dkYear, dkMonth, dkDay] = parseDateKey(effectiveGroupKey);
        result = result.filter((gen) => {
          const date = gen.completedAt ?? gen.createdAt;
          if (!date) return false;
          return date.getFullYear() === dkYear && date.getMonth() === dkMonth && date.getDate() === dkDay;
        });
      } else {
        result = result.filter((gen) => {
          const date = gen.completedAt ?? gen.createdAt;
          if (!date) return false;
          const hourKey = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).toISOString();
          return hourKey === effectiveGroupKey;
        });
      }
    }

    if (searchQuery) {
      const lowerQuery = searchQuery.toLowerCase();
      result = result.filter((g) =>
        g.promptText.toLowerCase().includes(lowerQuery) ||
        g.fragmentName?.toLowerCase().includes(lowerQuery) ||
        g.providerDisplayName.toLowerCase().includes(lowerQuery)
      );
    }

    return result;
  }, [categoryFilteredGenerations, isFragmentView, selectedFragmentId, effectiveGroupKey, dayKeySet, searchQuery]);

  const renderCardList = (emptyText: string) => {
    if (filteredGenerations.length === 0) {
      return (
        <div className="text-center text-zinc-500 py-8">
          <p>{emptyText}</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1.5 p-2">
        {filteredGenerations.map((gen) => (
          <GeneratedCard
            key={gen.id}
            generation={gen}
          />
        ))}
      </div>
    );
  };

  if (generations.length === 0) {
    return (
      <div className="text-center text-zinc-500 pt-20">
        <p>暂无生成内容</p>
        <p className="text-xs mt-1">在 Timeline 中创建容器开始生成</p>
      </div>
    );
  }

  if (isFragmentView && selectedFragmentId) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-y-auto">
          {renderCardList('暂无生成内容')}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <div className="w-1/4 border-r border-zinc-800 overflow-y-auto">
        <TimeGroupSidebar
          dayGroups={dayGroups}
          selectedGroupKey={effectiveGroupKey}
          onGroupSelect={setSelectedGroupKey}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {renderCardList('暂无匹配的生成内容')}
      </div>
    </div>
  );
}
