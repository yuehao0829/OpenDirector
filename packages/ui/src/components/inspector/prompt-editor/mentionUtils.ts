import type { ReactNode } from 'react';
import type { Asset, Reference } from '@opendirector/core/types/asset';
import { ASSET_TYPE_LABELS, groupReferences } from '../ReferenceSelector.shared';

export interface MentionItem {
  reference: Reference;
  asset: Asset | undefined;
  label: string;
}

export function getReferenceLabels(references: Reference[]): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = groupReferences(references);

  for (const group of groups) {
    group.refs.forEach((reference, index) => {
      labels.set(reference.id, `[${ASSET_TYPE_LABELS[group.type]}${index + 1}]`);
    });
  }

  return labels;
}

export function getReferenceLabel(reference: Reference, references: Reference[]): string {
  return getReferenceLabels(references).get(reference.id) ?? ASSET_TYPE_LABELS[reference.type];
}

export function buildMentionItems(references: Reference[], assets: Asset[]): MentionItem[] {
  const labels = getReferenceLabels(references);
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const typeOrder: Record<string, number> = { image: 0, video: 1, audio: 2 };

  return [...references]
    .sort((a, b) => {
      const orderDiff = (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
      if (orderDiff !== 0) {
        return orderDiff;
      }

      const labelA = labels.get(a.id) ?? '';
      const labelB = labels.get(b.id) ?? '';
      return labelA.localeCompare(labelB, undefined, { numeric: true });
    })
    .map((reference) => ({
      reference,
      asset: assetMap.get(reference.assetId),
      label: labels.get(reference.id) ?? ASSET_TYPE_LABELS[reference.type],
    }));
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const REFERENCE_LABEL_REGEX = new RegExp(
  `\\[(${Object.values(ASSET_TYPE_LABELS).join('|')})(\\d+)\\]`,
  'g',
);

export function parsePromptLabels<T>(
  text: string,
  labelToRef: Map<string, T>,
  renderLabel: (label: string, info: T, key: number) => ReactNode,
  renderText: (text: string, key: number) => ReactNode,
): ReactNode[] {
  const regex = new RegExp(REFERENCE_LABEL_REGEX.source, REFERENCE_LABEL_REGEX.flags);
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderText(text.slice(lastIndex, match.index), parts.length));
    }

    const label = match[0];
    const refInfo = labelToRef.get(label);
    if (refInfo) {
      parts.push(renderLabel(label, refInfo, parts.length));
    } else {
      parts.push(renderText(label, parts.length));
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(renderText(text.slice(lastIndex), parts.length));
  }

  return parts;
}
