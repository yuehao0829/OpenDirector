import { ReactNode, useState } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface PanelProps {
  title?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
  headerRight?: ReactNode;
}

export function Panel({
  title,
  children,
  collapsible = true,
  defaultCollapsed = false,
  className,
  headerRight,
}: PanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div
      className={twMerge(
        clsx(
          'bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden',
          className
        )
      )}
      data-testid="panel"
    >
      <div
        className={clsx(
          'flex items-center justify-between px-4 py-2 bg-zinc-800',
          collapsible && 'cursor-pointer hover:bg-zinc-750'
        )}
        onClick={() => collapsible && setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium text-white">{title}</div>
          {headerRight && (
            <div onClick={(e) => e.stopPropagation()}>
              {headerRight}
            </div>
          )}
        </div>
        {collapsible && (
          <button className="text-zinc-400 hover:text-white">
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        )}
      </div>

      {!collapsed && <div className="p-4">{children}</div>}
    </div>
  );
}
