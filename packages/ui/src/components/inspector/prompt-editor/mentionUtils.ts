import type { ReactNode } from 'react';
import type { Asset, AssetType, Reference } from '@opendirector/core/types/asset';
import { ASSET_TYPES } from '@opendirector/core/types/asset';
import type {
  InputRequirements,
  ReferenceMarkerConfig,
} from '@opendirector/core/types/provider-system';
import { resolveReferenceMarker } from '@opendirector/core/types/provider-system';
import { groupReferences } from '../ReferenceSelector.shared';

export interface MentionItem {
  reference: Reference;
  asset: Asset | undefined;
  label: string;
}

/**
 * Resolve a model's `InputRequirements.referenceMarker` for UI use. Localized
 * type-name fallbacks come from `t` (react-i18next, reactive to language
 * changes); the template is resolved inside `resolveReferenceMarker` via core's
 * `translate`. The caller memoizes on `[inputRequirements, t]` so a language or
 * model switch yields a fresh marker — no module-level cache to invalidate.
 */
export function resolveMarkerForUi(
  req: InputRequirements | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): ReferenceMarkerConfig {
  return resolveReferenceMarker(req, {
    image: t('common.image'),
    video: t('common.video'),
    audio: t('common.audio'),
  });
}

/** Render a single reference marker, e.g. `[图片1]` or `@音频2`. Uses function
 *  replacers so a typeName containing `$` (a `String.replace` special pattern
 *  like `$&`) is inserted literally rather than interpreted. */
export function renderMarker(marker: ReferenceMarkerConfig, type: AssetType, index: number): string {
  return marker.template
    .replace('{{type}}', () => marker.typeNames[type])
    .replace('{{index}}', () => String(index));
}

/** Labels for references that are mentionable (`marker.mentionableTypes`).
 *  Non-mentionable types (e.g. SeedAudio image — a cloning source, not a prompt
 *  citation) get no label. Numbering is per-type, 1-based. */
export function getReferenceLabels(
  references: Reference[],
  marker: ReferenceMarkerConfig,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const group of groupReferences(references)) {
    if (!marker.mentionableTypes.includes(group.type)) continue;
    group.refs.forEach((reference, index) => {
      labels.set(reference.id, renderMarker(marker, group.type, index + 1));
    });
  }
  return labels;
}

export function buildMentionItems(
  references: Reference[],
  assets: Asset[],
  marker: ReferenceMarkerConfig,
): MentionItem[] {
  const labels = getReferenceLabels(references, marker);
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));

  return [...references]
    .filter((reference) => marker.mentionableTypes.includes(reference.type))
    .sort((a, b) => {
      const orderDiff = ASSET_TYPES.indexOf(a.type) - ASSET_TYPES.indexOf(b.type);
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
      // Every mentionable reference gets a label from getReferenceLabels above.
      label: labels.get(reference.id)!,
    }));
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive the parsing regex from a marker's template. Literal segments are
 * regex-escaped; `{{type}}` becomes an alternation of the (escaped) type names;
 * `{{index}}` becomes a NON-greedy `(\d+?)`.
 *
 * Non-greedy is required for delimiter-less templates like SeedAudio's
 * `@音频1`: greedy `(\d+)` would absorb a digit the user types right after the
 * marker (`@音频1` + `2` → `@音频12` parsed as index 12). For bracketed
 * templates the literal `]` anchors the match, so `(\d+?)` still captures the
 * full index via backtracking (e.g. `[图片12]` → 12). Built fresh per call — no
 * module cache, so it tracks language/provider switches.
 */
export function markerToRegex(marker: ReferenceMarkerConfig): RegExp {
  const typeAlt = ASSET_TYPES
    .map((type) => escapeRegex(marker.typeNames[type]))
    .join('|');
  const parts = marker.template.split(/(\{\{type\}\}|\{\{index\}\})/);
  const pattern = parts
    .map((part) => {
      if (part === '{{type}}') return `(${typeAlt})`;
      if (part === '{{index}}') return `(\\d+?)`;
      return escapeRegex(part);
    })
    .join('');
  return new RegExp(pattern, 'g');
}

export function parsePromptLabels<T>(
  text: string,
  labelToRef: Map<string, T>,
  marker: ReferenceMarkerConfig,
  renderLabel: (label: string, info: T, key: number) => ReactNode,
  renderText: (text: string, key: number) => ReactNode,
): ReactNode[] {
  const regex = markerToRegex(marker);
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
