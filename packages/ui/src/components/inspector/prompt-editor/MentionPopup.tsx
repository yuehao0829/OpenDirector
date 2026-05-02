import { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Reference, Asset } from '@opendirector/core/types/asset';
import { groupReferences, ASSET_TYPE_LABELS, AssetThumbnail } from '../ReferenceSelector';

export interface MentionItem {
  reference: Reference;
  asset: Asset | undefined;
  label: string;
}

// Compute all labels in a single pass over groupReferences (O(N) instead of O(N²))
export function getReferenceLabels(references: Reference[]): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = groupReferences(references);
  for (const group of groups) {
    group.refs.forEach((ref, i) => {
      labels.set(ref.id, `[${ASSET_TYPE_LABELS[group.type]}${i + 1}]`);
    });
  }
  return labels;
}

export function getReferenceLabel(ref: Reference, references: Reference[]): string {
  return getReferenceLabels(references).get(ref.id) ?? ASSET_TYPE_LABELS[ref.type];
}

export function buildMentionItems(references: Reference[], assets: Asset[]): MentionItem[] {
  const labels = getReferenceLabels(references);
  const assetMap = new Map(assets.map((a) => [a.id, a]));
  // Sort by type group (image → video → audio), then by label number within group
  const typeOrder: Record<string, number> = { image: 0, video: 1, audio: 2 };
  return [...references]
    .sort((a, b) => {
      const orderDiff = (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
      if (orderDiff !== 0) return orderDiff;
      const labelA = labels.get(a.id) ?? '';
      const labelB = labels.get(b.id) ?? '';
      return labelA.localeCompare(labelB, undefined, { numeric: true });
    })
    .map((ref) => ({
      reference: ref,
      asset: assetMap.get(ref.assetId),
      label: labels.get(ref.id) ?? ASSET_TYPE_LABELS[ref.type],
    }));
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex for matching reference labels in prompt text, e.g. [图片1], [视频2]
export const REFERENCE_LABEL_REGEX = new RegExp(
  `\\[(${Object.values(ASSET_TYPE_LABELS).join('|')})(\\d+)\\]`,
  'g',
);

/**
 * Parse prompt text, splitting it into text/label segments.
 * Calls `renderLabel` for each matched reference label, and `renderText` for plain text runs.
 */
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
  /* eslint-disable no-useless-assignment */
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderText(text.slice(lastIndex, match.index), key++));
    }
    const label = match[0];
    const refInfo = labelToRef.get(label);
    if (refInfo) {
      parts.push(renderLabel(label, refInfo, key++));
    } else {
      parts.push(renderText(label, key++));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(renderText(text.slice(lastIndex), key++));
  }
  /* eslint-enable no-useless-assignment */
  return parts;
}

interface MentionPopupProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  items: MentionItem[];
  filter: string;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
}

export function MentionPopup({ anchorRef, items, filter, onSelect, onClose }: MentionPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);

  const updatePosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ right: window.innerWidth - rect.right, top: rect.bottom + 4 });
  }, [anchorRef]);

  // Compute portal position from anchor element (below the textarea, right-aligned)
  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  // Recompute on scroll/resize while open
  useEffect(() => {
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [updatePosition]);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      updatePosition();
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [anchorRef, updatePosition]);

  const filteredItems = useMemo(() => {
    if (!filter) return items;
    const lower = filter.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) ||
        item.asset?.name.toLowerCase().includes(lower),
    );
  }, [items, filter]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Use refs to stabilize callbacks for event listeners
  const filteredItemsRef = useRef(filteredItems);
  filteredItemsRef.current = filteredItems;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const currentItems = filteredItemsRef.current;
    if (currentItems.length === 0) {
      if (e.key === 'Escape') onCloseRef.current();
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % currentItems.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + currentItems.length) % currentItems.length);
        break;
      case 'Enter':
        e.preventDefault();
        onSelectRef.current(currentItems[selectedIndexRef.current]);
        break;
      case 'Escape':
        e.preventDefault();
        onCloseRef.current();
        break;
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  if (!pos) return null;

  const popupStyle: React.CSSProperties = {
    position: 'fixed',
    right: pos.right,
    top: pos.top,
    zIndex: 9999,
  };

  if (filteredItems.length === 0) {
    return createPortal(
      <div
        ref={containerRef}
        className="bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl p-2 text-xs text-zinc-500"
        style={popupStyle}
      >
        无匹配参考资源
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={containerRef}
      className="bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 max-h-64 overflow-y-auto w-56"
      style={popupStyle}
    >
      {filteredItems.map((item, i) => (
        <button
          key={item.reference.id}
          className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-blue-600/30 text-white'
              : 'text-zinc-300 hover:bg-zinc-700/50'
          }`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(item)}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <AssetThumbnail type={item.reference.type} thumbnailUrl={item.asset?.thumbnailUrl} />
          <span className="truncate flex-1">{item.asset?.name ?? item.reference.assetId}</span>
          <span className="text-xs text-zinc-500 shrink-0">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
