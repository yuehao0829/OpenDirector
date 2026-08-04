import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Asset, Reference } from '@opendirector/core/types/asset';
import type { InputRequirements } from '@opendirector/core/types/provider-system';
import { useTranslation } from 'react-i18next';
import { MentionPopup, getReferenceLabels, buildMentionItems, escapeRegex, resolveMarkerForUi } from './prompt-editor';

const PROMPT_TEXTAREA_MIN_HEIGHT = 144;

/**
 * Regex matching a reference `label` as a whole token, for renumber/deletion.
 * For labels ending in a digit (delimiter-less markers like `@音频1`), append a
 * `(?!\d)` boundary so `@音频1` does not match inside `@音频10`. Bracketed
 * labels (`[图片1]`) end in `]`, so no boundary is needed — and adding one would
 * wrongly reject `[图片1]` followed by a digit.
 */
function labelReplaceRegex(label: string): RegExp {
  const trailingDigit = /\d$/.test(label);
  return new RegExp(escapeRegex(label) + (trailingDigit ? '(?!\\d)' : ''), 'g');
}

interface PromptBuilderProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  enableWebSearch?: boolean;
  onWebSearchChange?: (enabled: boolean) => void;
  showWebSearch?: boolean;
  warnings?: string[];
  references?: Reference[];
  assets?: Asset[];
  autoFocus?: boolean;
  /** Model input requirements — drives the declarative reference marker
   *  (`referenceMarker`). Omit to fall back to the default `[类型N]` marker. */
  inputRequirements?: InputRequirements;
  /** Lifted label-state ref (from the always-mounted parent). Lets the renumber
   *  effect survive this input unmounting (e.g. switching to preview mode) so a
   *  marker change during unmount is still migrated on remount. */
  labelStateRef?: { current: Map<string, string> };
}

