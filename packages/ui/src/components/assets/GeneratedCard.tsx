import { useState, useCallback, useMemo } from 'react';
import { getProviderTypeRegistry } from '@opendirector/core/services/service-locator';
import { useAssetStore } from '@opendirector/core/stores/assetStore';
import { useGenerationStore } from '@opendirector/core/stores/generationStore';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import type { Generation } from '@opendirector/core/types/generation';
import { isActiveGenerationStatus } from '@opendirector/core/types/generation';
import { computeContinuousProgress } from '@opendirector/core/utils/duration';
import { formatDuration } from '@opendirector/core/utils/time';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { twMerge } from 'tailwind-merge';
import { Trash2, CheckCircle, Clock, AlertCircle, Loader2 } from 'lucide-react';
import { buildAssetDragData } from '../timeline/drag-types';
import {
  GENERATED_CARD_THUMBNAIL_WIDTH,
  GENERATED_CARD_THUMBNAIL_HEIGHT,
} from './constants';

/** Format an error message that may be a JSON string from the Rust backend. */
function formatErrorMessage(raw: string): { summary: string; full: string } {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const code = entries.find(([k]) => k.toLowerCase() === 'code')?.[1];
      const message = entries.find(([k]) => k.toLowerCase() === 'message')?.[1];
      const summary = [code, message].filter((v) => typeof v === 'string' && v).join(': ');
      const full = entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n\n');
      return { summary: summary || raw, full };
    }
  } catch {
    // fallthrough
  }
  return { summary: raw, full: raw };
}

/**
 * Resolve model display info from providerParams.
 * Priority: 1) persisted modelName  2) type registry lookup by modelId  3) fallback
 */
function resolveModelDisplay(
  providerParams: Record<string, unknown>,
): { line1: string; line2: string } {
  const modelId = providerParams.model as string | undefined;
  const persistedName = providerParams.modelName as string | undefined;

  if (persistedName) {
    return splitModelName(persistedName);
  }

  if (modelId) {
    const variant = getProviderTypeRegistry().findModelVariant(modelId);
    if (variant) {
      return splitModelName(variant.name, variant.shortName);
    }
    return splitModelName(modelId);
  }

  return { line1: '--', line2: '' };
}

/** Split a model name into two lines for compact display. */
function splitModelName(name: string, shortName?: string): { line1: string; line2: string } {
  if (shortName) {
    const suffix = name.slice(shortName.length).trim();
    return { line1: shortName, line2: suffix };
  }
  // Auto-split: first word on line1, rest on line2
  const parts = name.split(/\s+/);
  if (parts.length > 1) {
    return { line1: parts[0], line2: parts.slice(1).join(' ') };
  }
  return { line1: name, line2: '' };
}

function StatusIcon({ status, size }: { status: Generation['status']; size: number }) {
  switch (status) {
    case 'completed':
      return <CheckCircle size={size} className="text-green-500" />;
    case 'processing':
    case 'recovering':
      return <Loader2 size={size} className="text-blue-500 animate-spin" />;
    case 'failed':
      return <AlertCircle size={size} className="text-red-500" />;
    default:
      return <Clock size={size} className="text-zinc-500" />;
  }
}

interface GeneratedCardProps {
  generation: Generation;
}

