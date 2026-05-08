import type { ImageRole, Reference } from '@opendirector/core/types/asset';

export function getAssetTypeLabel(
  type: 'image' | 'video' | 'audio',
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(`common.${type}`);
}

export function getImageRoleLabel(
  role: ImageRole,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (role) {
    case 'reference_image':
      return t('inspector.referenceRoles.referenceImage');
    case 'first_frame':
      return t('inspector.referenceRoles.firstFrame');
    case 'last_frame':
      return t('inspector.referenceRoles.lastFrame');
  }
}

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
