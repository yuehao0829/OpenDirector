import type { GenerationParamDefaults } from '@opendirector/core/types/generation';
import { GLOBAL_GENERATION_OPTIONS } from '@opendirector/core/types/generation';
import type { CapabilityParams } from '@opendirector/core/types/provider-system';
import { useMemo } from 'react';
import { Monitor, RectangleHorizontal, Clock, Volume2, VolumeX, Music, Music4, Subtitles, Stamp } from 'lucide-react';
import { Panel } from '../layout/Panel';
import { TOGGLE_DEFS, type ToggleKey } from '../shared/GenerationControls.shared';
import { TogglePill, SettingCard } from '../shared/GenerationControls';

export interface GenerationParamsValue extends GenerationParamDefaults {
  duration: number;
  autoDuration: boolean;
}

interface GenerationParamsSectionProps {
  value: GenerationParamsValue;
  onChange: (value: GenerationParamsValue) => void;
  capabilityParams?: CapabilityParams;
  disabled?: boolean;
  continuousMode?: boolean;
  continuousPlan?: number[];
  totalDuration?: number;
}

const DEFAULT_CAPABILITY_PARAMS: CapabilityParams = {
  resolution: [...GLOBAL_GENERATION_OPTIONS.resolution],
  aspectRatios: [...GLOBAL_GENERATION_OPTIONS.aspectRatios],
  durationRange: { min: 2, max: 15, step: 1 },
  enableAudio: GLOBAL_GENERATION_OPTIONS.enableAudio,
  enableMusic: GLOBAL_GENERATION_OPTIONS.enableMusic,
  enableSubtitle: GLOBAL_GENERATION_OPTIONS.enableSubtitle,
  enableWatermark: GLOBAL_GENERATION_OPTIONS.enableWatermark,
  enableWebSearch: GLOBAL_GENERATION_OPTIONS.enableWebSearch,
};

/**
 * Intersect provider's CapabilityParams with global SSOT:
 * - Provider controls which params to show and which values it supports
 * - Global SSOT defines the universe of all possible values
 * - Inspector shows only values that exist in both global and provider lists
 */
function resolveEffectiveParams(params: CapabilityParams): CapabilityParams {
  const resolutions = params.resolution
    ? [...GLOBAL_GENERATION_OPTIONS.resolution].filter((r) => params.resolution!.includes(r))
    : undefined;
  const aspectRatios = params.aspectRatios
    ? [...GLOBAL_GENERATION_OPTIONS.aspectRatios].filter((r) => params.aspectRatios!.includes(r))
    : undefined;

  return {
    resolution: resolutions && resolutions.length > 0 ? resolutions : undefined,
    aspectRatios: aspectRatios && aspectRatios.length > 0 ? aspectRatios : undefined,
    durationRange: params.durationRange,
    enableAudio: params.enableAudio,
    enableMusic: params.enableMusic,
    enableSubtitle: params.enableSubtitle,
    enableWatermark: params.enableWatermark,
    enableWebSearch: params.enableWebSearch,
  };
}

