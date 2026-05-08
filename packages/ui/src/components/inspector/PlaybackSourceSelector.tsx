import { useMemo, type ReactNode } from 'react';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useCurrentProjectGenerations } from '@opendirector/core/stores/generationStore';
import { AssetThumbnail } from './ReferenceSelector';
import { MonitorPlay } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PlaybackSourceSelectorProps {
  fragmentId: string;
  sourceAssetId: string | undefined;
  onChange: (assetId: string) => void;
}

interface PlaybackSource {
  assetId: string;
  label: string;
  type: string;
  thumbnailUrl?: string;
  isOriginal: boolean;
}

function usePlaybackSources(fragmentId: string, sourceAssetId: string | undefined) {
  const allGenerations = useCurrentProjectGenerations();
  const generations = useMemo(() =>
    allGenerations.filter((g) => g.fragmentId === fragmentId && g.status === 'completed' && !!g.resultAssetId)
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)),
    [allGenerations, fragmentId],
  );
  const assets = useAssetStore((s) => s.assets);
  const sourceAsset = sourceAssetId ? assets.find((a) => a.id === sourceAssetId) ?? null : null;

  return useMemo(() => {
    const getAsset = (id: string) => assets.find((a) => a.id === id);
    const sources: PlaybackSource[] = [];
    const genAssetIds = new Set<string>();

    for (const gen of generations) {
      if (!gen.resultAssetId) continue;
      genAssetIds.add(gen.resultAssetId);
      const asset = getAsset(gen.resultAssetId);
      sources.push({
        assetId: gen.resultAssetId,
        label: asset?.name ?? `Generation ${gen.id.slice(0, 8)}`,
        type: asset?.type ?? 'video',
        thumbnailUrl: asset?.thumbnailUrl,
        isOriginal: false,
      });
    }

    if (sourceAsset && !genAssetIds.has(sourceAssetId!)) {
      sources.push({
        assetId: sourceAsset.id,
        label: sourceAsset.name,
        type: sourceAsset.type,
        thumbnailUrl: sourceAsset.thumbnailUrl,
        isOriginal: true,
      });
    }

    return sources;
  }, [generations, assets, sourceAsset, sourceAssetId]);
}

function Header({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-200 mb-1.5">
      <MonitorPlay size={14} className="text-blue-400" />
      {children}
    </div>
  );
}

export function PlaybackSourceSelector({ fragmentId, sourceAssetId, onChange }: PlaybackSourceSelectorProps) {
  const { t } = useTranslation();
  const sources = usePlaybackSources(fragmentId, sourceAssetId);

  if (sources.length === 0) return null;

  const current = sources.find((s) => s.assetId === sourceAssetId);
  const showDropdown = sources.length > 1;

  return (
    <div data-testid="playback-source-selector">
      <Header>{t('inspector.labels.playbackSource')}</Header>

      {showDropdown ? (
        <select
          value={sourceAssetId ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-blue-500 appearance-none cursor-pointer"
        >
          {sources.map((src) => (
            <option key={src.assetId} value={src.assetId}>
              {src.isOriginal
                ? t('inspector.playbackSource.originalVideoPrefix', { label: src.label })
                : src.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex items-center gap-2 p-1.5 bg-zinc-800/50 rounded">
          <AssetThumbnail type={current?.type ?? 'video'} thumbnailUrl={current?.thumbnailUrl} />
          <span className="text-sm text-zinc-300 flex-1 truncate">{current?.label}</span>
          {current?.isOriginal && (
            <span className="text-xs text-zinc-500 shrink-0">
              {t('inspector.playbackSource.originalVideoTag')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
