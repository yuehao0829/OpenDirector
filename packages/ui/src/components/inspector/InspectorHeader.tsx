import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import { makeCompositeKey } from './compositeKey';

interface ModelOption {
  modelId: string;
  instanceId: string;
  label: string;       // e.g. "Seedance 2.0" or "Seedance 2.0 (My Instance)"
}

interface InspectorHeaderProps {
  activeTab: 'edit' | 'preview';
  onTabChange: (tab: 'edit' | 'preview') => void;
  hasGenerated: boolean;
  isGenerating: boolean;
  onGenerate: () => void;
  disabled?: boolean;
  models: ModelOption[];
  selectedCompositeKey: string;
  onModelChange: (modelId: string, instanceId: string) => void;
  modelDisabled?: boolean;
  trackType?: 'video' | 'audio';
  /** Continuous segment progress info, e.g. { current: 2, total: 4, percent: 45 } */
  segmentProgress?: { current: number; total: number; percent: number } | null;
}

export function InspectorHeader({
  activeTab,
  onTabChange,
  hasGenerated,
  isGenerating,
  onGenerate,
  disabled,
  models,
  selectedCompositeKey,
  onModelChange,
  modelDisabled,
  trackType = 'video',
  segmentProgress,
}: InspectorHeaderProps) {
  const isAudio = trackType === 'audio';

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
      {!isAudio && (
        <div className="flex gap-1">
          <TabButton
            label="编辑"
            active={activeTab === 'edit'}
            onClick={() => onTabChange('edit')}
          />
          <TabButton
            label="预览"
            active={activeTab === 'preview'}
            onClick={() => onTabChange('preview')}
          />
        </div>
      )}

      {!isAudio && (
        <div className="flex items-center gap-2">
          <ModelSelector
            models={models}
            selectedCompositeKey={selectedCompositeKey}
            onModelChange={onModelChange}
            disabled={modelDisabled || isGenerating}
          />
          <button
            onClick={onGenerate}
            disabled={disabled || isGenerating}
            className={clsx(
              'px-3 py-1 text-xs font-medium rounded-md transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'bg-blue-600 text-white hover:bg-blue-700'
            )}
          >
            {isGenerating
              ? segmentProgress
                ? `生成中 ${segmentProgress.current}/${segmentProgress.total} — ${segmentProgress.percent}%`
                : '生成中...'
              : hasGenerated ? '再次生成' : '生成'}
          </button>
        </div>
      )}

      {isAudio && (
        <span className="text-sm font-medium text-blue-400">音频片段</span>
      )}
    </div>
  );
}

function ModelSelector({
  models,
  selectedCompositeKey,
  onModelChange,
  disabled,
}: {
  models: ModelOption[];
  selectedCompositeKey: string;
  onModelChange: (modelId: string, instanceId: string) => void;
  disabled?: boolean;
}) {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const model = models.find((m) => makeCompositeKey(m.instanceId, m.modelId) === e.target.value);
    if (model) onModelChange(model.modelId, model.instanceId);
  };

  return (
    <div className="relative">
      <select
        value={selectedCompositeKey}
        onChange={handleChange}
        disabled={disabled || models.length === 0}
        className="appearance-none bg-zinc-800 border border-zinc-700 rounded-md pl-2 pr-5 py-1 text-xs text-white
          disabled:opacity-50 disabled:cursor-not-allowed
          focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {!selectedCompositeKey && (
          <option value="" disabled>
            模型
          </option>
        )}
        {models.map((m) => (
          <option key={makeCompositeKey(m.instanceId, m.modelId)} value={makeCompositeKey(m.instanceId, m.modelId)}>
            {m.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={12}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
      />
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
        active
          ? 'bg-zinc-700 text-white'
          : 'text-zinc-500 hover:text-zinc-300'
      )}
    >
      {label}
    </button>
  );
}
