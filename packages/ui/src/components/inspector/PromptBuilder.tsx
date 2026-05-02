import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Asset, Reference } from '@opendirector/core/types/asset';
import { MentionPopup, getReferenceLabels, buildMentionItems, escapeRegex } from './prompt-editor';

const PROMPT_TEXTAREA_MIN_HEIGHT = 144;

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
}: PromptBuilderProps) {
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

  // Auto-sync: remove deleted ref labels and re-number when references change
  const prevLabelsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const currentLabels = getReferenceLabels(references);

    if (prevLabelsRef.current.size > 0) {
      let updatedPrompt = prompt;
      let changed = false;

      for (const [id, oldLabel] of prevLabelsRef.current) {
        if (!currentLabels.has(id)) {
          const next = updatedPrompt.replace(new RegExp(escapeRegex(oldLabel), 'g'), '');
          if (next !== updatedPrompt) {
            updatedPrompt = next;
            changed = true;
          }
        }
      }

      for (const [id, currentLabel] of currentLabels) {
        const oldLabel = prevLabelsRef.current.get(id);
        if (oldLabel && oldLabel !== currentLabel) {
          const next = updatedPrompt.replace(new RegExp(escapeRegex(oldLabel), 'g'), currentLabel);
          if (next !== updatedPrompt) {
            updatedPrompt = next;
            changed = true;
          }
        }
      }

      if (changed) {
        onPromptChange(updatedPrompt);
      }
    }

    if (references.length === 0) {
      prevLabelsRef.current.clear();
    } else {
      prevLabelsRef.current = currentLabels;
    }
  }, [references, prompt, onPromptChange]);

  const mentionItems = useMemo(() => buildMentionItems(references, assets), [references, assets]);

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
          placeholder="描述你想要生成的内容..."
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
          高级选项
        </button>
      )}

      {showAdvanced && showWebSearch && (
        <div className="p-3 bg-zinc-800 rounded-lg">
          <ToggleRow
            label="联网搜索"
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
