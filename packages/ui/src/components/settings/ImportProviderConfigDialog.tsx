import { useState } from 'react';
import { getPlatformAdapter } from '@opendirector/core/adapters';
import { getProviderRuntimeRegistry, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { tauriBridge } from '@opendirector/core/services/tauri-bridge';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import type {
  MultiProviderExportPreview,
  MultiProviderImportEntry,
  ProviderExportFilePreview,
  ProviderImportResult,
} from '@opendirector/core/types/ai-video';
import { generateRandomHexPassword, getErrorMessage } from '@opendirector/core/utils/common';
import { Modal } from '../common/Modal';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { FileDown, ArrowLeft, ArrowRight, AlertCircle, Loader2, CheckCircle2, XCircle } from 'lucide-react';

interface ImportProviderConfigDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Find a unique displayName by appending (2), (3), ... if needed */
function resolveUniqueDisplayName(baseName: string, store: ReturnType<typeof useProviderInstanceStore.getState>): string {
  const existingNames = new Set(store.instances.map((i) => i.displayName));
  if (!existingNames.has(baseName)) return baseName;

  let n = 2;
  while (existingNames.has(`${baseName}(${n})`)) n++;
  return `${baseName}(${n})`;
}

/** Resolve typeId from preview — handles format_version 1 fallback */
function resolveTypeId(preview: ProviderExportFilePreview): string | null {
  if (preview.type_id) return preview.type_id;

  const allTypes = getProviderTypeRegistry().getAll();
  const sorted = [...allTypes].sort((a, b) => b.typeId.length - a.typeId.length);
  for (const t of sorted) {
    if (preview.provider_id.startsWith(t.typeId + '-') || preview.provider_id === t.typeId) {
      return t.typeId;
    }
  }

  return null;
}

type ConflictAction = 'skip' | 'replace' | 'keep';

interface ConflictState {
  providerIndex: number;
  existingInstanceId: string;
  action: ConflictAction;
}

type Step = 'file' | 'preview' | 'password' | 'result';

/** Internal metadata for a pending import operation */
interface ImportMeta {
  instanceId: string;
  newEncPassword: string;
  typeId: string;
  provider: ProviderExportFilePreview;
}

export function ImportProviderConfigDialog({ isOpen, onClose }: ImportProviderConfigDialogProps) {
  const [step, setStep] = useState<Step>('file');
  const [filePath, setFilePath] = useState('');
  const [preview, setPreview] = useState<MultiProviderExportPreview | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictState[]>([]);
  const [results, setResults] = useState<ProviderImportResult[]>([]);

  const reset = () => {
    setStep('file');
    setFilePath('');
    setPreview(null);
    setSelectedIndices(new Set());
    setPassword('');
    setError('');
    setLoading(false);
    setImporting(false);
    setConflicts([]);
    setResults([]);
  };

  const handleClose = () => {
    if (loading || importing) return;
    reset();
    onClose();
  };

  // ─── Step A: Select file ───

  const handleSelectFile = async () => {
    setError('');
    setLoading(true);

    try {
      const adapter = await getPlatformAdapter();
      const selected = await adapter.fs.selectFile({
        multiple: false,
        filters: [{ name: 'OpenDirector Provider', extensions: ['odprovider'] }],
      });

      if (!selected || Array.isArray(selected)) {
        setLoading(false);
        return;
      }

      setFilePath(selected);
      const result = await tauriBridge.providerConfig.verifyMulti(selected);
      setPreview(result);
      setSelectedIndices(new Set(result.providers.map((_, i) => i)));
      setStep('preview');
    } catch (err) {
      setError(getErrorMessage(err, '无法读取文件'));
    } finally {
      setLoading(false);
    }
  };

  const toggleProvider = (index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // ─── Step B: Preview → detect conflicts → Step C ───

  const handleNextFromPreview = () => {
    if (!preview) return;
    setError('');

    const instances = useProviderInstanceStore.getState().instances;
    const newConflicts: ConflictState[] = [];

    for (const idx of selectedIndices) {
      const provider = preview.providers[idx];
      if (!provider) continue;
      const typeId = resolveTypeId(provider);
      if (!typeId) continue;

      const existing = instances.find((inst) => inst.typeId === typeId);
      if (existing) {
        newConflicts.push({
          providerIndex: idx,
          existingInstanceId: existing.instanceId,
          action: 'skip',
        });
      }
    }

    setConflicts(newConflicts);
    setStep('password');
  };

  const updateConflictAction = (providerIndex: number, action: ConflictAction) => {
    setConflicts((prev) =>
      prev.map((c) => (c.providerIndex === providerIndex ? { ...c, action } : c)),
    );
  };

  // ─── Step C: Password → Import → Step D ───

  const handleImport = async () => {
    if (!preview || !password.trim()) {
      setError('请输入密码');
      return;
    }

    const skipIndices = new Set(conflicts.filter((c) => c.action === 'skip').map((c) => c.providerIndex));
    const activeIndices = [...selectedIndices].filter((i) => !skipIndices.has(i));

    if (activeIndices.length === 0) {
      setError('没有需要导入的 Provider');
      return;
    }

    setImporting(true);
    setError('');

    const preCreatedInstanceIds: string[] = [];

    try {
      const store = useProviderInstanceStore.getState();
      const entries: MultiProviderImportEntry[] = [];
      const metas: (ImportMeta | null)[] = []; // parallel to allResults, null for type errors

      for (const idx of activeIndices) {
        const provider = preview.providers[idx];
        if (!provider) continue;
        const typeId = resolveTypeId(provider);
        if (!typeId) {
          metas.push(null);
          continue;
        }

        const conflict = conflicts.find((c) => c.providerIndex === idx);
        const newEncPassword = generateRandomHexPassword();
        const instanceId = conflict?.action === 'replace'
          ? conflict.existingInstanceId
          : (() => {
              const id = store.addInstance({
                typeId,
                displayName: resolveUniqueDisplayName(provider.provider_name, store),
                config: { _encPassword: newEncPassword },
                enabled: true,
                order: Date.now(),
              });
              preCreatedInstanceIds.push(id);
              return id;
            })();

        entries.push({
          provider_index: idx,
          master_password: newEncPassword,
          save: true,
          target_provider_id: instanceId,
        });
        metas.push({ instanceId, newEncPassword, typeId, provider });
      }

      const importResults = await tauriBridge.providerConfig.importMulti(filePath, password, entries);

      const finalResults: ProviderImportResult[] = [];
      const reinitPromises: Promise<void>[] = [];
      let entryIdx = 0;

      for (const meta of metas) {
        if (!meta) {
          // Type error — skip (entry wasn't added)
          continue;
        }
        const importResult = importResults[entryIdx++];

        if (!importResult?.success) {
          // Clean up pre-created instance
          if (preCreatedInstanceIds.includes(meta.instanceId)) {
            useProviderInstanceStore.getState().removeInstance(meta.instanceId);
          }
          finalResults.push({
            success: false,
            provider_id: meta.provider.provider_id,
            type_id: meta.typeId,
            provider_name: meta.provider.provider_name,
            credentials_saved: false,
            error: importResult?.error ?? '导入失败',
          });
          continue;
        }

        // Merge imported config into instance
        const currentStore = useProviderInstanceStore.getState();
        const existingInst = currentStore.get(meta.instanceId);
        if (existingInst) {
          const config = { ...(existingInst.config as Record<string, string>) };
          if (importResult.config) {
            Object.assign(config, importResult.config);
          }
          config._encPassword = meta.newEncPassword;
          currentStore.updateInstance(meta.instanceId, { config });
          reinitPromises.push(
            getProviderRuntimeRegistry().reinitializeInstance(meta.instanceId).catch((err) => {
              console.warn('[Import] Failed to reinitialize runtime:', err);
            }),
          );
        }

        finalResults.push({
          success: true,
          provider_id: meta.instanceId,
          type_id: meta.typeId,
          provider_name: meta.provider.provider_name,
          credentials_saved: true,
        });
      }

      // Parallel runtime reinitialization
      await Promise.allSettled(reinitPromises);

      // Add skipped providers
      for (const c of conflicts) {
        if (c.action === 'skip') {
          const provider = preview.providers[c.providerIndex];
          if (provider) {
            finalResults.push({
              success: true,
              provider_id: provider.provider_id,
              type_id: resolveTypeId(provider) ?? provider.provider_id,
              provider_name: provider.provider_name,
              credentials_saved: false,
              error: '已跳过',
            });
          }
        }
      }

      setResults(finalResults);
      setStep('result');
    } catch (err) {
      // Clean up all pre-created instances on bulk failure
      const store = useProviderInstanceStore.getState();
      for (const id of preCreatedInstanceIds) {
        store.removeInstance(id);
      }
      setError(getErrorMessage(err, '导入失败'));
    } finally {
      setImporting(false);
    }
  };

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  const skippedCount = results.filter((r) => r.error === '已跳过').length;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="导入 Provider 配置" size="md">
      <div className="space-y-4">
        {error && step !== 'result' && (
          <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Step A: File select */}
        {step === 'file' && (
          <div
            onClick={handleSelectFile}
            className="border-2 border-dashed border-zinc-700 rounded-lg p-6 text-center hover:border-zinc-600 transition-colors cursor-pointer"
          >
            {loading ? (
              <Loader2 size={24} className="mx-auto text-zinc-400 animate-spin" />
            ) : (
              <div className="flex flex-col items-center gap-2 text-zinc-400 hover:text-zinc-300">
                <FileDown size={24} />
                <span className="text-sm">选择 .odprovider 文件</span>
              </div>
            )}
          </div>
        )}

        {/* Step B: Preview + checkboxes */}
        {step === 'preview' && preview && (
          <>
            <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
              <p className="text-xs text-zinc-500 mb-1">
                导出时间: {new Date(preview.exported_at).toLocaleString()}
              </p>
              <p className="text-xs text-zinc-500 mt-1">
                共 {preview.providers.length} 个 Provider
              </p>
            </div>

            <div className="space-y-2 max-h-60 overflow-y-auto">
              {preview.providers.map((p, i) => {
                const typeId = resolveTypeId(p);
                const typeDef = typeId ? getProviderTypeRegistry().get(typeId) : null;
                const hasConflict = typeId ? useProviderInstanceStore.getState().instances.some((inst) => inst.typeId === typeId) : false;
                return (
                  <label
                    key={i}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedIndices.has(i)
                        ? 'bg-zinc-800/50 border-zinc-600'
                        : 'bg-zinc-800/30 border-zinc-700 opacity-60'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIndices.has(i)}
                      onChange={() => toggleProvider(i)}
                      className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white truncate">{p.provider_name}</span>
                        {typeDef && (
                          <span className="text-xs text-zinc-500">{typeDef.name}</span>
                        )}
                        {hasConflict && (
                          <span className="text-xs px-1.5 py-0.5 bg-yellow-500/10 text-yellow-400 rounded">
                            已存在
                          </span>
                        )}
                      </div>
                      {typeId && (
                        <p className="text-xs text-zinc-500 truncate">类型: {typeId}</p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setStep('file'); setPreview(null); }} className="flex-1">
                <ArrowLeft size={14} className="mr-1" />
                返回
              </Button>
              <Button
                variant="primary"
                onClick={handleNextFromPreview}
                disabled={selectedIndices.size === 0}
                className="flex-1"
              >
                下一步
                <ArrowRight size={14} className="ml-1" />
              </Button>
            </div>
          </>
        )}

        {/* Step C: Conflict resolution + password */}
        {step === 'password' && preview && (
          <>
            {conflicts.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-yellow-400 font-medium">
                  检测到 {conflicts.length} 个冲突
                </p>
                {conflicts.map((c) => {
                  const provider = preview.providers[c.providerIndex];
                  if (!provider) return null;
                  return (
                    <div key={c.providerIndex} className="p-3 bg-zinc-800/50 rounded-lg border border-yellow-500/30 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white">{provider.provider_name}</span>
                        <span className="text-xs text-zinc-500">
                          {resolveTypeId(provider)}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        {([
                          { value: 'skip' as ConflictAction, label: '跳过' },
                          { value: 'replace' as ConflictAction, label: '替换' },
                          { value: 'keep' as ConflictAction, label: '保留两者' },
                        ]).map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => updateConflictAction(c.providerIndex, opt.value)}
                            className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                              c.action === opt.value
                                ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                                : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <Input
              label="导出密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入导出时设置的密码"
            />

            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setError(''); setStep('preview'); }} className="flex-1">
                <ArrowLeft size={14} className="mr-1" />
                返回
              </Button>
              <Button
                variant="primary"
                onClick={handleImport}
                disabled={importing || !password.trim()}
                className="flex-1"
              >
                {importing ? '导入中...' : '导入'}
              </Button>
            </div>
          </>
        )}

        {/* Step D: Results */}
        {step === 'result' && (
          <>
            <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-700 space-y-2">
              <div className="flex items-center gap-4 text-sm">
                <span className="text-green-400 flex items-center gap-1">
                  <CheckCircle2 size={14} /> 成功 {successCount - skippedCount}
                </span>
                {skippedCount > 0 && (
                  <span className="text-zinc-400">跳过 {skippedCount}</span>
                )}
                {failCount > 0 && (
                  <span className="text-red-400 flex items-center gap-1">
                    <XCircle size={14} /> 失败 {failCount}
                  </span>
                )}
              </div>

              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {results.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    {r.success && r.error !== '已跳过' ? (
                      <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />
                    ) : r.error === '已跳过' ? (
                      <span className="text-zinc-500 w-3 text-center flex-shrink-0">—</span>
                    ) : (
                      <XCircle size={12} className="text-red-400 flex-shrink-0" />
                    )}
                    <span className="text-zinc-300 truncate">{r.provider_name}</span>
                    {!r.success && r.error && r.error !== '已跳过' && (
                      <span className="text-red-400 truncate">{r.error}</span>
                    )}
                    {r.error === '已跳过' && (
                      <span className="text-zinc-500">已跳过</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="primary" onClick={handleClose} className="flex-1">
                完成
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
