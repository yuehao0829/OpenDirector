import type { GenerationParamDefaults } from '@opendirector/core/types/generation';
import { GLOBAL_GENERATION_OPTIONS } from '@opendirector/core/types/generation';
import type { CapabilityParams } from '@opendirector/core/types/provider-system';
import { isImageModel } from '@opendirector/core/types/provider-system';
import { useMemo } from 'react';
import { Monitor, RectangleHorizontal, Clock, Volume2, VolumeX, Music, Music4, Subtitles, Stamp } from 'lucide-react';
import { Panel } from '../layout/Panel';
import { TOGGLE_DEFS, type ToggleKey } from '../shared/GenerationControls.shared';
import { TogglePill, SettingCard } from '../shared/GenerationControls';
import { useTranslation } from 'react-i18next';

export interface GenerationParamsValue extends GenerationParamDefaults {
  duration: number;
  autoDuration: boolean;
  imageQuality: string;
  imageOutputFormat: string;
  imageBackground: string;
  imageModeration: string;
  imageOutputCompression?: number;
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
    ? GLOBAL_GENERATION_OPTIONS.resolution.filter((r) => params.resolution!.includes(r))
    : undefined;
  const aspectRatios = params.aspectRatios
    ? GLOBAL_GENERATION_OPTIONS.aspectRatios.filter((r) => params.aspectRatios!.includes(r))
    : undefined;
  const imageQuality = params.imageQuality
    ? GLOBAL_GENERATION_OPTIONS.imageQuality.filter((q) => params.imageQuality!.includes(q))
    : undefined;
  const imageOutputFormats = params.imageOutputFormats
    ? GLOBAL_GENERATION_OPTIONS.imageOutputFormats.filter((f) => params.imageOutputFormats!.includes(f))
    : undefined;
  const imageBackgrounds = params.imageBackgrounds
    ? GLOBAL_GENERATION_OPTIONS.imageBackgrounds.filter((b) => params.imageBackgrounds!.includes(b))
    : undefined;
  const imageModeration = params.imageModeration
    ? GLOBAL_GENERATION_OPTIONS.imageModeration.filter((m) => params.imageModeration!.includes(m))
    : undefined;

  return {
    outputType: params.outputType,
    resolution: resolutions && resolutions.length > 0 ? resolutions : undefined,
    aspectRatios: aspectRatios && aspectRatios.length > 0 ? aspectRatios : undefined,
    imageQuality: imageQuality && imageQuality.length > 0 ? imageQuality : undefined,
    imageOutputFormats: imageOutputFormats && imageOutputFormats.length > 0 ? imageOutputFormats : undefined,
    imageBackgrounds: imageBackgrounds && imageBackgrounds.length > 0 ? imageBackgrounds : undefined,
    imageModeration: imageModeration && imageModeration.length > 0 ? imageModeration : undefined,
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
  const { t } = useTranslation();
  const params = useMemo(
    () => resolveEffectiveParams(capabilityParams ?? DEFAULT_CAPABILITY_PARAMS),
    [capabilityParams],
  );

  const isImage = isImageModel(params);

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
        {!isImage && continuousMode && continuousPlan && continuousPlan.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
            <div className="text-sm font-medium text-amber-400">
              {t('generationParams.continuousMode', { count: continuousPlan.length })}
            </div>
            <div className="text-xs text-amber-400/70 mt-0.5">
              {continuousPlan.join('s + ')}s = {Math.ceil((totalDuration ?? 0) / 1000)}s
            </div>
          </div>
        )}

