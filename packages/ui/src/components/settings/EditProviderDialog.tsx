import { useState, useEffect, useMemo, useRef } from 'react';
import { getProviderRuntimeRegistry, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import type { AssetGroup } from '@opendirector/core/types/ai-video';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import { Modal } from '../common/Modal';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { CredentialFormField } from './CredentialFormField';
import { AssetGroupSelector } from './AssetGroupSelector';
import { Panel } from '../layout/Panel';
import { useTranslation } from 'react-i18next';

interface EditProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  instance: ProviderInstance | null;
}

export function EditProviderDialog({ isOpen, onClose, instance }: EditProviderDialogProps) {
  const { t } = useTranslation();
  const updateInstance = useProviderInstanceStore((s) => s.updateInstance);
  const [displayName, setDisplayName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [originalConfig, setOriginalConfig] = useState<Record<string, string>>({});
  const [modelConfig, setModelConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [validating, setValidating] = useState(false);

  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);

  const typeDef = useMemo(
    () => (instance ? getProviderTypeRegistry().get(instance.typeId) : null),
    [instance],
  );

  const isVolcengine = typeDef?.typeId === BUILTIN_TYPE_IDS.VOLCENGINE;
  const encPassword = (instance?.config as Record<string, string>)?._encPassword ?? '';
  const hasEncPassword = !!encPassword;

  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;

  useEffect(() => {
    if (!instance) return;

    setDisplayName(instance.displayName);

    const config = instance.config as Record<string, string>;

    const modelPrefix = 'model:';
    const creds: Record<string, string> = {};
    const mConfig: Record<string, string> = {};

    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith(modelPrefix)) {
        mConfig[key] = value;
      } else {
        creds[key] = value;
      }
    }

    setCredentials(creds);
    setOriginalConfig(creds);
    setModelConfig(mConfig);
  }, [instance]);

  useEffect(() => {
    if (!isOpen) {
      setGroups([]);
    }
  }, [isOpen]);

  // Groups are fetched only when user clicks refresh button, not on dialog open

  const handleCredentialChange = (key: string, value: string) => {
    setCredentials((prev) => ({ ...prev, [key]: value }));
  };

  const handleModelConfigChange = (key: string, value: string) => {
    setModelConfig((prev) => ({ ...prev, [key]: value }));
  };

  const fetchGroups = async () => {
    if (!instance || !encPassword) return;
    setLoadingGroups(true);
    try {
      const projectName = credentialsRef.current.asset_project || 'default';
      const result = await tauriBridge.seedanceApi.listAssetGroups(
        instance.instanceId,
        encPassword,
        projectName,
      );
      setGroups(result.groups);
    } catch (err) {
      console.error('[EditProvider] Failed to fetch groups:', err);
      setGroups([]);
    } finally {
      setLoadingGroups(false);
    }
  };

  const handleSubmit = async () => {
    if (!instance) return;
    if (!displayName.trim()) {
      setError(t('settings.providerErrors.displayNameRequired'));
      return;
    }

    // Validate required credential fields (skip hidden fields, skip if stored in .enc)
    for (const field of typeDef?.credentialFields ?? []) {
      if (field.required && field.type !== 'hidden' && !credentials[field.key]?.trim() && !originalConfig[field.key]?.trim() && !hasEncPassword) {
        setError(t('settings.providerErrors.fillField', { label: field.label }));
        return;
      }
    }

    // Build config: restore masked password fields that were not explicitly changed
    const config: Record<string, string> = { ...credentials };
    for (const field of typeDef?.credentialFields ?? []) {
      if (
        field.type === 'password' &&
        !credentials[field.key]?.trim() &&
        originalConfig[field.key]?.trim()
      ) {
        config[field.key] = originalConfig[field.key];
      }
    }
    if (typeDef?.modelConfigFields?.length) {
      for (const family of typeDef.modelFamilies) {
        for (const model of family.models) {
          for (const field of typeDef.modelConfigFields) {
            const stateKey = `${model.modelId}:${field.key}`;
            const val = modelConfig[`model:${stateKey}`]?.trim();
            if (val) {
              config[`model:${stateKey}`] = val;
            }
          }
        }
      }
    }

    if (isVolcengine) setValidating(true);

    try {
      if (typeDef?.typeId === BUILTIN_TYPE_IDS.SEEDANCE || typeDef?.typeId === BUILTIN_TYPE_IDS.OPENAI_IMAGE) {
        const apiKeyWasMasked = !credentials.apiKey?.trim() && (hasEncPassword || !!originalConfig.apiKey?.trim());

        if (apiKeyWasMasked) {
          const updates: Record<string, unknown> = {};
          if (config.base_url !== undefined) updates.base_url = config.base_url;

          if (Object.keys(updates).length > 0) {
            const newEncPassword = await tauriBridge.providerKey.updateCredentials(
              instance.instanceId, encPassword, updates,
            );
            config._encPassword = newEncPassword;
          }
        } else {
          const newEncPassword = await tauriBridge.providerKey.saveApiCredentials(
              instance.instanceId, credentials.apiKey, config.base_url ?? '',
            );
          config._encPassword = newEncPassword;
          config.apiKey = '';
        }
      } else if (isVolcengine) {
        const skWasMasked = !credentials.sk?.trim() && (hasEncPassword || !!originalConfig.sk?.trim());

        if (skWasMasked) {
          // Update only — SK not changed
          const updates: Record<string, unknown> = {};
          if (config.asset_project !== undefined) updates.asset_project = config.asset_project;
          if (config.asset_group_name !== undefined) updates.asset_group_name = config.asset_group_name;
          if (config.asset_group_id !== undefined) updates.asset_group_id = config.asset_group_id;
          if (config.ak !== undefined) updates.ak = config.ak;
          if (config.region !== undefined) updates.region = config.region;
          if (config.tos_endpoint !== undefined) updates.tos_endpoint = config.tos_endpoint;
          if (config.tos_bucket !== undefined) updates.tos_bucket = config.tos_bucket;
          if (config.asset_endpoint !== undefined) updates.asset_endpoint = config.asset_endpoint;

          const newEncPassword = await tauriBridge.providerKey.updateCredentials(
            instance.instanceId, encPassword, updates,
          );
          config._encPassword = newEncPassword;
        } else {
          // Full re-save with new SK
          const ak = config.ak ?? '';
          const sk = config.sk ?? '';
          const region = config.region ?? '';
          const tosEndpoint = config.tos_endpoint || undefined;
          const tosBucket = config.tos_bucket || undefined;
          const assetEndpoint = config.asset_endpoint || undefined;
          const assetProject = config.asset_project || undefined;
          const assetGroupName = config.asset_group_name || undefined;
          const assetGroupId = config.asset_group_id || undefined;

          // Only validate TOS if TOS fields are filled
          const tosFilled = !!(tosEndpoint && tosBucket);
          if (tosFilled) {
            setError('');
            const result = await tauriBridge.tosApi.validateTosCredentials(
              ak, sk, tosBucket!, tosEndpoint!, region,
            );
            if (!result.valid) {
              setError(result.message);
              return;
            }
          }

          const newEncPassword = await tauriBridge.providerKey.saveVolcengineCredentials(
            instance.instanceId,
            { ak, sk, region, tosEndpoint, tosBucket, assetEndpoint, assetProject, assetGroupName, assetGroupId },
          );
          config._encPassword = newEncPassword;
          config.sk = '';
        }
      }

      updateInstance(instance.instanceId, {
        displayName: displayName.trim(),
        config,
      });

      getProviderRuntimeRegistry().reinitializeInstance(instance.instanceId).catch((err) =>
        console.error('[EditProvider] Failed to reinitialize provider:', err),
      );

      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings.providerErrors.saveCredentialsFailed'));
    } finally {
      setValidating(false);
    }
  };

  const handleClose = () => {
    setError('');
    onClose();
  };

  if (!instance || !typeDef) return null;

  const credFields = typeDef.credentialFields ?? [];
  const modelFields = typeDef.modelConfigFields ?? [];
  const hasDeclarativeFields = credFields.length > 0 || modelFields.length > 0;

  // Check if the type uses sections (like volcengine)
  const hasSections = credFields.some((f) => f.section);

  const commonFields = credFields.filter((f) => f.section === 'common' || (!f.section && f.type !== 'hidden'));
  const tosFields = credFields.filter((f) => f.section === 'tos');
  const assetFields = credFields.filter((f) => f.section === 'asset' && f.type !== 'hidden');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={t('settings.provider.editTitle')}>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {error && (
          <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
            {error}
          </div>
        )}

        <Input
          label={t('settings.provider.displayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('settings.provider.providerDisplayNamePlaceholder')}
        />

        {/* Sectioned credential fields (volcengine) */}
        {hasSections && (
          <>
            {/* Common section */}
            {commonFields.length > 0 && (
              <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
                {commonFields.map((field) => (
                  <CredentialFormField
                    key={field.key}
                    label={field.label}
                    fieldKey={field.key}
                    type={field.type}
                    value={credentials[field.key] ?? ''}
                    onChange={handleCredentialChange}
                    masked
                    configured={hasEncPassword}
                    placeholder={field.placeholder}
                    description={field.description}
                    required={field.required}
                  />
                ))}
              </div>
            )}

            {/* TOS section */}
            {tosFields.length > 0 && (
              <Panel title={t('settings.provider.tosSection')} defaultCollapsed collapsible>
                <div className="space-y-3">
                  {tosFields.map((field) => (
                    <CredentialFormField
                      key={field.key}
                      label={field.label}
                      fieldKey={field.key}
                      type={field.type}
                      value={credentials[field.key] ?? ''}
                      onChange={handleCredentialChange}
                      masked
                      configured={hasEncPassword}
                      placeholder={field.placeholder}
                      description={field.description}
                      required={field.required}
                    />
                  ))}
                </div>
              </Panel>
            )}

            {/* Asset section */}
            {assetFields.length > 0 && (
              <Panel title={t('settings.provider.assetSection')} defaultCollapsed collapsible>
                <div className="space-y-3">
                  {assetFields.map((field) => (
                    <CredentialFormField
                      key={field.key}
                      label={field.label}
                      fieldKey={field.key}
                      type={field.type}
                      value={credentials[field.key] ?? ''}
                      onChange={handleCredentialChange}
                      masked
                      configured={hasEncPassword}
                      placeholder={field.placeholder}
                      description={field.description}
                      required={field.required}
                    />
                  ))}

                  {isVolcengine && (
                    <AssetGroupSelector
                      groups={groups}
                      selectedGroupId={credentials.asset_group_id ?? ''}
                      selectedGroupName={credentials.asset_group_name ?? ''}
                      loading={loadingGroups}
                      onGroupChange={(gid, name) => {
                        handleCredentialChange('asset_group_id', gid);
                        handleCredentialChange('asset_group_name', name);
                      }}
                      onGroupNameChange={(name) => handleCredentialChange('asset_group_name', name)}
                      onRefresh={fetchGroups}
                    />
                  )}
                </div>
              </Panel>
            )}
          </>
        )}

        {/* Non-sectioned declarative credential fields */}
        {!hasSections && hasDeclarativeFields && (
          <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300">{t('settings.provider.credentialConfig')}</h3>
            {credFields.map((field) => (
              <CredentialFormField
                key={field.key}
                label={field.label}
                fieldKey={field.key}
                type={field.type}
                value={credentials[field.key] ?? ''}
                onChange={handleCredentialChange}
                masked
                configured={hasEncPassword}
                placeholder={field.placeholder}
                description={field.description}
                required={field.required}
              />
            ))}
          </div>
        )}

        {/* Per-model config fields */}
        {modelFields.length > 0 && (
          <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300">{t('settings.provider.modelConfig')}</h3>
            {typeDef.modelFamilies.flatMap((f) => f.models).map((model) => (
              <div key={model.modelId} className="space-y-2">
                <p className="text-sm text-zinc-300 font-medium">{model.name}</p>
                {modelFields.map((field) => {
                  const stateKey = `${model.modelId}:${field.key}`;
                  return (
                    <CredentialFormField
                      key={stateKey}
                      label={field.label}
                      fieldKey={`model:${stateKey}`}
                      type="text"
                      value={modelConfig[`model:${stateKey}`] ?? ''}
                      onChange={handleModelConfigChange}
                      placeholder={field.placeholder ?? model.metadata?.arkModelId}
                      description={field.description}
                      required={field.required}
                      size="xs"
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Fallback: single API Key when no declarative fields */}
        {!hasDeclarativeFields && (
          <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300">{t('settings.provider.credentialConfig')}</h3>
            <CredentialFormField
              label={t('settings.provider.apiKeyLabel')}
              fieldKey="apiKey"
              value={credentials.apiKey ?? ''}
              onChange={handleCredentialChange}
              masked
              configured={hasEncPassword}
              placeholder={t('settings.provider.apiKeyPlaceholder')}
              required
            />
          </div>
        )}
      </div>

      {/* Buttons — always visible, outside scroll area */}
      <div className="flex gap-2 pt-4 mt-2 border-t border-zinc-700">
        <Button variant="ghost" onClick={handleClose} disabled={validating} className="flex-1">
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={validating} className="flex-1">
          {validating ? t('common.validating') : t('common.save')}
        </Button>
      </div>
    </Modal>
  );
}
