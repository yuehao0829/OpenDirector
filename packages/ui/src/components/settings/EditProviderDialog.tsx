import { useState, useEffect, useMemo, useRef } from 'react';
import { getProviderRuntimeRegistry, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import type { AssetGroup } from '@opendirector/core/types/ai-video';
import type { ProviderInstance } from '@opendirector/core/types/provider-system';
import { Modal } from '../common/Modal';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { CredentialFormField } from './CredentialFormField';
import { AssetGroupSelector } from './AssetGroupSelector';
import { validateTosIfPresent } from './tos-validation';
import { clearSecretFields } from './credential-config';
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

    // Build config from current credential state + per-model config.
    // Password fields are NOT restored from originalConfig: secrets live only
    // in the .enc file (instance config stores them as ''), so there is nothing
    // to restore — unchanged secrets are preserved by merging into the existing
    // .enc, not by repopulating config.
    const config: Record<string, string> = { ...credentials };
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

    setValidating(true);

    try {
      const credFields = typeDef?.credentialFields ?? [];
      const secretFields = credFields.filter((f) => f.type === 'password');
      // A secret is "rewritten" only when the user typed a new value (masked
      // unchanged secrets render as empty). Unchanged secrets are intentionally
      // left out of the update payload so the existing .enc value is preserved —
      // a full overwrite would blank them, which loses data for provider types
      // with more than one password field.
      const rewritingSecret = secretFields.some((f) => credentials[f.key]?.trim());

      // TOS validation when rewriting a signing secret and both TOS fields are
      // present (typeId-agnostic: gated on field existence). Reported via the
      // shared i18n key, consistent with AddProviderDialog.
      if (rewritingSecret) {
        const tosOutcome = await validateTosIfPresent(config);
        if (!tosOutcome.valid) {
          setError(t('settings.providerErrors.tosValidationFailed', { message: tosOutcome.message }));
          return;
        }
      }

      // Payload = all non-secret fields + any re-entered secret.
      const updates: Record<string, unknown> = {};
      for (const field of credFields) {
        if (field.type === 'password') {
          if (credentials[field.key]?.trim()) updates[field.key] = credentials[field.key];
        } else if (config[field.key] !== undefined) {
          updates[field.key] = config[field.key];
        }
      }

      if (hasEncPassword) {
        // Merge into the existing .enc — unchanged secrets are preserved.
        if (Object.keys(updates).length > 0) {
          const newEncPassword = await tauriBridge.providerKey.updateCredentials(
            instance.instanceId, encPassword, updates,
          );
          config._encPassword = newEncPassword;
        }
      } else {
        // No existing .enc (e.g. imported without secrets) — full save of all
        // declared credential fields (excludes _encPassword / model keys).
        const credentialsToSave: Record<string, string> = {};
        for (const field of credFields) {
          const val = config[field.key];
          if (val !== undefined && val !== null) {
            credentialsToSave[field.key] = val;
          }
        }
        const newEncPassword = await tauriBridge.providerKey.save(
          instance.instanceId,
          credentialsToSave,
        );
        config._encPassword = newEncPassword;
      }

      // Clear re-entered secrets from the persisted config (now in .enc).
      // Unconditional clear matches the prior "only non-empty" guard:
      // unchanged secrets already hold '' in the masked form state.
      clearSecretFields(config, credFields);

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

  const hasSections = credFields.some((f) => f.section);
  const hasAssetGroupField = credFields.some((f) => f.key === 'asset_group_id');

  const commonFields = credFields.filter((f) => f.section === 'common' || (!f.section && f.type !== 'hidden'));
  const tosFields = credFields.filter((f) => f.section === 'tos');
  const assetFields = credFields.filter((f) => f.section === 'asset' && f.type !== 'hidden');

  const basicFields = credFields.filter((f) => !f.advanced);
  const advancedFields = credFields.filter((f) => f.advanced);

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
                    options={field.options}
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
                      options={field.options}
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
                      options={field.options}
                      value={credentials[field.key] ?? ''}
                      onChange={handleCredentialChange}
                      masked
                      configured={hasEncPassword}
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
                  masked
                  configured={hasEncPassword}
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
          </>
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
              fieldKey="api_key"
              value={credentials.api_key ?? ''}
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
