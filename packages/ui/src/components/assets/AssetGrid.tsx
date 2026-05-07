/**
 * Asset Grid Component
 *
 * Displays assets in a grid layout with drag support
 */

import { useRef, useEffect, useMemo, useState } from 'react';
import { getPlatformAdapter } from '@opendirector/core/adapters';
import { isAssetOffline } from '@opendirector/core/services/asset-import';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useProviderInstanceStore } from '@opendirector/core/stores/providerInstanceStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import type { Asset } from '@opendirector/core/types/asset';
import { getUploadReadyProviders } from '@opendirector/core/types/provider-system';
import { toWebViewUrl } from '@opendirector/core/utils/platform';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Video, ImageIcon, Music, Trash2, AlertTriangle, Upload, Loader2, Check, AlertCircle } from 'lucide-react';
import { useWaveformCanvas } from '../../hooks/useWaveformCanvas';
import { buildAssetDragData } from '../timeline/drag-types';

export type FileCategory = 'all' | 'video' | 'image' | 'audio';

const MINI_WAVEFORM_OPTIONS = {
  barWidth: 1,
  gap: 0,
  color: '#3b82f6',
  bgColor: '#1e293b',
};

interface AssetGridProps {
  assets: Asset[];
  onAssetClick?: (asset: Asset, e: React.MouseEvent) => void;
  onAssetDelete?: (asset: Asset) => void;
  onAssetUploadRequest?: (asset: Asset) => void;
}

