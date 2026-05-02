import { useState } from 'react';
import { ProviderList } from './ProviderList';
import { GenerationDefaultsPanel } from './GenerationDefaultsPanel';
import { EditProviderDialog } from './EditProviderDialog';
import { ExportProviderDialog } from './ExportProviderDialog';
import { ImportProviderConfigDialog } from './ImportProviderConfigDialog';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';

type SettingsNavItem = 'provider' | 'generation';

export function ProviderSettingsPanel() {
  const [activeNav, setActiveNav] = useState<SettingsNavItem>('provider');
  const [editingInstance, setEditingInstance] = useState<ProviderInstance | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

  const navItems: { key: SettingsNavItem; label: string }[] = [
    { key: 'provider', label: 'Provider' },
    { key: 'generation', label: '生成参数' },
  ];

  return (
    <div className="h-full flex">
      {/* Left navigation */}
      <div className="w-40 shrink-0 bg-zinc-800/30 border-r border-zinc-700 py-4">
        <nav className="space-y-0.5 px-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`w-full text-left px-3 py-2 text-sm rounded-md transition-colors ${
                activeNav === item.key
                  ? 'bg-blue-500/10 text-blue-400 font-medium'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
              }`}
              onClick={() => setActiveNav(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeNav === 'provider' && (
          <ProviderList
            onEdit={setEditingInstance}
            onExport={() => setShowExportDialog(true)}
            onImport={() => setShowImportDialog(true)}
          />
        )}
        {activeNav === 'generation' && (
          <GenerationDefaultsPanel />
        )}
      </div>

      <EditProviderDialog
        isOpen={!!editingInstance}
        onClose={() => setEditingInstance(null)}
        instance={editingInstance}
      />

      <ExportProviderDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
      />

      <ImportProviderConfigDialog
        isOpen={showImportDialog}
        onClose={() => setShowImportDialog(false)}
      />
    </div>
  );
}
