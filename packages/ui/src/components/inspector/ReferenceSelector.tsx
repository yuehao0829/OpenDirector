import { useMemo } from 'react';
import { useSelectionStore } from '@opendirector/core/stores/selectionStore';
import type { Asset, ImageRole, Reference } from '@opendirector/core/types/asset';
import { getEffectiveImageRole } from '@opendirector/core/types/asset';
import type { ConstraintIndicator } from '@opendirector/core/types/provider-system';
import { X, Video, ImageIcon, Music, Crop, Scissors } from 'lucide-react';

// ── Shared helpers (exported for reuse) ──

export const ASSET_TYPE_LABELS = { image: '图片', video: '视频', audio: '音频' } as const;
const ASSET_TYPE_ICONS = { video: Video, image: ImageIcon, audio: Music } as const;

export const IMAGE_ROLE_LABELS: Record<ImageRole, string> = {
  reference_image: '参考图',
  first_frame: '首帧',
  last_frame: '尾帧',
} as const;

const IMAGE_ROLES: ImageRole[] = ['reference_image', 'first_frame', 'last_frame'];

export interface GroupedReference {
  type: 'image' | 'video' | 'audio';
  refs: Reference[];
}

export function groupReferences(references: Reference[]): GroupedReference[] {
  const groups: GroupedReference[] = [
    { type: 'image', refs: [] },
    { type: 'video', refs: [] },
    { type: 'audio', refs: [] },
  ];
  for (const ref of references) {
    const group = groups.find((g) => g.type === ref.type);
    if (group) group.refs.push(ref);
  }
  return groups.filter((g) => g.refs.length > 0);
}