/** Mini waveform canvas for audio cards in the grid */
function MiniWaveformCanvas({ dataPath }: { dataPath: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useWaveformCanvas({
    dataPath,
    canvasRef,
    containerRef,
    options: MINI_WAVEFORM_OPTIONS,
  });

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}

export function AssetGrid({
  assets,
  onAssetClick,
  onAssetDelete,
  onAssetUploadRequest,
}: AssetGridProps) {
  // Use unified selection store to determine selected state
  const secondaryFocus = useSelectionStore((s) => s.secondaryFocus);
  const selectedAssetIds = useMemo(
    () => (secondaryFocus?.type === 'asset' ? secondaryFocus.assetIds : []),
    [secondaryFocus],
  );
  const selectedAssetIdSet = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds]);
  const folderPath = useProjectStore((s) => s.currentProject?.folderPath);

  const hasUploadProvider = useProviderInstanceStore((s) =>
    getUploadReadyProviders(s.instances).length > 0
  );

  const [draggedAsset, setDraggedAsset] = useState<string | null>(null);
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());

  // Check offline status for all assets (desktop only)
  useEffect(() => {
    if (!folderPath) {
      setOfflineIds(new Set());
      return;
    }

    const projectPath = folderPath;
    let cancelled = false;

    async function checkOfflineStatus() {
      try {
        const adapter = await getPlatformAdapter();
        const fs = adapter.fs;
        if (!fs) {
          if (!cancelled) setOfflineIds(new Set());
          return;
        }

        const ids = new Set<string>();
        await Promise.all(
          assets.map(async (asset) => {
            if (await isAssetOffline(asset, projectPath, fs)) {
              ids.add(asset.id);
            }
          })
        );

        if (!cancelled) setOfflineIds(ids);
      } catch {
        // Platform adapter not available — skip offline checks
        if (!cancelled) setOfflineIds(new Set());
      }
    }

    checkOfflineStatus();
    return () => { cancelled = true; };
  }, [assets, folderPath]);

  const handleDragStart = (e: React.DragEvent, asset: Asset) => {
    const dragData = buildAssetDragData(
      asset,
      selectedAssetIds,
      (id) => assets.find((a) => a.id === id) ?? null,
    );
    e.dataTransfer.setData('application/json', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'copy';
    setDraggedAsset(asset.id);
  };

  const handleDragEnd = () => {
    setDraggedAsset(null);
  };

  return (
    <div className="h-full flex flex-col" data-testid="asset-grid">
      {assets.length === 0 ? (
        <div className="flex-1 text-center text-zinc-500 pt-20">
          <p>暂无资源</p>
          <p className="text-xs mt-1">导入资源开始使用</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-1.5">
          <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, 80px)' }}>
            {assets.map((asset) => (
              <div
                key={asset.id}
                draggable
                onDragStart={(e) => handleDragStart(e, asset)}
                onDragEnd={handleDragEnd}
                onClick={(e) => onAssetClick?.(asset, e)}
                className={twMerge(
                  clsx(
                    'aspect-square rounded-lg overflow-hidden border transition-colors cursor-grab relative',
                    selectedAssetIdSet.has(asset.id)
                      ? 'border-blue-500 ring-1 ring-blue-500'
                      : 'border-zinc-700 hover:border-zinc-500',
                    draggedAsset === asset.id && 'opacity-50 cursor-grabbing'
                  )
                )}
                data-testid={`asset-${asset.id}`}
                role="button"
                tabIndex={0}
              >
                {asset.thumbnailUrl ? (
                  <img
                    src={asset.thumbnailUrl}
                    alt={asset.name}
                    className="w-full h-full object-cover"
                  />
                ) : asset.waveformDataPath ? (
                  <div className="relative w-full h-full">
                    <MiniWaveformCanvas dataPath={toWebViewUrl(asset.waveformDataPath)} />
                    <span className="absolute bottom-0 inset-x-0 bg-black/60 px-1 py-0.5 text-zinc-300 text-xs truncate">{asset.name}</span>
                  </div>
                ) : (
                  <div className="w-full h-full bg-zinc-800 flex flex-col items-center justify-center gap-1 p-1">
                    {asset.type === 'video' && <Video className="w-6 h-6 text-zinc-500 shrink-0" />}
                    {asset.type === 'image' && <ImageIcon className="w-6 h-6 text-zinc-500 shrink-0" />}
                    {asset.type === 'audio' && <Music className="w-6 h-6 text-zinc-500 shrink-0" />}
                    <span className="text-zinc-500 text-xs truncate w-full text-center">{asset.name}</span>
                  </div>
                )}
                {offlineIds.has(asset.id) && (
                  <div className="absolute inset-0 bg-zinc-900/70 flex flex-col items-center justify-center gap-1 pointer-events-none">
                    <AlertTriangle className="w-5 h-5 text-amber-400" />
                    <span className="text-amber-400 text-[10px]">媒体离线</span>
                  </div>
                )}
                {selectedAssetIdSet.has(asset.id) && (
                  <button
                    draggable={false}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAssetDelete?.(asset);
                    }}
                    className="absolute top-1 right-1 p-1 rounded-full bg-black/50 text-zinc-400 hover:text-red-400 transition-colors"
                    data-testid={`delete-asset-${asset.id}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
                {/* Remote asset upload status / upload button */}
                {!asset.remoteAssetId && hasUploadProvider && onAssetUploadRequest && (
                  <button
                    draggable={false}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAssetUploadRequest(asset);
                    }}
                    className="absolute bottom-1 right-1 p-1 rounded-full bg-black/50 text-zinc-400 hover:text-blue-400 transition-colors"
                    title="上传到云端"
                  >
                    <Upload className="w-3 h-3" />
                  </button>
                )}
                {asset.remoteAssetStatus === 'Processing' && (
                  <div className="absolute bottom-1 right-1 p-1 rounded-full bg-black/50">
                    <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                  </div>
                )}
                {asset.remoteAssetStatus === 'Active' && (
                  <div className="absolute bottom-1 right-1 p-1 rounded-full bg-black/50">
                    <Check className="w-3 h-3 text-green-400" />
                  </div>
                )}
                {asset.remoteAssetStatus === 'Failed' && (
                  <div className="absolute bottom-1 right-1 p-1 rounded-full bg-black/50">
                    <AlertCircle className="w-3 h-3 text-red-400" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
