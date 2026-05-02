import { useSettingsStore } from '@opendirector/core/stores/settingsStore';
import { GLOBAL_GENERATION_OPTIONS } from '@opendirector/core/types/generation';
import { Monitor, RectangleHorizontal } from 'lucide-react';
import { TOGGLE_DEFS, TogglePill, SettingCard } from '../shared/GenerationControls';

export function GenerationDefaultsPanel() {
  const params = useSettingsStore((s) => s.defaultGenerationParams);
  const setParams = useSettingsStore((s) => s.setDefaultGenerationParams);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-zinc-200 mb-1">默认生成参数</h2>
      </div>

      <div className="space-y-4">
        {/* Resolution */}
        <SettingCard label="分辨率" icon={<Monitor size={15} />}>
          <div className="flex gap-1.5">
            {GLOBAL_GENERATION_OPTIONS.resolution.map((r) => (
              <button
                key={r}
                onClick={() => setParams({ resolution: r })}
                className={`flex-1 px-3 py-2 text-sm rounded-md transition-colors ${
                  params.resolution === r
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </SettingCard>

        {/* Aspect Ratio */}
        <SettingCard label="宽高比" icon={<RectangleHorizontal size={15} />}>
          <div className="flex gap-1.5 min-w-0">
            {GLOBAL_GENERATION_OPTIONS.aspectRatios.map((ratio) => (
              <button
                key={ratio}
                onClick={() => setParams({ aspectRatio: ratio })}
                className={`flex-1 min-w-0 px-1 py-2 text-sm rounded-md transition-colors text-center truncate ${
                  params.aspectRatio === ratio
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
                } ${ratio === 'adaptive' ? 'flex-[1.5]' : ''}`}
              >
                {ratio}
              </button>
            ))}
          </div>
        </SettingCard>

        {/* Toggles */}
        <div className="grid grid-cols-2 gap-1.5">
          {TOGGLE_DEFS.map((t) => (
            <TogglePill
              key={t.key}
              icon={t.icon}
              label={t.label}
              active={params[t.key]}
              onClick={() => setParams({ [t.key]: !params[t.key] })}
            />
          ))}
        </div>

        {/* Web search toggle */}
        {GLOBAL_GENERATION_OPTIONS.enableWebSearch && (
          <SettingCard label="联网搜索">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">生成时启用联网搜索</span>
              <button
                onClick={() => setParams({ enableWebSearch: !params.enableWebSearch })}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  params.enableWebSearch ? 'bg-blue-600' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    params.enableWebSearch ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </SettingCard>
        )}
      </div>
    </div>
  );
}