export function GenerationParamsSection({
  value,
  onChange,
  capabilityParams,
  disabled,
  continuousMode,
  continuousPlan,
  totalDuration,
}: GenerationParamsSectionProps) {
  const params = useMemo(
    () => resolveEffectiveParams(capabilityParams ?? DEFAULT_CAPABILITY_PARAMS),
    [capabilityParams],
  );

  const visibleToggles = TOGGLE_DEFS.filter((t) =>
    t.key === 'enableAudio' ? params[t.key] !== false : !!params[t.key],
  );

  return (
    <Panel
      title={<SummaryBar value={value} params={params} continuousMode={continuousMode} totalDuration={totalDuration} />}
      defaultCollapsed
    >
      <div className="space-y-5">
        {/* Continuous mode banner */}
        {continuousMode && continuousPlan && continuousPlan.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
            <div className="text-sm font-medium text-amber-400">
              连续生成模式: {continuousPlan.length} 段
            </div>
            <div className="text-xs text-amber-400/70 mt-0.5">
              {continuousPlan.join('s + ')}s = {Math.ceil((totalDuration ?? 0) / 1000)}s
            </div>
          </div>
        )}

        {/* Resolution */}
        {params.resolution && params.resolution.length > 0 && (
          <SettingCard label="分辨率">
            <div className="flex gap-1.5">
              {params.resolution.map((r) => (
                <button
                  key={r}
                  onClick={() => onChange({ ...value, resolution: r })}
                  disabled={disabled}
                  className={`flex-1 px-3 py-2 text-sm rounded-md transition-colors ${
                    value.resolution === r
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </SettingCard>
        )}

        {/* Aspect Ratio */}
        {params.aspectRatios && params.aspectRatios.length > 0 && (
          <SettingCard label="宽高比">
            <div className="flex gap-1.5 min-w-0">
              {params.aspectRatios.map((ratio) => (
                <button
                  key={ratio}
                  onClick={() => onChange({ ...value, aspectRatio: ratio })}
                  disabled={disabled}
                  className={`flex-1 min-w-0 px-1 py-2 text-sm rounded-md transition-colors text-center truncate ${
                    value.aspectRatio === ratio
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
                  } ${ratio === 'adaptive' ? 'flex-[1.5]' : ''}`}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </SettingCard>
        )}

        {/* Toggles */}
        {visibleToggles.length > 0 && (
          <div className="grid grid-cols-2 gap-1.5">
            {visibleToggles.map((t) => (
              <TogglePill
                key={t.key}
                icon={t.icon}
                label={t.label}
                active={t.key === 'enableMusic' ? value[t.key] && value.enableAudio : value[t.key]}
                onClick={() => {
                  if (t.key === 'enableAudio' && value.enableAudio) {
                    const next = { ...value, enableAudio: false };
                    if (value.enableMusic) next.enableMusic = false;
                    onChange(next);
                  } else {
                    onChange({ ...value, [t.key]: !value[t.key] });
                  }
                }}
                disabled={disabled || (t.key === 'enableMusic' && !value.enableAudio)}
              />
            ))}
          </div>
        )}

        {/* Duration */}
        {params.durationRange && (
          <SettingCard
            label={
              continuousMode
                ? `时长: ${Math.ceil((totalDuration ?? 0) / 1000)}s (连续生成)`
                : `时长: ${value.autoDuration ? '自适应' : `${value.duration}s`}`
            }
            extra={
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">自适应</span>
                <button
                  onClick={() => onChange({ ...value, autoDuration: !value.autoDuration })}
                  disabled={disabled || continuousMode}
                  className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
                    value.autoDuration ? 'bg-blue-600' : 'bg-zinc-700'
                  } disabled:opacity-50`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                      value.autoDuration ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            }
          >
            {!value.autoDuration && (
              <>
                <input
                  type="range"
                  min={params.durationRange.min}
                  max={params.durationRange.max}
                  step={params.durationRange.step}
                  value={value.duration}
                  onChange={(e) =>
                    onChange({ ...value, duration: Number(e.target.value) })
                  }
                  disabled={disabled || continuousMode}
                  className="w-full accent-blue-500 disabled:opacity-40"
                />
                <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                  <span>{params.durationRange.min}s</span>
                  <span>{params.durationRange.max}s</span>
                </div>
              </>
            )}
          </SettingCard>
        )}
      </div>
    </Panel>
  );
}

function SummaryBar({ value, params, continuousMode, totalDuration }: { value: GenerationParamsValue; params: CapabilityParams; continuousMode?: boolean; totalDuration?: number }) {
  const items: { icon: React.ReactNode; active?: boolean }[] = [];

  items.push({ icon: <Monitor size={15} />, active: true });
  items.push({ icon: <span className="text-sm font-medium">{value.resolution}</span>, active: true });

  if (params.aspectRatios && params.aspectRatios.length > 0) {
    items.push({ icon: <RectangleHorizontal size={15} />, active: true });
    items.push({ icon: <span className="text-sm font-medium">{value.aspectRatio}</span>, active: true });
  }

  const toggleSummary: { key: ToggleKey; onIcon: React.ReactNode; offIcon: React.ReactNode }[] = [
    { key: 'enableAudio', onIcon: <Volume2 size={15} />, offIcon: <VolumeX size={15} /> },
    { key: 'enableMusic', onIcon: <Music4 size={15} />, offIcon: <Music size={15} /> },
    { key: 'enableSubtitle', onIcon: <Subtitles size={15} />, offIcon: <Subtitles size={15} /> },
    { key: 'enableWatermark', onIcon: <Stamp size={15} />, offIcon: <Stamp size={15} /> },
  ];

  for (const t of toggleSummary) {
    const paramVal = t.key === 'enableAudio' ? params.enableAudio !== false : params[t.key];
    if (paramVal) {
      items.push({
        icon: value[t.key] ? t.onIcon : t.offIcon,
        active: value[t.key],
      });
    }
  }

  if (params.durationRange) {
    items.push({ icon: <Clock size={15} />, active: true });
    if (continuousMode) {
      items.push({ icon: <span className="text-sm font-medium">{Math.ceil((totalDuration ?? 0) / 1000)}s (连续)</span>, active: true });
    } else {
      items.push({ icon: <span className="text-sm font-medium">{value.duration}s</span>, active: true });
    }
  }

  return (
    <div className="flex items-center gap-3 w-full">
      {items.map((item, i) => (
        <div
          key={i}
          className={`flex items-center ${
            item.active === false ? 'text-zinc-600' : 'text-zinc-300'
          }`}
        >
          {item.icon}
        </div>
      ))}
    </div>
  );
}

