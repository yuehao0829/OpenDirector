import type { Asset } from '@opendirector/core/types/asset';
import type { AssetType } from '@opendirector/core/types/persistence';

export interface AssetDragItem {
  id: string;
  type: AssetType;
  source: string;
  name: string;
  thumbnailUrl?: string;
  duration?: number;
}

export interface AssetDragData extends AssetDragItem {
  additionalAssets?: AssetDragItem[];
}

/** Default fragment duration in ms when no source duration is available */
export const DEFAULT_FRAGMENT_DURATION_MS = 5000;
export const MIN_DROPPED_FRAGMENT_DURATION_MS = 500;

/** Video tracks accept video and image assets; audio tracks accept audio only */
export function isDragCompatibleWithTrack(dragType: AssetType, trackType: 'video' | 'audio'): boolean {
  if (trackType === 'video') return dragType === 'video' || dragType === 'image';
  if (trackType === 'audio') return dragType === 'audio';
  return false;
}

export function parseAssetDragData(dataTransfer: DataTransfer): AssetDragData | null {
  const jsonData = dataTransfer.getData('application/json');
  if (!jsonData) return null;

  try {
    const parsed = JSON.parse(jsonData);
    if (parsed.id && parsed.type && parsed.name) {
      return parsed as AssetDragData;
    }
  } catch {
    // Ignore malformed drag data
  }
  return null;
}

/** Build AssetDragData for a drag operation, including multi-selected assets */
export function buildAssetDragData(
  primaryAsset: Asset,
  selectedAssetIds: string[],
  resolveAsset: (id: string) => Asset | null | undefined,
): AssetDragData {
  const additionalAssets: AssetDragItem[] = [];
  if (selectedAssetIds.length > 1 && selectedAssetIds.includes(primaryAsset.id)) {
    for (const aid of selectedAssetIds) {
      if (aid === primaryAsset.id) continue;
      const a = resolveAsset(aid);
      if (a) {
        additionalAssets.push({
          id: a.id,
          type: a.type,
          source: a.source,
          name: a.name,
          thumbnailUrl: a.thumbnailUrl,
          duration: a.duration,
        });
      }
    }
  }
  return {
    id: primaryAsset.id,
    type: primaryAsset.type,
    source: primaryAsset.source,
    name: primaryAsset.name,
    thumbnailUrl: primaryAsset.thumbnailUrl,
    duration: primaryAsset.duration,
    ...(additionalAssets.length > 0 ? { additionalAssets } : {}),
  };
}

/** Build reference list from drag data (single or multi-asset) */
export function buildReferencesFromDragData(
  dragData: AssetDragData,
  excludeAssetIds?: string[],
) {
  const allAssets = [dragData, ...(dragData.additionalAssets ?? [])];
  return allAssets
    .filter((a) => !excludeAssetIds?.includes(a.id))
    .map((a, i) => ({
      id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${i}`,
      assetId: a.id,
      type: a.type as 'video' | 'image' | 'audio',
      ...(a.type === 'image' ? { role: 'reference_image' as const } : {}),
    }));
}

/** Resolve sourceAssetId and references for a drop operation.
 *  Single-asset drop: primary asset becomes sourceAssetId, excluded from references.
 *  Multi-asset drop: no sourceAssetId, all assets become references. */
export function resolveDropSource(dragData: AssetDragData) {
  const isMultiDrop = !!dragData.additionalAssets?.length;
  return {
    sourceAssetId: isMultiDrop ? undefined : dragData.id,
    references: buildReferencesFromDragData(dragData, isMultiDrop ? undefined : [dragData.id]),
  };
}

function resolvePositiveDuration(...durations: Array<number | undefined>): number | undefined {
  return durations.find((duration) => (duration ?? 0) > 0);
}

export function resolveDroppedFragmentDuration(
  dragData: AssetDragData,
  availableDuration: number,
  currentAssetDuration?: number,
): number | null {
  if (!(availableDuration > 0)) {
    return null;
  }

  const isMultiDrop = !!dragData.additionalAssets?.length;
  const sourceBackedDuration = (!isMultiDrop && dragData.type !== 'image')
    ? resolvePositiveDuration(currentAssetDuration, dragData.duration)
    : undefined;

  const desiredDuration = (isMultiDrop || dragData.type === 'image')
    ? DEFAULT_FRAGMENT_DURATION_MS
    : (sourceBackedDuration ?? DEFAULT_FRAGMENT_DURATION_MS);
  const duration = Math.min(desiredDuration, availableDuration);

  if (!(duration > 0)) {
    return null;
  }

  const minimumAcceptedDuration = sourceBackedDuration && sourceBackedDuration < MIN_DROPPED_FRAGMENT_DURATION_MS
    ? sourceBackedDuration
    : MIN_DROPPED_FRAGMENT_DURATION_MS;

  return duration >= minimumAcceptedDuration ? duration : null;
}