export function GeneratedCard({ generation }: GeneratedCardProps) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const selectAsset = useSelectionStore((s) => s.selectAsset);
  const clearSecondaryFocus = useSelectionStore((s) => s.clearSecondaryFocus);
  const secondaryFocus = useSelectionStore((s) => s.secondaryFocus);
  const getAssetById = useAssetStore((s) => s.getAssetById);
  const deleteGeneration = useGenerationStore((s) => s.deleteGeneration);

  const asset = generation.resultAssetId ? getAssetById(generation.resultAssetId) : undefined;
  const isSelected = !!generation.resultAssetId && secondaryFocus?.type === 'asset' && secondaryFocus.assetIds.includes(generation.resultAssetId);

  const canInteract = generation.status === 'completed' && !!generation.resultAssetId;
  const isFailed = generation.status === 'failed';
  const isNotCompleted = generation.status !== 'completed';
  const isActive = isActiveGenerationStatus(generation.status);

  // Continuous segment progress for active generations
  const segmentInfo = useMemo(() => {
    if (!generation.continuousMode) return null;
    const plan = generation.continuousPlan ?? [];
    const idx = generation.currentSegmentIndex ?? 0;
    if (plan.length === 0) return null;
    const progress = isActive ? (generation.progress ?? 0) : 100;
    return computeContinuousProgress(plan, idx, progress);
  }, [generation.continuousMode, generation.continuousPlan, generation.currentSegmentIndex, generation.progress, isActive]);

  const { line1: modelLine1, line2: modelLine2 } = resolveModelDisplay(generation.providerParams);
  const errorDisplay = isFailed && generation.errorMessage ? formatErrorMessage(generation.errorMessage) : null;

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!canInteract || !asset) return;

    if (isSelected && !(e.metaKey || e.ctrlKey)) {
      clearSecondaryFocus();
    } else {
      selectAsset(asset.id, e.metaKey || e.ctrlKey);
    }
  }, [canInteract, asset, isSelected, selectAsset, clearSecondaryFocus]);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (!canInteract || !asset) {
        e.preventDefault();
        return;
      }

      const dragData = buildAssetDragData(
        asset,
        secondaryFocus?.type === 'asset' ? secondaryFocus.assetIds : [],
        getAssetById,
      );
      e.dataTransfer.setData('application/json', JSON.stringify(dragData));
      e.dataTransfer.effectAllowed = 'copy';
      setIsDragging(true);
    },
    [canInteract, asset, secondaryFocus, getAssetById]
  );

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      deleteGeneration(generation.id);
      if (isSelected) {
        clearSecondaryFocus();
      }
    },
    [deleteGeneration, generation.id, isSelected, clearSecondaryFocus]
  );

  return (
    <div
      className={twMerge(
        clsx(
          'flex items-center gap-3 px-3 rounded-lg border transition-colors select-none',
          isSelected
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-zinc-700/50 hover:border-zinc-600 bg-zinc-800/50',
          generation.status === 'failed' && 'border-red-500/30',
          canInteract ? 'cursor-pointer' : 'cursor-default',
          isDragging && 'opacity-50'
        )
      )}
      style={{ minHeight: GENERATED_CARD_THUMBNAIL_HEIGHT + 10 }}
      onClick={handleClick}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      draggable={canInteract}
      data-testid={`generation-card-${generation.id}`}
    >
      <div
        className="flex-shrink-0 bg-zinc-700 rounded overflow-hidden"
        style={{ width: GENERATED_CARD_THUMBNAIL_WIDTH, height: GENERATED_CARD_THUMBNAIL_HEIGHT }}
      >
        {asset?.thumbnailUrl ? (
          <img src={asset.thumbnailUrl} alt="" className="w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <StatusIcon status={generation.status} size={20} />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className={clsx('text-sm text-white leading-tight', isNotCompleted ? 'line-clamp-1' : 'line-clamp-2')}>
          {generation.promptText}
        </p>
        {isActive && generation.progress != null && generation.progress > 0 && (
          <div className="mt-1.5 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${segmentInfo?.percent ?? generation.progress}%` }}
            />
          </div>
        )}
        {errorDisplay && (
          <div className="relative group/error">
            <p className="text-xs text-red-400 mt-1 line-clamp-1">
              {errorDisplay.summary}
            </p>
            <div className="absolute left-0 top-full z-50 hidden group-hover/error:block bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-red-300 whitespace-pre-wrap break-all min-w-48 max-w-80 shadow-lg">
              {errorDisplay.full}
            </div>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 text-xs text-zinc-400 w-20 text-center space-y-0.5">
        {segmentInfo && isActive && (
          <p className="text-blue-400">
            {t('assetPanel.status.segment', {
              current: segmentInfo.current,
              total: segmentInfo.total,
            })}
          </p>
        )}
        <p className="truncate">{formatDuration(asset?.duration)}</p>
        <p className="text-zinc-500 truncate">{modelLine1}</p>
        {modelLine2 && <p className="text-zinc-500 truncate">{modelLine2}</p>}
      </div>

      <div className="flex-shrink-0 flex items-center gap-1">
        <StatusIcon status={generation.status} size={14} />
        {isSelected && (
          <button
            className="p-1 text-zinc-400 hover:text-red-400 transition-colors"
            onClick={handleDelete}
            title={t('common.delete')}
            data-testid="delete-generation"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
