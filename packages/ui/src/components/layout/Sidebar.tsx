import { ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

interface SidebarProps {
  children: ReactNode;
  collapsed?: boolean;
  width?: number;
}

export function Sidebar({ children, collapsed = false, width = 240 }: SidebarProps) {
  return (
    <aside
      className={twMerge(
        clsx(
          'h-full bg-zinc-900 border-r border-zinc-800 transition-all duration-200',
          collapsed ? 'w-12' : ''
        )
      )}
      style={{ width: collapsed ? 48 : width }}
      data-testid="sidebar"
    >
      {children}
    </aside>
  );
}

interface SidebarSectionProps {
  title?: string;
  children: ReactNode;
}

export function SidebarSection({ title, children }: SidebarSectionProps) {
  return (
    <div className="p-3">
      {title && (
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}
