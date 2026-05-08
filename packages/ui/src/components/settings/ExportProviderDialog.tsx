import { useState } from 'react';
import { getPlatformAdapter } from '@opendirector/core/adapters';
import { getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import { getErrorMessage } from '@opendirector/core/utils/common';
import { Modal } from '../common/Modal';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ExportProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExportProviderDialog({ isOpen, onClose }: ExportProviderDialogProps) {
  const { t } = useTranslation();
  const instances = useProviderInstanceStore((s) => s.instances);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [success, setSuccess] = useState(false);

  // Only enabled providers that have _encPassword
  const exportableInstances = instances.filter((inst) => {
    const config = inst.config as Record<string, string>;
    return inst.enabled && config?._encPassword;
  });

  // Enabled providers without _encPassword (warning only)
  const warningInstances = instances.filter((inst) => {
    const config = inst.config as Record<string, string>;
    return inst.enabled && !config?._encPassword;
  });

  const handleClose = () => {
    if (exporting) return;
    setPassword('');
    setConfirmPassword('');
    setError('');
    setSuccess(false);
    onClose();
  };

  const handleExport = async () => {
    if (exportableInstances.length === 0) {
      setError(t('settings.providerErrors.noExportable'));
      return;
    }

    if (password.length < 6) {
      setError(t('settings.providerErrors.exportPasswordTooShort'));
      return;
    }

    if (password !== confirmPassword) {
      setError(t('settings.providerErrors.passwordMismatch'));
      return;
    }

    setExporting(true);
    setError('');

    try {
      const adapter = await getPlatformAdapter();
      const filePath = await adapter.fs.saveFile(
        `opendirector-providers-${Date.now()}.odprovider`,
        [{ name: t('common.fileFilters.provider'), extensions: ['odprovider'] }],
      );

      if (!filePath) {
        setExporting(false);
        return;
      }

      const providers = exportableInstances.map((inst) => {
        const config = inst.config as Record<string, string>;
        const typeDef = getProviderTypeRegistry().get(inst.typeId);
        const cleanConfig: Record<string, string> = {};

        // Exclude password-type fields (sensitive, stored in encrypted_credentials)
        if (typeDef?.credentialFields) {
          for (const field of typeDef.credentialFields) {
            if (field.type !== 'password') {
              const val = config[field.key];
              if (val !== undefined && val !== null && val !== '') {
                cleanConfig[field.key] = val;
              }
            }
          }
        }

        // Include model-specific config fields
        for (const [key, value] of Object.entries(config)) {
          if (key.startsWith('model:') && value !== undefined && value !== null && value !== '') {
            cleanConfig[key] = value;
          }
        }

        return {
          provider_id: inst.instanceId,
          master_password: config._encPassword,
          type_id: inst.typeId,
          display_name: inst.displayName,
          config: cleanConfig,
        };
      });

      await tauriBridge.providerConfig.exportMulti(
        providers,
        password,
        filePath,
      );

      setSuccess(true);
      setTimeout(handleClose, 1500);
    } catch (err) {
      setError(getErrorMessage(err, t('settings.providerErrors.exportFailed')));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={t('settings.provider.exportTitle')} size="md">
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="p-2 bg-green-500/10 border border-green-500/30 rounded text-sm text-green-400">
            {t('settings.provider.exportSuccess')}
          </div>
        )}

        {warningInstances.length > 0 && (
          <div className="flex items-start gap-2 p-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-sm text-yellow-400">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{t('settings.provider.exportWarning', { count: warningInstances.length })}</span>
          </div>
        )}

        {exportableInstances.length > 0 ? (
          <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-700 space-y-1.5">
            <p className="text-sm text-zinc-400 mb-2">
              {t('settings.provider.exportCount', { count: exportableInstances.length })}
            </p>
            {exportableInstances.map((inst) => (
              <ExportProviderRow key={inst.instanceId} instance={inst} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 text-center py-4">
            {t('settings.provider.noExportable')}
          </p>
        )}

        <Input
          label={t('settings.provider.exportPassword')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('settings.provider.exportPasswordPlaceholder')}
        />

        <Input
          label={t('settings.provider.confirmPassword')}
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder={t('settings.provider.confirmPasswordPlaceholder')}
        />

        <div className="flex gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={exporting} className="flex-1">
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleExport}
            disabled={exporting || success || exportableInstances.length === 0}
            className="flex-1"
          >
            {exporting ? t('settings.provider.exporting') : success ? t('common.success') : t('common.export')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ExportProviderRow({ instance }: { instance: ProviderInstance }) {
  const typeDef = getProviderTypeRegistry().get(instance.typeId);
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-white">{instance.displayName}</span>
      {typeDef && (
        <span className="text-xs text-zinc-500">{typeDef.name}</span>
      )}
    </div>
  );
}
