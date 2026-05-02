import { useState } from 'react';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import { Plus, FileOutput, FileInput } from 'lucide-react';
import { Button } from '../common/Button';
import { ProviderInstanceCard } from './ProviderInstanceCard';
import { AddProviderDialog } from './AddProviderDialog';

interface ProviderListProps {
  onEdit: (instance: ProviderInstance) => void;
  onExport: () => void;
  onImport: () => void;
}

export function ProviderList({ onEdit, onExport, onImport }: ProviderListProps) {
  const instances = useProviderInstanceStore((s) => s.instances);
  const [showAddDialog, setShowAddDialog] = useState(false);

  const sortedInstances = [...instances].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">Provider 列表</h3>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onExport}>
            <FileOutput size={14} className="mr-1" />
            导出
          </Button>
          <Button variant="ghost" size="sm" onClick={onImport}>
            <FileInput size={14} className="mr-1" />
            导入
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus size={14} className="mr-1" />
            添加
          </Button>
        </div>
      </div>

      {sortedInstances.length === 0 ? (
        <div className="text-center py-8 text-zinc-500 text-sm">
          <p>暂无已配置的 Provider</p>
          <p className="mt-1 text-xs">点击"添加"按钮配置一个 Provider</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedInstances.map((inst) => (
            <ProviderInstanceCard
              key={inst.instanceId}
              instance={inst}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}

      <AddProviderDialog
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
      />
    </div>
  );
}
