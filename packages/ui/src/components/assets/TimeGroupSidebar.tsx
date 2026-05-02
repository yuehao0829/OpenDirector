import { useState } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface DayGroup {
  dateKey: string;        // '2026-04-11'
  label: string;          // '04-11' or '今天'
  hours: HourGroup[];
  totalCount: number;
  isToday: boolean;
}

export interface HourGroup {
  key: string;            // '2026-04-11T14:00:00.000Z'
  label: string;          // '14:00'
  count: number;
}

interface TimeGroupSidebarProps {
  dayGroups: DayGroup[];
  selectedGroupKey: string | null;
  onGroupSelect: (key: string | null) => void;
}

export function TimeGroupSidebar({
  dayGroups,
  selectedGroupKey,
  onGroupSelect,
}: TimeGroupSidebarProps) {
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => {
    const today = dayGroups.find((d) => d.isToday);
    return new Set(today ? [today.dateKey] : []);
  });

  const toggleDay = (dateKey: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) {
        next.delete(dateKey);
      } else {
        next.add(dateKey);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto" data-testid="time-group-sidebar">
      {dayGroups.map((day) => {
        const isExpanded = expandedDays.has(day.dateKey);
        const isDaySelected = selectedGroupKey === day.dateKey;

        return (
          <div key={day.dateKey}>
            <button
              className={twMerge(
                clsx(
                  'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                  isDaySelected
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                )
              )}
              onClick={() => {
                toggleDay(day.dateKey);
                onGroupSelect(day.dateKey);
              }}
              data-testid={`time-group-day-${day.dateKey}`}
            >
              <span className="flex items-center gap-1.5 text-sm">
                {isExpanded ? (
                  <ChevronDown size={14} className="text-zinc-500" />
                ) : (
                  <ChevronRight size={14} className="text-zinc-500" />
                )}
                <span>{day.label}</span>
              </span>
              <span className="text-xs text-zinc-500">{day.totalCount}</span>
            </button>

            {isExpanded &&
              day.hours.map((hour) => {
                const isHourSelected = selectedGroupKey === hour.key;
                return (
                  <button
                    key={hour.key}
                    className={twMerge(
                      clsx(
                        'w-full flex items-center justify-between pl-8 pr-3 py-1.5 text-left transition-colors',
                        isHourSelected
                          ? 'bg-zinc-700 text-white'
                          : 'text-zinc-500 hover:text-white hover:bg-zinc-800'
                      )
                    )}
                    onClick={() => onGroupSelect(hour.key)}
                    data-testid={`time-group-hour-${hour.key}`}
                  >
                    <span className="text-xs">{hour.label}</span>
                    <span className="text-xs text-zinc-600">{hour.count}</span>
                  </button>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
