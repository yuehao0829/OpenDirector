import { useCallback, useEffect, useMemo, useState } from 'react';
import { getGenerationService, getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { useCurrentProjectGenerations } from '@opendirector/core/stores/generationStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useTimelineStore } from '@opendirector/core/stores/timelineStore';
import { isActiveGenerationStatus } from '@opendirector/core/types/generation';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import { formatTime } from '@opendirector/core/utils/time';
import { Check, Loader2, Minus, X, Clock, RefreshCw } from 'lucide-react';
import { Panel } from '../layout/Panel';

function useTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

function resolveProviderName(instanceId: string, fallback?: string): string {
  if (fallback) return fallback;
  const inst = useProviderInstanceStore.getState().get(instanceId);
  if (!inst) return instanceId;
  const typeDef = getProviderTypeRegistry().get(inst.typeId);
  return typeDef?.name ?? inst.displayName;
}

export function TaskOverview() {
  const generations = useCurrentProjectGenerations();
  const instances = useProviderInstanceStore((s) => s.instances);
  const fragments = useTimelineStore((s) => s.fragments);

  const [refreshing, setRefreshing] = useState(false);

  const activeGenerations = useMemo(
    () =>
      generations.filter(
        (g) => isActiveGenerationStatus(g.status)
      ),
    [generations]
  );

  const fragmentMap = useMemo(() => {
    const m = new Map<string, (typeof fragments)[number]>();
    for (const f of fragments) m.set(f.id, f);
    return m;
  }, [fragments]);

  useTick(activeGenerations.length > 0);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await getGenerationService().refreshActiveGenerations();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  // ── Statistics (single pass) ──
  const stats = useMemo(() => {
    let completed = 0;
    let active = 0;
    let cancelled = 0;
    let failed = 0;
    let expired = 0;
    const byModel = new Map<string, { completed: number; active: number; cancelled: number; failed: number; expired: number; total: number; displayName: string }>();

    for (const g of generations) {
      const modelName = (g.providerParams.modelName as string) || (g.providerParams.model as string) || g.providerDisplayName;
      let entry = byModel.get(modelName);
      if (!entry) {
        entry = { completed: 0, active: 0, cancelled: 0, failed: 0, expired: 0, total: 0, displayName: modelName };
        byModel.set(modelName, entry);
      }
      entry.total++;

      if (g.status === 'completed') {
        completed++;
        entry.completed++;
      } else if (isActiveGenerationStatus(g.status)) {
        active++;
        entry.active++;
      } else if (g.status === 'cancelled') {
        cancelled++;
        entry.cancelled++;
      } else if (g.status === 'failed') {
        failed++;
        entry.failed++;
      } else if (g.status === 'expired') {
        expired++;
        entry.expired++;
      }
    }

    const total = generations.length;
    return { total, completed, active, cancelled, failed, expired, byModel };
  }, [generations]);

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3" data-testid="task-overview">
      {/* Active tasks */}
      <Panel
        title="进行中的任务"
        defaultCollapsed={false}
        headerRight={activeGenerations.length > 0 ? (
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1 rounded hover:bg-zinc-700/60 text-zinc-400 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="刷新服务器状态"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        ) : undefined}
      >
        {activeGenerations.length === 0 ? (
          <p className="text-sm text-zinc-500">暂无进行中的任务</p>
        ) : (
          <div className="space-y-3">
            {activeGenerations.map((g) => {
              const fragment = fragmentMap.get(g.fragmentId ?? '');
              const name = fragment?.prompt
                ? (fragment.prompt.length > 30
                    ? fragment.prompt.slice(0, 30) + '…'
                    : fragment.prompt)
                : g.fragmentId?.slice(0, 8) ?? g.id.slice(0, 8);
              const providerName = resolveProviderName(g.providerInstanceId, g.providerDisplayName);
              const elapsed = Date.now() - new Date(g.createdAt).getTime();

              return (
                <div key={g.id} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        g.status === 'processing'
                          ? 'bg-blue-400 animate-pulse'
                          : g.status === 'recovering'
                            ? 'bg-amber-400 animate-pulse'
                            : 'bg-yellow-400'
                      }`}
                    />
                    <span className="text-sm text-zinc-300 truncate flex-1">
                      {name}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pl-4 text-xs text-zinc-500">
                    <span>{providerName}</span>
                    <span>{formatTime(elapsed, false)}</span>
                  </div>
                  {(g.progress ?? 0) > 0 && (
                    <div className="pl-4">
                      <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: `${g.progress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* Statistics */}
      <Panel title="生成统计" defaultCollapsed={false}>
        <div className="grid grid-cols-5 gap-2">
          <StatCard label="总计" value={stats.total} />
          <StatCard label="已完成" value={stats.completed} color="text-green-400" />
          <StatCard label="进行中" value={stats.active} color="text-blue-400" />
          <StatCard label="已取消" value={stats.cancelled} color="text-zinc-400" />
          <StatCard label="失败" value={stats.failed} color="text-red-400" />
        </div>

        {stats.byModel.size > 0 && (
          <div className="mt-3 space-y-1.5">
            {Array.from(stats.byModel.entries()).map(([modelName, counts]) => (
                <div
                  key={modelName}
                  className="flex items-center justify-between text-xs py-1 px-2 bg-zinc-800/50 rounded"
                >
                  <span className="text-zinc-300 truncate">
                    {counts.displayName}
                  </span>
                  <span className="text-zinc-500 shrink-0 ml-2 flex items-center gap-1.5">
                    {STATUS_ICONS.map(({ key, color, title, Icon, spin }) => {
                      const val = counts[key];
                      if (!val) return null;
                      return (
                        <span key={key} className={`flex items-center gap-0.5 ${color}`} title={title}>
                          <Icon className={`w-3 h-3${spin ? ' animate-spin' : ''}`} />
                          {val}
                        </span>
                      );
                    })}
                    <span className="text-zinc-600">/ {counts.total}</span>
                  </span>
                </div>
              ),
            )}
          </div>
        )}
      </Panel>

      {/* Configured providers */}
      <Panel title="已配置的提供商" defaultCollapsed={false}>
        {instances.length === 0 ? (
          <p className="text-sm text-zinc-500">暂无配置的提供商</p>
        ) : (
          <div className="space-y-1.5">
            {instances.map((inst) => {
              const typeDef = getProviderTypeRegistry().get(inst.typeId);
              const isVolcengine = inst.typeId === BUILTIN_TYPE_IDS.VOLCENGINE;
              const config = inst.config as Record<string, unknown>;
              const modelNames = typeDef?.modelFamilies.flatMap((f) => f.models.map((m) => m.name)) ?? [];
              return (
                <div
                  key={inst.instanceId}
                  className="flex items-center gap-2 py-1 px-2 bg-zinc-800/50 rounded"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      inst.enabled ? 'bg-green-500' : 'bg-zinc-600'
                    }`}
                  />
                  <span className="text-sm text-zinc-300 truncate flex-1">
                    {inst.displayName}
                  </span>
                  {modelNames.map((n) => (
                    <SubStatus key={n} label={n} ok={inst.enabled} />
                  ))}
                  {isVolcengine && <SubStatus label="TOS" ok={!!(config.tos_endpoint && config.tos_bucket)} />}
                  {isVolcengine && <SubStatus label="Asset" ok={!!(config.asset_group_id)} />}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

function StatCard({
  label,
  value,
  color = 'text-white',
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="bg-zinc-800/60 rounded-lg px-3 py-2.5 text-center">
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}

function SubStatus({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1 text-xs">
      <span
        className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-500' : 'bg-zinc-600'}`}
      />
      <span className={ok ? 'text-zinc-400' : 'text-zinc-600'}>{label}</span>
    </span>
  );
}

const STATUS_ICONS = [
  { key: 'completed' as const, color: 'text-green-400', title: '已完成', Icon: Check, spin: false },
  { key: 'active' as const, color: 'text-blue-400', title: '进行中', Icon: Loader2, spin: true },
  { key: 'cancelled' as const, color: 'text-zinc-400', title: '已取消', Icon: Minus, spin: false },
  { key: 'failed' as const, color: 'text-red-400', title: '失败', Icon: X, spin: false },
  { key: 'expired' as const, color: 'text-amber-400', title: '已过期', Icon: Clock, spin: false },
];
