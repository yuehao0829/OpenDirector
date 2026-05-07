import type { ImageRole, Reference } from '@opendirector/core/types/asset';

export const ASSET_TYPE_LABELS = { image: '图片', video: '视频', audio: '音频' } as const;

export const IMAGE_ROLE_LABELS: Record<ImageRole, string> = {
  reference_image: '参考图',
  first_frame: '首帧',
  last_frame: '尾帧',
} as const;

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

  for (const reference of references) {
    const group = groups.find((item) => item.type === reference.type);
    if (group) {
      group.refs.push(reference);
    }
  }

  return groups.filter((group) => group.refs.length > 0);
}
