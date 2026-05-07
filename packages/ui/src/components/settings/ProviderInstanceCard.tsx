import { useState } from 'react';
import { getProviderRuntimeRegistry, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import { Settings, Trash2, Power, PowerOff, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ProviderInstanceCardProps {
  instance: ProviderInstance;
  onEdit: (instance: ProviderInstance) => void;
}

export function ProviderInstanceCard({ instance, onEdit }: ProviderInstanceCardProps) {
  const { t } = useTranslation();
  const updateInstance = useProviderInstanceStore((s) => s.updateInstance);
  const removeInstance = useProviderInstanceStore((s) => s.removeInstance);
  const defaultAssetProviderId = useProviderInstanceStore((s) => s.defaultAssetProviderId);
  const setDefaultAssetProvider = useProviderInstanceStore((s) => s.setDefaultAssetProvider);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const typeDef = getProviderTypeRegistry().get(instance.typeId);
  const isAssetProvider = typeDef?.providerType === 'asset';
  const isDefault = isAssetProvider && defaultAssetProviderId === instance.instanceId;

  const handleToggleEnabled = () => {
    updateInstance(instance.instanceId, { enabled: !instance.enabled });
  };

  const handleSetDefault = () => {
    setDefaultAssetProvider(instance.instanceId);
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    getProviderRuntimeRegistry().dispose(instance.instanceId);
    try {
      await tauriBridge.providerKey.remove(instance.instanceId);
    } catch (err) {
      console.warn('[ProviderInstanceCard] Failed to remove .enc file:', err);
    }
    removeInstance(instance.instanceId);
  };

  const modelCount = typeDef?.modelFamilies.reduce(
    (sum, f) => sum + f.models.length, 0
  ) ?? 0;

  return (
    <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-700 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white">{instance.displayName}</span>
          {!instance.enabled && (
            <span className="text-xs px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded">{t('settings.provider.disabled')}</span>
          )}
          {isAssetProvider && isDefault && (
            <span className="text-xs px-1.5 py-0.5 bg-amber-900/50 text-amber-400 rounded flex items-center gap-0.5">
              <Star size={10} className="fill-amber-400" />
              {t('settings.provider.default')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isAssetProvider && !isDefault && (
            <button
              onClick={handleSetDefault}
              className="p-1.5 text-zinc-400 hover:text-amber-400 transition-colors rounded"
              title={t('settings.provider.setDefaultAssetStorage')}
            >
              <Star size={14} />
            </button>
          )}
          <button
            onClick={handleToggleEnabled}
            className="p-1.5 text-zinc-400 hover:text-white transition-colors rounded"
            title={instance.enabled ? t('settings.provider.disable') : t('settings.provider.enable')}
          >
            {instance.enabled ? <Power size={14} /> : <PowerOff size={14} />}
          </button>
          <button
            onClick={() => onEdit(instance)}
            className="p-1.5 text-zinc-400 hover:text-white transition-colors rounded"
            title={t('common.edit')}
          >
            <Settings size={14} />
          </button>
          <button
            onClick={handleDelete}
            className={`p-1.5 transition-colors rounded ${
              confirmDelete
                ? 'text-white bg-red-500 hover:bg-red-600'
                : 'text-zinc-400 hover:text-red-400'
            }`}
            title={confirmDelete ? t('settings.provider.clickAgainDelete') : t('common.delete')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="text-xs text-zinc-500 space-y-0.5">
        {modelCount > 0 && <div>{t('settings.provider.modelCount', { count: modelCount })}</div>}
        <div>{t('settings.provider.createdAt', { date: new Date(instance.createdAt).toLocaleDateString() })}</div>
      </div>
    </div>
  );
}
