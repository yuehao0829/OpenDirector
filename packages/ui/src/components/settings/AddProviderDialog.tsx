import { useState, useEffect } from 'react';
import { getProviderRuntimeRegistry, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import type { AssetGroup } from '@opendirector/core/types/ai-video';
import type { CredentialFieldDef, ModelConfigFieldDef } from '@opendirector/core/types/provider-system';
import { Modal } from '../common/Modal';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { CredentialFormField } from './CredentialFormField';
import { AssetGroupSelector } from './AssetGroupSelector';
import { Panel } from '../layout/Panel';
import { AlertCircle } from 'lucide-react';

interface AddProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddProviderDialog({ isOpen, onClose }: AddProviderDialogProps) {
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

  const handleRefreshGroups = async () => {
    // Validate required fields for asset
    const ak = credentials.ak?.trim();
    const sk = credentials.sk?.trim();
    const region = credentials.region?.trim();
    const assetEndpoint = credentials.asset_endpoint?.trim();
    const assetProject = credentials.asset_project?.trim();

    if (!ak || !sk || !region) {
      setError('请先填写 Access Key ID、Secret Access Key 和 Region');
      return;
    }
    if (!assetEndpoint && !assetProject) {
      // Neither TOS nor Asset filled — nothing to validate
      setError('请先填写 Asset Endpoint 或 Asset Project');
      return;
    }

    setValidating(true);
    setError('');

    try {
      // If TOS fields are filled, validate with HeadBucket first
      const tosEndpoint = credentials.tos_endpoint?.trim();
      const tosBucket = credentials.tos_bucket?.trim();
      if (tosEndpoint && tosBucket) {
        const result = await tauriBridge.tosApi.validateTosCredentials(
          ak, sk, tosBucket, tosEndpoint, region,
        );
        if (!result.valid) {
          setError(`TOS 验证失败: ${result.message}`);
          return;
        }
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
          setError('创建实例失败');
          return;
        }

        instanceId = instance.instanceId;

        // Save .enc file
        encPassword = await tauriBridge.providerKey.saveVolcengineCredentials(
          instanceId,
          {
            ak, sk, region,
            tosEndpoint,
            tosBucket,
            assetEndpoint: assetEndpoint || undefined,
            assetProject: assetProject || undefined,
          },
        );

        // Update instance config with enc password
        useProviderInstanceStore.getState().updateInstance(instanceId, {
          config: { ...credentials, _encPassword: encPassword, sk: '' },
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
      setError(err instanceof Error ? err.message : '刷新 Group 列表失败');
    } finally {
      setValidating(false);
      setLoadingGroups(false);
    }
  };

  const handleSubmit = async () => {
    if (!selectedType) {
      setError('请选择 Provider 类型');
      return;
    }
    if (!displayName.trim()) {
      setError('请输入显示名称');
      return;
    }

    if (pendingInstanceId) {
      // Update display name if changed
      if (pendingInstanceId) {
        useProviderInstanceStore.getState().updateInstance(pendingInstanceId, {
          displayName: displayName.trim(),
          config: {
            ...credentials,
            _encPassword: pendingEncPassword,
            sk: '',
          },
        });
      }
      resetAndClose();
      return;
    }

    // Validate required credential fields (only non-hidden, common section)
    for (const field of selectedType.credentialFields ?? []) {
      if (field.required && field.type !== 'hidden' && !credentials[field.key]?.trim()) {
        setError(`请填写 ${field.label}`);
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

    const isVolcengine = selectedType.typeId === BUILTIN_TYPE_IDS.VOLCENGINE;
    if (isVolcengine) setValidating(true);

    try {
      if (isVolcengine) {
        // TOS validation: only if TOS fields are filled
        const tosEndpoint = credentials.tos_endpoint?.trim();
        const tosBucket = credentials.tos_bucket?.trim();
        if (tosEndpoint && tosBucket) {
          const result = await tauriBridge.tosApi.validateTosCredentials(
            credentials.ak, credentials.sk, tosBucket, tosEndpoint, credentials.region,
          );
          if (!result.valid) {
            setError(result.message);
            return;
          }
        }
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
        if (isVolcengine) {
          const encPassword = await tauriBridge.providerKey.saveVolcengineCredentials(
            instance.instanceId,
            {
              ak: credentials.ak,
              sk: credentials.sk,
              region: credentials.region,
              tosEndpoint: credentials.tos_endpoint || undefined,
              tosBucket: credentials.tos_bucket || undefined,
              assetEndpoint: credentials.asset_endpoint || undefined,
              assetProject: credentials.asset_project || undefined,
              assetGroupName: credentials.asset_group_name || undefined,
              assetGroupId: credentials.asset_group_id || undefined,
            },
          );
          useProviderInstanceStore.getState().updateInstance(instance.instanceId, {
            config: { ...config, _encPassword: encPassword, sk: '' },
          });
        } else if (selectedType.typeId === BUILTIN_TYPE_IDS.SEEDANCE) {
          const encPassword = await tauriBridge.providerKey.saveSeedanceCredentials(
            instance.instanceId, credentials.apiKey, credentials.base_url,
          );
          useProviderInstanceStore.getState().updateInstance(instance.instanceId, {
            config: { ...config, _encPassword: encPassword, apiKey: '' },
          });
        }
      } catch (err: unknown) {
        // .enc save failed — remove orphaned instance
        useProviderInstanceStore.getState().removeInstance(instance.instanceId);
        setError(err instanceof Error ? err.message : '保存凭证失败');
        return;
      }

      getProviderRuntimeRegistry().initializeInstance(
        useProviderInstanceStore.getState().get(instance.instanceId)!,
      ).catch((err) => console.error('[AddProvider] Failed to initialize provider:', err));

      resetAndClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '验证失败');
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
  const isVolcengine = selectedType?.typeId === BUILTIN_TYPE_IDS.VOLCENGINE;

  const commonFields = credFields.filter((f) => f.section === 'common' || (!f.section && f.type !== 'hidden'));
  const tosFields = credFields.filter((f) => f.section === 'tos');
  const assetFields = credFields.filter((f) => f.section === 'asset' && f.type !== 'hidden');

  return (
    <Modal isOpen={isOpen} onClose={handleCancel} title="添加 Provider">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {error && (
          <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Vendor selection */}
        <div className="space-y-1">
          <label className="text-sm font-medium text-zinc-300">厂商</label>
          <select
            value={selectedTypeId}
            onChange={(e) => handleTypeChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm
              focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>选择厂商...</option>
            {allTypes.map((t) => (
              <option key={t.typeId} value={t.typeId}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        {/* Display name */}
        {selectedType && (
          <Input
            label="显示名称"
            value={displayName}
            onChange={(e) => { setDisplayName(e.target.value); setError(''); }}
            placeholder="请输入显示名称"
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
              <Panel title="对象存储 TOS" defaultCollapsed collapsible>
                <div className="space-y-3">
                  {tosFields.map((field) => (
                    <CredentialFormField
                      key={field.key}
                      label={field.label}
                      fieldKey={field.key}
                      type={field.type}
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
              <Panel title="素材管理 Asset" defaultCollapsed collapsible>
                <div className="space-y-3">
                  {assetFields.map((field) => (
                    <CredentialFormField
                      key={field.key}
                      label={field.label}
                      fieldKey={field.key}
                      type={field.type}
                      value={credentials[field.key] ?? ''}
                      onChange={handleCredentialChange}
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
          <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300">凭证配置</h3>
            {credFields.map((field) => (
              <CredentialFormField
                key={field.key}
                label={field.label}
                fieldKey={field.key}
                type={field.type}
                value={credentials[field.key] ?? ''}
                onChange={handleCredentialChange}
                placeholder={field.placeholder}
                description={field.description}
                required={field.required}
              />
            ))}
          </div>
        )}

        {/* Per-model config fields */}
        {selectedType && modelFields.length > 0 && (
          <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300">模型配置</h3>
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
            <h3 className="text-sm font-medium text-zinc-300">凭证配置</h3>
            <CredentialFormField
              label="API Key"
              fieldKey="apiKey"
              value={credentials.apiKey ?? ''}
              onChange={handleCredentialChange}
              placeholder="输入 API Key"
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
          取消
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={validating || !selectedType}
          className="flex-1"
        >
          {validating ? '验证中...' : pendingInstanceId ? '完成' : '添加'}
        </Button>
      </div>
    </Modal>
  );
}