export function AssetThumbnail({ type, thumbnailUrl }: { type: string; thumbnailUrl?: string }) {
  if (thumbnailUrl) {
    return <img src={thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover" />;
  }
  return (
    <div className="w-8 h-8 rounded bg-zinc-700 flex items-center justify-center">
      {type === 'video' && <Video size={12} className="text-zinc-400" />}
      {type === 'image' && <ImageIcon size={12} className="text-zinc-400" />}
      {type === 'audio' && <Music size={12} className="text-zinc-400" />}
    </div>
  );
}

interface ReferenceSelectorProps {
  references: Reference[];
  assets: Asset[];
  onChange: (references: Reference[]) => void;
  fragmentId?: string;
  indicators?: Map<string, ConstraintIndicator[]>;
}

export function ReferenceSelector({ references, assets, onChange, fragmentId, indicators }: ReferenceSelectorProps) {
  const getAsset = (assetId: string) => assets.find((a) => a.id === assetId);

  const secondaryFocus = useSelectionStore((s) => s.secondaryFocus);
  const selectReference = useSelectionStore((s) => s.selectReference);
  const clearSecondaryFocus = useSelectionStore((s) => s.clearSecondaryFocus);

  const grouped = useMemo(() => groupReferences(references), [references]);

  const handleRefClick = (ref: Reference) => {
    if (!fragmentId) return;
    // Toggle: if already selected, deselect (clear secondary focus only)
    if (secondaryFocus?.type === 'reference' && secondaryFocus.referenceData?.referenceId === ref.id && secondaryFocus.referenceData?.fragmentId === fragmentId) {
      clearSecondaryFocus();
    } else {
      selectReference(fragmentId, ref.id);
    }
  };

  const isSelected = (refId: string) =>
    secondaryFocus?.type === 'reference' && secondaryFocus.referenceData?.referenceId === refId && secondaryFocus.referenceData?.fragmentId === fragmentId;

  // Pre-compute role state for image group (used by disable logic)
  const imageRoleState = useMemo(() => {
    const imageRefs = references.filter((r) => r.type === 'image');
    const firstFrameId = imageRefs.find((r) => getEffectiveImageRole(r) === 'first_frame')?.id;
    const lastFrameId = imageRefs.find((r) => getEffectiveImageRole(r) === 'last_frame')?.id;
    return { firstFrameId, lastFrameId };
  }, [references]);

  const handleRemove = (referenceId: string) => {
    onChange(references.filter((r) => r.id !== referenceId));
  };

  const handleRoleChange = (referenceId: string, newRole: ImageRole) => {
    onChange(references.map((r) => r.id === referenceId ? { ...r, role: newRole } : r));
  };

  if (references.length === 0) {
    return <div className="text-sm text-zinc-500">暂无参考资源</div>;
  }

  return (
    <div className="space-y-3" data-testid="reference-selector">
      {grouped.map((group) => {
        const Icon = ASSET_TYPE_ICONS[group.type];
        return (
          <div key={group.type}>
            <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-200 mb-1.5">
              <Icon size={14} className="text-blue-400" />
              {ASSET_TYPE_LABELS[group.type]}
            </div>
            <div className="space-y-1">
              {group.refs.map((ref) => {
                const asset = getAsset(ref.assetId);
                const isImage = group.type === 'image';
                const currentRole = isImage ? getEffectiveImageRole(ref) : 'reference_image';
                const { firstFrameId, lastFrameId } = imageRoleState;
                const indicatorsForRef = indicators?.get(ref.id) ?? [];

                // "Exclude self" check: another ref already holds this role
                const anotherHasFirstFrame = !!firstFrameId && firstFrameId !== ref.id;
                const anotherHasLastFrame = !!lastFrameId && lastFrameId !== ref.id;
                const noFirstFrameAnywhere = !firstFrameId;

                return (
                  <div
                    key={ref.id}
                    className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition-colors ${
                      isSelected(ref.id)
                        ? 'bg-blue-500/20 ring-1 ring-blue-500/50'
                        : 'bg-zinc-800/50 hover:bg-zinc-700/50'
                    }`}
                    onClick={() => handleRefClick(ref)}
                  >
                    <AssetThumbnail type={group.type} thumbnailUrl={asset?.thumbnailUrl} />
                    {isImage && (
                      <select
                        value={currentRole}
                        onChange={(e) => { e.stopPropagation(); handleRoleChange(ref.id, e.target.value as ImageRole); }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs bg-zinc-700 text-zinc-300 border border-zinc-600 rounded px-1 py-0.5 focus:outline-none focus:border-blue-500 cursor-pointer"
                      >
                        {IMAGE_ROLES.map((role) => {
                          const disabled =
                            (role === 'first_frame' && anotherHasFirstFrame) ||
                            (role === 'last_frame' && (anotherHasLastFrame || (noFirstFrameAnywhere && currentRole !== 'last_frame')));
                          const title =
                            role === 'first_frame' && anotherHasFirstFrame ? '只能指定一张首帧图片' :
                            role === 'last_frame' && anotherHasLastFrame ? '只能指定一张尾帧图片' :
                            role === 'last_frame' && noFirstFrameAnywhere && currentRole !== 'last_frame' ? '需要先指定首帧图片' : '';
                          return (
                            <option key={role} value={role} disabled={disabled} title={title}>
                              {IMAGE_ROLE_LABELS[role]}
                            </option>
                          );
                        })}
                      </select>
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-zinc-300 truncate block">{asset?.name ?? ref.assetId}</span>
                      {indicatorsForRef.length > 0 && (
                        <span className="text-xs truncate">
                          {indicatorsForRef.map((ind, idx) => (
                            <span key={idx} className={ind.severity === 'error' ? 'text-red-400' : 'text-amber-400'}>
                              {idx > 0 && ' · '}{ind.severity === 'error' ? '✗' : '⚠'} {ind.label}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    {/* Crop indicator */}
                    {ref.cropRect && (ref.cropRect.x !== 0 || ref.cropRect.y !== 0 || ref.cropRect.width !== 1 || ref.cropRect.height !== 1) && (
                      <span className="text-blue-400 shrink-0" title="已裁剪"><Crop size={12} /></span>
                    )}
                    {/* Trim indicator */}
                    {ref.trimRange && (ref.trimRange.startMs > 0 || ref.trimRange.endMs < (asset?.duration ?? 0)) && (
                      <span className="text-blue-400 shrink-0" title={`剪辑: ${(ref.trimRange.startMs / 1000).toFixed(1)}s - ${(ref.trimRange.endMs / 1000).toFixed(1)}s`}><Scissors size={12} /></span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemove(ref.id); }}
                      className="text-zinc-500 hover:text-red-400 transition-colors"
                      title="移除参考"
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