export function PromptBuilder({
  prompt,
  onPromptChange,
  enableWebSearch = false,
  onWebSearchChange,
  showWebSearch = true,
  warnings,
  references = [],
  assets = [],
  autoFocus = false,
  inputRequirements,
  labelStateRef,
}: PromptBuilderProps) {
  const { t } = useTranslation();
  // Marker is recomputed when the model (inputRequirements) or language (t)
  // changes — no module-level cache, so mention insertion/rendering/renumbering
  // always follow the declared format (e.g. SeedAudio `@音频1` vs Seedance `[图片1]`).
  const marker = useMemo(() => resolveMarkerForUi(inputRequirements, t), [inputRequirements, t]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionStartRef = useRef<number | null>(null);
  const selectionRef = useRef({ start: 0, end: 0 });

  // Auto-focus textarea when autoFocus is true (e.g. draft fragment creation)
  useEffect(() => {
    if (autoFocus) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [autoFocus]);

  // Track mentionOpen via ref to avoid stale closure in handleChange
  const mentionOpenRef = useRef(false);
  const setMentionOpenTracked = useCallback((open: boolean) => {
    mentionOpenRef.current = open;
    setMentionOpen(open);
  }, []);

  const readSelectionFromTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return selectionRef.current;
    const start = textarea.selectionStart ?? selectionRef.current.start;
    const end = textarea.selectionEnd ?? start;
    const selection = { start, end };
    selectionRef.current = selection;
    return selection;
  }, []);

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, PROMPT_TEXTAREA_MIN_HEIGHT)}px`;
  }, []);

  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current);
    readSelectionFromTextarea();
  }, [prompt, readSelectionFromTextarea, resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const container = textarea?.parentElement;
    if (!textarea || !container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      resizeTextarea(textarea);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const syncSelection = useCallback(() => {
    readSelectionFromTextarea();
  }, [readSelectionFromTextarea]);

  const insertTextAtSelection = useCallback(
    (insertText: string) => {
      const { start, end } = readSelectionFromTextarea();
      const before = prompt.slice(0, start);
      const after = prompt.slice(end);
      const newPrompt = before + insertText + after;
      const newPos = before.length + insertText.length;

      onPromptChange(newPrompt);
      selectionRef.current = { start: newPos, end: newPos };

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newPos, newPos);
        }
      });
    },
    [prompt, onPromptChange, readSelectionFromTextarea],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursorPos = e.target.selectionStart ?? 0;
      const selectionEnd = e.target.selectionEnd ?? cursorPos;

      selectionRef.current = { start: cursorPos, end: selectionEnd };
      resizeTextarea(e.target);

      onPromptChange(value);

      if (value[cursorPos - 1] === '@') {
        const before = value[cursorPos - 2];
        if (before === undefined || before === ' ' || before === '\n') {
          mentionStartRef.current = cursorPos - 1;
          setMentionFilter('');
          setMentionOpenTracked(true);
          return;
        }
      }

      if (mentionOpenRef.current && mentionStartRef.current !== null) {
        const textAfterAt = value.slice(mentionStartRef.current + 1, cursorPos);
        if (textAfterAt.includes(' ') || textAfterAt.includes('\n') || textAfterAt.includes('@')) {
          setMentionOpenTracked(false);
          mentionStartRef.current = null;
        } else {
          setMentionFilter(textAfterAt);
        }
      }
    },
    [onPromptChange, resizeTextarea, setMentionOpenTracked],
  );

  const handleMentionSelect = useCallback(
    (item: { label: string }) => {
      if (mentionStartRef.current === null) return;

      const replaceEnd = readSelectionFromTextarea().start;
      if (replaceEnd < mentionStartRef.current) return;

      const before = prompt.slice(0, mentionStartRef.current);
      const after = prompt.slice(replaceEnd);
      const newPrompt = before + item.label + after;
      const newCursorPos = before.length + item.label.length;

      onPromptChange(newPrompt);
      setMentionOpenTracked(false);
      mentionStartRef.current = null;
      setMentionFilter('');
      selectionRef.current = { start: newCursorPos, end: newCursorPos };

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      });
    },
    [prompt, onPromptChange, readSelectionFromTextarea, setMentionOpenTracked],
  );

  const handleMentionClose = useCallback(() => {
    setMentionOpenTracked(false);
    mentionStartRef.current = null;
    setMentionFilter('');
  }, [setMentionOpenTracked]);

  // Auto-sync: remove deleted ref labels and re-number when references/marker
  // change. `labelStateRef` is lifted from the always-mounted parent so a
  // marker change while this input is unmounted (e.g. switching model in
  // preview mode) is still migrated on remount — `prevLabels` retains the
  // old-format labels.
  const internalLabelStateRef = useRef<Map<string, string>>(new Map());
  const prevLabelsRef = labelStateRef ?? internalLabelStateRef;
  // Read the latest prompt via a ref instead of a dep, so this effect does NOT
  // re-run on every keystroke (renumbering only depends on references/marker).
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  useEffect(() => {
    const currentLabels = getReferenceLabels(references, marker);
    if (prevLabelsRef.current.size === 0) {
      prevLabelsRef.current = references.length === 0 ? new Map() : currentLabels;
      return;
    }

    // Collect deletions (removed refs) and renames (index/marker changed).
    const deletions: string[] = [];
    const renames: Array<{ from: string; to: string }> = [];
    for (const [id, oldLabel] of prevLabelsRef.current) {
      const newLabel = currentLabels.get(id);
      if (newLabel === undefined) deletions.push(oldLabel);
      else if (newLabel !== oldLabel) renames.push({ from: oldLabel, to: newLabel });
    }

    if (deletions.length === 0 && renames.length === 0) {
      prevLabelsRef.current = references.length === 0 ? new Map() : currentLabels;
      return;
    }

    let updated = promptRef.current;
    // Phase 1 — rename each oldLabel → a unique placeholder. A function
    // replacer avoids `$`-pattern interpretation; placeholders avoid clobbering
    // when two refs swap indices; the `(?!\d)` boundary (for digit-ending
    // labels) stops `@音频1` matching inside `@音频10`.
    const pending = renames.map((r, i) => ({ ...r, ph: `__pb_ph_${i}__` }));
    for (const r of pending) {
      updated = updated.replace(labelReplaceRegex(r.from), () => r.ph);
    }
    // Phase 2 — delete removed labels.
    for (const oldLabel of deletions) {
      updated = updated.replace(labelReplaceRegex(oldLabel), '');
    }
    // Phase 3 — resolve placeholders → new labels (split/join is literal, no `$`).
    for (const r of pending) {
      updated = updated.split(r.ph).join(r.to);
    }

    if (updated !== promptRef.current) {
      onPromptChange(updated);
    }
    prevLabelsRef.current = references.length === 0 ? new Map() : currentLabels;
  }, [references, onPromptChange, marker, prevLabelsRef]);

  const mentionItems = useMemo(() => buildMentionItems(references, assets, marker), [references, assets, marker]);

  return (
    <div className="space-y-3" data-testid="prompt-builder">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={handleChange}
          onClick={syncSelection}
          onFocus={syncSelection}
          onKeyUp={syncSelection}
          onSelect={syncSelection}
          placeholder={t('inspector.placeholders.prompt')}
          className="w-full min-h-36 overflow-hidden px-3 py-2 text-sm text-zinc-100 bg-zinc-800 border border-zinc-700 rounded-lg placeholder-zinc-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          data-testid="prompt-input"
        />
        {mentionOpen && (
          <MentionPopup
            anchorRef={textareaRef}
            items={mentionItems}
            filter={mentionFilter}
            onSelect={handleMentionSelect}
            onClose={handleMentionClose}
          />
        )}
      </div>

      {mentionItems.length > 0 && !mentionOpen && (
        <div className="flex flex-wrap gap-1.5">
          {mentionItems.map((item) => (
            <button
              key={item.reference.id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-zinc-700 rounded text-xs text-blue-300 hover:bg-zinc-600 transition-colors"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertTextAtSelection(item.label)}
            >
              {item.asset?.thumbnailUrl && (
                <img src={item.asset.thumbnailUrl} alt="" className="w-3.5 h-3.5 rounded object-cover" />
              )}
              {item.label}
            </button>
          ))}
        </div>
      )}

      {warnings && warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-400">
              {w}
            </p>
          ))}
        </div>
      )}

      {showWebSearch && (
        <button
          className="flex items-center text-xs text-zinc-400 hover:text-white"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {t('inspector.promptBuilder.advancedOptions')}
        </button>
      )}

      {showAdvanced && showWebSearch && (
        <div className="p-3 bg-zinc-800 rounded-lg">
          <ToggleRow
            label={t('inspector.promptBuilder.webSearch')}
            checked={enableWebSearch}
            onChange={onWebSearchChange ?? (() => {})}
          />
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-zinc-400">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-4 rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
