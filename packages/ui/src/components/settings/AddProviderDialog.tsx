import { useState, useEffect } from 'react';
import { getProviderRuntimeRegistry, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import type { AssetGroup } from '@opendirector/core/types/ai-video';
import type { CredentialFieldDef, ModelConfigFieldDef } from '@opendirector/core/types/provider-system';
import { Modal } from '../common/Modal';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { CredentialFormField } from './CredentialFormField';
import { AssetGroupSelector } from './AssetGroupSelector';
import { validateTosIfPresent } from './tos-validation';
import { clearSecretFields } from './credential-config';
import { Panel } from '../layout/Panel';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface AddProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddProviderDialog({ isOpen, onClose }: AddProviderDialogProps) {
  const { t } = useTranslation();
  const addInstance = useProviderInstanceStore((s) => s.addInstance);
  const instances = useProviderInstanceStore((s) => s.instances);

  const [selectedTypeId, setSelectedTypeId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [modelConfig, setModelConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [validating, setValidating] = useState(false);

  // Volcengine Asset Group state
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [pendingInstanceId, setPendingInstanceId] = useState<string>('');
  const [pendingEncPassword, setPendingEncPassword] = useState('');

  const allTypes = getProviderTypeRegistry().getAll();
  const selectedType = getProviderTypeRegistry().get(selectedTypeId);

  // Auto-fill display name: use vendor name for first instance of that type
  useEffect(() => {
    if (!selectedTypeId) {
      setDisplayName('');
      return;
    }
    const typeDef = getProviderTypeRegistry().get(selectedTypeId);
    if (!typeDef) return;

    const hasExisting = instances.some((inst) => inst.typeId === selectedTypeId);
    if (hasExisting) {
      setDisplayName('');
    } else {
      setDisplayName(typeDef.name);
    }
  }, [selectedTypeId, instances]);

  // Pre-fill default values when type changes
  useEffect(() => {
    if (!selectedType) return;

    const creds: Record<string, string> = {};
    for (const field of selectedType.credentialFields ?? []) {
      if (field.defaultValue !== undefined) {
        creds[field.key] = field.defaultValue;
      }
    }
    setCredentials(creds);
    setGroups([]);
    setPendingInstanceId('');
    setPendingEncPassword('');
  }, [selectedType]);

  const handleCredentialChange = (key: string, value: string) => {
    setCredentials((prev) => ({ ...prev, [key]: value }));
  };

  const handleModelConfigChange = (key: string, value: string) => {
    setModelConfig((prev) => ({ ...prev, [key]: value }));
  };

  // Build the persisted instance config from `base`, stamping in the encrypted
  // password and clearing every password-type field (secrets live in the .enc
  // file). TypeId-agnostic: iterates the selected type's declarative fields.
  const configWithSecretsCleared = (
    base: Record<string, string>,
    encPassword: string,
  ): Record<string, string> => {
    const next: Record<string, string> = { ...base, _encPassword: encPassword };
    clearSecretFields(next, selectedType?.credentialFields ?? []);
    return next;
  };

  const handleRefreshGroups = async () => {
    // Validate required fields for asset
    const ak = credentials.ak?.trim();
    const sk = credentials.sk?.trim();
    const region = credentials.region?.trim();
    const assetEndpoint = credentials.asset_endpoint?.trim();
    const assetProject = credentials.asset_project?.trim();

    if (!ak || !sk || !region) {
      setError(t('settings.providerErrors.fillTosBase'));
      return;
    }
    if (!assetEndpoint && !assetProject) {
      // Neither TOS nor Asset filled — nothing to validate
      setError(t('settings.providerErrors.fillAssetTarget'));
      return;
    }

    setValidating(true);
    setError('');

    try {
      // If TOS fields are filled, validate with HeadBucket first.
      const tosOutcome = await validateTosIfPresent(credentials);
      if (!tosOutcome.valid) {
        setError(t('settings.providerErrors.tosValidationFailed', { message: tosOutcome.message }));
        return;
      }

      // Create instance + save .enc if not already created
      let instanceId = pendingInstanceId;
      let encPassword = pendingEncPassword;

      if (!pendingInstanceId) {
        // Add instance to store
        addInstance({
          typeId: BUILTIN_TYPE_IDS.VOLCENGINE,
          displayName: displayName.trim() || 'Volcengine',
          order: useProviderInstanceStore.getState().instances.length,
          enabled: true,
          config: { ...credentials },
        });

        const instance = useProviderInstanceStore.getState().instances[
          useProviderInstanceStore.getState().instances.length - 1
        ];
        if (!instance) {
          setError(t('settings.providerErrors.createInstanceFailed'));
          return;
        }

        instanceId = instance.instanceId;

        // Save .enc file. Type-agnostic: `credentials` already uses storage
        // keys, so it serializes directly to a valid credentials JSON.
        encPassword = await tauriBridge.providerKey.save(instanceId, credentials);

        // Update instance config with enc password, clearing secret fields.
        useProviderInstanceStore.getState().updateInstance(instanceId, {
          config: configWithSecretsCleared(credentials, encPassword),
        });

        // Initialize runtime
        await getProviderRuntimeRegistry().initializeInstance(
          useProviderInstanceStore.getState().get(instanceId)!,
        );

        setPendingInstanceId(instanceId);
        setPendingEncPassword(encPassword);
      }

      // Fetch group list
      setLoadingGroups(true);
      const projectName = assetProject || 'default';
      const result = await tauriBridge.seedanceApi.listAssetGroups(
        instanceId,
        encPassword,
        projectName,
      );
      setGroups(result.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.providerErrors.refreshGroupsFailed'));
    } finally {
      setValidating(false);
      setLoadingGroups(false);
    }
  };

  const handleSubmit = async () => {
    if (!selectedType) {
      setError(t('settings.providerErrors.chooseType'));
      return;
    }
    if (!displayName.trim()) {
      setError(t('settings.providerErrors.displayNameRequired'));
      return;
    }

    if (pendingInstanceId) {
      // Instance + .enc already created during the asset-group refresh flow;
      // just persist the (secret-cleared) config + display name.
      useProviderInstanceStore.getState().updateInstance(pendingInstanceId, {
        displayName: displayName.trim(),
        config: configWithSecretsCleared(credentials, pendingEncPassword),
      });
      resetAndClose();
      return;
    }

    // Validate required credential fields (only non-hidden, common section)
    for (const field of selectedType.credentialFields ?? []) {
      if (field.required && field.type !== 'hidden' && !credentials[field.key]?.trim()) {
        setError(t('settings.providerErrors.fillField', { label: field.label }));
        return;
      }
    }

    const config: Record<string, string> = {
      ...credentials,
    };

    if (selectedType.modelConfigFields?.length) {
      for (const family of selectedType.modelFamilies) {
        for (const model of family.models) {
          for (const field of selectedType.modelConfigFields) {
            const stateKey = `${model.modelId}:${field.key}`;
            const val = modelConfig[`model:${stateKey}`]?.trim();
            if (val) {
              config[`model:${stateKey}`] = val;
            }
          }
        }
      }
    }

    setValidating(true);

    try {
      // TOS validation, typeId-agnostic: gated on both TOS fields being present
      // (only Volcengine declares them today). The helper trims consistently
      // with handleRefreshGroups.
      const tosOutcome = await validateTosIfPresent(credentials);
      if (!tosOutcome.valid) {
        setError(t('settings.providerErrors.tosValidationFailed', { message: tosOutcome.message }));
        return;
      }

      addInstance({
        typeId: selectedType.typeId,
        displayName: displayName.trim(),
        order: useProviderInstanceStore.getState().instances.length,
        enabled: true,
        config,
      });

      const instance = useProviderInstanceStore.getState().instances[
        useProviderInstanceStore.getState().instances.length - 1
      ];
      if (!instance) return;

      try {
        // Type-agnostic full save: `credentials` already uses storage keys, so
        // it serializes directly to a valid credentials JSON. save() generates
        // the encryption password internally and returns it.
        const encPassword = await tauriBridge.providerKey.save(
          instance.instanceId,
          credentials,
        );
        useProviderInstanceStore.getState().updateInstance(instance.instanceId, {
          config: configWithSecretsCleared(config, encPassword),
        });
      } catch (err: unknown) {
        // .enc save failed — remove orphaned instance
        useProviderInstanceStore.getState().removeInstance(instance.instanceId);
        setError(err instanceof Error ? err.message : t('settings.providerErrors.saveCredentialsFailed'));
        return;
      }

      getProviderRuntimeRegistry().initializeInstance(
        useProviderInstanceStore.getState().get(instance.instanceId)!,
      ).catch((err) => console.error('[AddProvider] Failed to initialize provider:', err));

      resetAndClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings.providerErrors.validationFailed'));
    } finally {
      setValidating(false);
    }
  };

  const handleCancel = async () => {
    // If volcengine instance was created during this session, clean up
    if (pendingInstanceId) {
      try {
        await tauriBridge.providerKey.remove(pendingInstanceId);
      } catch { /* ignore */ }
      useProviderInstanceStore.getState().removeInstance(pendingInstanceId);
    }
    resetAndClose();
  };

  const resetAndClose = () => {
    setSelectedTypeId('');
    setDisplayName('');
    setCredentials({});
    setModelConfig({});
    setError('');
    setGroups([]);
    setPendingInstanceId('');
    setPendingEncPassword('');
    onClose();
  };

  const handleTypeChange = (value: string) => {
    setSelectedTypeId(value);
    setCredentials({});
    setModelConfig({});
    setError('');
  };

  const credFields: CredentialFieldDef[] = selectedType?.credentialFields ?? [];
  const modelFields: ModelConfigFieldDef[] = selectedType?.modelConfigFields ?? [];
  const hasDeclarativeFields = credFields.length > 0 || modelFields.length > 0;

  const hasSections = credFields.some((f) => f.section);
  const hasAssetGroupField = credFields.some((f) => f.key === 'asset_group_id');

  const commonFields = credFields.filter((f) => f.section === 'common' || (!f.section && f.type !== 'hidden'));
  const tosFields = credFields.filter((f) => f.section === 'tos');
  const assetFields = credFields.filter((f) => f.section === 'asset' && f.type !== 'hidden');

  const basicFields = credFields.filter((f) => !f.advanced);
  const advancedFields = credFields.filter((f) => f.advanced);

  return (
    <Modal isOpen={isOpen} onClose={handleCancel} title={t('settings.provider.addTitle')}>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {error && (
          <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Select
          label={t('settings.provider.vendor')}
          value={selectedTypeId}
          onChange={(e) => handleTypeChange(e.target.value)}
          options={allTypes.map((t) => ({ value: t.typeId, label: t.name }))}
          placeholder={t('settings.provider.chooseVendor')}
        />

        {/* Display name */}
        {selectedType && (
          <Input
            label={t('settings.provider.displayName')}
            value={displayName}
            onChange={(e) => { setDisplayName(e.target.value); setError(''); }}
            placeholder={t('settings.provider.displayNamePlaceholder')}
          />
        )}

        {/* Sectioned credential fields (volcengine) */}
        {selectedType && hasSections && (
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
                    options={field.options}
                    value={credentials[field.key] ?? ''}
                    onChange={handleCredentialChange}
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
                      options={field.options}
                      value={credentials[field.key] ?? ''}
                      onChange={handleCredentialChange}
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
                      options={field.options}
                      value={credentials[field.key] ?? ''}
                      onChange={handleCredentialChange}
                      placeholder={field.placeholder}
                      description={field.description}
                      required={field.required}
                    />
                  ))}

                  {hasAssetGroupField && (
                    <AssetGroupSelector
                      groups={groups}
                      selectedGroupId={credentials.asset_group_id ?? ''}
                      selectedGroupName={credentials.asset_group_name ?? ''}
                      loading={loadingGroups}
                      disabled={validating}
                      onGroupChange={(gid, name) => {
                        handleCredentialChange('asset_group_id', gid);
                        handleCredentialChange('asset_group_name', name);
                      }}
                      onGroupNameChange={(name) => handleCredentialChange('asset_group_name', name)}
                      onRefresh={handleRefreshGroups}
                    />
                  )}
                </div>
              </Panel>
            )}
          </>
        )}

        {/* Non-sectioned declarative credential fields (seedance, etc.) */}
        {selectedType && !hasSections && hasDeclarativeFields && (
          <>
            <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
              <h3 className="text-sm font-medium text-zinc-300">{t('settings.provider.credentialConfig')}</h3>
              {basicFields.map((field) => (
                <CredentialFormField
                  key={field.key}
                  label={field.label}
                  fieldKey={field.key}
                  type={field.type}
                  options={field.options}
                  value={credentials[field.key] ?? ''}
                  onChange={handleCredentialChange}
                  placeholder={field.placeholder}
                  description={field.description}
                  required={field.required}
                />
              ))}
            </div>
            {advancedFields.length > 0 && (
              <Panel title={t('settings.provider.advancedOptions')} defaultCollapsed collapsible>
                <div className="space-y-3">
                  {advancedFields.map((field) => (
                    <CredentialFormField
                      key={field.key}
                      label={field.label}
                      fieldKey={field.key}
                      type={field.type}
                      options={field.options}
                      value={credentials[field.key] ?? ''}
                      onChange={handleCredentialChange}
                      placeholder={field.placeholder}
                      description={field.description}
                      required={field.required}
                    />
                  ))}
                </div>
              </Panel>
            )}
          </>
        )}

        {/* Per-model config fields */}
        {selectedType && modelFields.length > 0 && (
          <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300">{t('settings.provider.modelConfig')}</h3>
            {selectedType.modelFamilies.flatMap((f) => f.models).map((model) => (
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
        {selectedType && !hasDeclarativeFields && (
          <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300">{t('settings.provider.credentialConfig')}</h3>
            <CredentialFormField
              label={t('settings.provider.apiKeyLabel')}
              fieldKey="api_key"
              value={credentials.api_key ?? ''}
              onChange={handleCredentialChange}
              placeholder={t('settings.provider.apiKeyPlaceholder')}
              required
            />
          </div>
        )}
      </div>

      {/* Buttons — always visible, outside scroll area */}
      <div className="flex gap-2 pt-4 mt-2 border-t border-zinc-700">
        <Button
          variant="ghost"
          onClick={handleCancel}
          disabled={validating}
          className="flex-1"
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={validating || !selectedType}
          className="flex-1"
        >
          {validating ? t('common.validating') : pendingInstanceId ? t('common.done') : t('common.add')}
        </Button>
      </div>
    </Modal>
  );
}