        {/* Aspect Ratio — shared by image and video */}
        {params.aspectRatios && params.aspectRatios.length > 0 && (
          <SettingCard label={t('settings.generationDefaults.aspectRatio')}>
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

        {params.resolution && params.resolution.length > 0 && (
          <SettingCard label={t('settings.generationDefaults.resolution')}>
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

        {!isImage && visibleToggles.length > 0 && (
          <div className="grid grid-cols-2 gap-1.5">
            {visibleToggles.map((toggle) => (
              <TogglePill
                key={toggle.key}
                icon={toggle.icon}
                label={t(toggle.labelKey)}
                active={toggle.key === 'enableMusic' ? value[toggle.key] && value.enableAudio : value[toggle.key]}
                onClick={() => {
                  if (toggle.key === 'enableAudio' && value.enableAudio) {
                    const next = { ...value, enableAudio: false };
                    if (value.enableMusic) next.enableMusic = false;
                    onChange(next);
                  } else {
                    onChange({ ...value, [toggle.key]: !value[toggle.key] });
                  }
                }}
                disabled={disabled || (toggle.key === 'enableMusic' && !value.enableAudio)}
              />
            ))}
          </div>
        )}

        {!isImage && params.durationRange && (
          <SettingCard
            label={
              continuousMode
                ? t('generationParams.durationContinuous', { seconds: Math.ceil((totalDuration ?? 0) / 1000) })
                : t('generationParams.duration', { value: value.autoDuration ? t('generationParams.adaptive') : `${value.duration}s` })
            }
            extra={
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">{t('generationParams.adaptive')}</span>
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

        {isImage && params.imageQuality && params.imageQuality.length > 0 && (
          <SettingCard label={t('generationParams.imageQuality')}>
            <div className="flex gap-1.5">
              {params.imageQuality.map((q) => (
                <button
                  key={q}
                  onClick={() => onChange({ ...value, imageQuality: q })}
                  disabled={disabled}
                  className={`flex-1 px-2 py-2 text-sm rounded-md transition-colors ${
                    value.imageQuality === q
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
                  }`}
                >
                  {q}
                </button>
              ))}
            </div>
          </SettingCard>
        )}

        {isImage && params.imageOutputFormats && params.imageOutputFormats.length > 0 && (
          <SettingCard label={t('generationParams.imageOutputFormat')}>
            <div className="flex gap-1.5">
              {params.imageOutputFormats.map((f) => (
                <button
                  key={f}
                  onClick={() => {
                    let next: GenerationParamsValue = { ...value, imageOutputFormat: f };
                    if (f === 'jpeg' && value.imageBackground === 'transparent') {
                      next.imageBackground = 'auto';
                    }
                    onChange(next);
                  }}
                  disabled={disabled}
                  className={`flex-1 px-2 py-2 text-sm rounded-md transition-colors uppercase ${
                    value.imageOutputFormat === f
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </SettingCard>
        )}

        {isImage && params.imageBackgrounds && params.imageBackgrounds.length > 0 && (
          <SettingCard label={t('generationParams.imageBackground')}>
            <div className="flex gap-1.5">
              {params.imageBackgrounds
                .filter((b) => b !== 'transparent' || value.imageOutputFormat !== 'jpeg')
                .map((b) => (
                <button
                  key={b}
                  onClick={() => {
                    let next: GenerationParamsValue = { ...value, imageBackground: b };
                    if (b === 'transparent' && value.imageOutputFormat === 'jpeg') {
                      next.imageOutputFormat = 'png';
                    }
                    onChange(next);
                  }}
                  disabled={disabled}
                  className={`flex-1 px-2 py-2 text-sm rounded-md transition-colors ${
                    value.imageBackground === b
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </SettingCard>
        )}

        {isImage && (value.imageOutputFormat === 'jpeg' || value.imageOutputFormat === 'webp') && (
          <SettingCard label={t('generationParams.imageOutputCompression')}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={value.imageOutputCompression ?? 80}
                onChange={(e) => onChange({ ...value, imageOutputCompression: Number(e.target.value) })}
                disabled={disabled}
                className="flex-1 accent-blue-500 disabled:opacity-40"
              />
              <span className="text-xs text-zinc-400 w-8 text-right">{value.imageOutputCompression ?? 80}%</span>
            </div>
          </SettingCard>
        )}
      </div>
    </Panel>
  );
}

function SummaryBar({ value, params, continuousMode, totalDuration }: { value: GenerationParamsValue; params: CapabilityParams; continuousMode?: boolean; totalDuration?: number }) {
  const { t } = useTranslation();
  const items: { icon: React.ReactNode; active?: boolean }[] = [];
  const isImage = isImageModel(params);

  if (isImage) {
    if (params.resolution && params.resolution.length > 0) {
      items.push({ icon: <Monitor size={15} />, active: true });
      items.push({ icon: <span className="text-sm font-medium">{value.resolution}</span>, active: true });
    }
    if (params.aspectRatios && params.aspectRatios.length > 0) {
      items.push({ icon: <RectangleHorizontal size={15} />, active: true });
      items.push({ icon: <span className="text-sm font-medium">{value.aspectRatio}</span>, active: true });
    }
    if (params.imageQuality && params.imageQuality.length > 0) {
      items.push({ icon: <span className="text-sm font-medium">{value.imageQuality}</span>, active: true });
    }
    if (params.imageOutputFormats && params.imageOutputFormats.length > 0) {
      items.push({ icon: <span className="text-sm font-medium uppercase">{value.imageOutputFormat}</span>, active: true });
    }
    if (params.imageBackgrounds && params.imageBackgrounds.length > 0) {
      items.push({ icon: <span className="text-sm font-medium">{value.imageBackground}</span>, active: true });
    }
  } else {
    if (params.resolution && params.resolution.length > 0) {
      items.push({ icon: <Monitor size={15} />, active: true });
      items.push({ icon: <span className="text-sm font-medium">{value.resolution}</span>, active: true });
    }

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
        items.push({ icon: <span className="text-sm font-medium">{t('generationParams.secondsContinuousShort', { seconds: Math.ceil((totalDuration ?? 0) / 1000) })}</span>, active: true });
      } else {
        items.push({ icon: <span className="text-sm font-medium">{value.duration}s</span>, active: true });
      }
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

