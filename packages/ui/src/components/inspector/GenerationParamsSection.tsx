import type { GenerationParamDefaults } from '@opendirector/core/types/generation';
import { GLOBAL_GENERATION_OPTIONS } from '@opendirector/core/types/generation';
import type { CapabilityParams } from '@opendirector/core/types/provider-system';
import { isImageModel } from '@opendirector/core/types/provider-system';
import { resolveVisibleWhen } from '@opendirector/core/types/param-layout';
import { useCallback, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Panel } from '../layout/Panel';
import { renderParam } from './ParamRenderer';
import type { ParamLayoutItem } from '@opendirector/core/types/param-layout';
import { useTranslation } from 'react-i18next';
import { resolveParamIcon } from './param-icons';
import type { ReactNode } from 'react';

export interface GenerationParamsValue extends GenerationParamDefaults {
  duration: number;
  autoDuration: boolean;
  imageQuality: string;
  imageOutputFormat: string;
  imageBackground: string;
  imageModeration: string;
  imageOutputCompression?: number;
  volume?: number;
  pitch?: number;
  bitrate?: number;
  channel?: number;
  languageBoost?: string;
  voiceModifyPitch?: number;
  voiceModifyIntensity?: number;
  voiceModifyTimbre?: number;
  voiceModifySoundEffects?: string;
  pronunciationTone?: string[];
  aigcWatermark?: boolean;
  englishNormalization?: boolean;
}

interface GenerationParamsSectionProps {
  value: GenerationParamsValue;
  onChange: (value: GenerationParamsValue) => void;
  capabilityParams?: CapabilityParams;
  disabled?: boolean;
  continuousMode?: boolean;
  continuousPlan?: number[];
  totalDuration?: number;
  /** Fetch cloud voices (cloned / designed) for the voice selector. */
  voiceFetcher?: () => Promise<Array<{ value: string; label: string }>>;
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
  // TTS — emotions / formats / sample rates are provider-specific enums (MiniMax uses its own
  // emotion set and a format→sampleRate map), so they pass through like voiceIds / speedRange
  // rather than being intersected with the global SSOT (which would drop MiniMax-only values
  // such as calm/fluent/whisper and the opus-only 48000 rate).
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
    voiceIds: params.voiceIds,
    emotions: params.emotions,
    audioFormats: params.audioFormats,
    sampleRates: params.sampleRates,
    sampleRateByFormat: params.sampleRateByFormat,
    speedRange: params.speedRange,
    volumeRange: params.volumeRange,
    pitchRange: params.pitchRange,
    bitrates: params.bitrates,
    channels: params.channels,
    languageBoostOptions: params.languageBoostOptions,
    voiceModifyPitchRange: params.voiceModifyPitchRange,
    voiceModifyIntensityRange: params.voiceModifyIntensityRange,
    voiceModifyTimbreRange: params.voiceModifyTimbreRange,
    voiceModifySoundEffects: params.voiceModifySoundEffects,
    supportsPronunciationDict: params.supportsPronunciationDict,
    supportsAigcWatermark: params.supportsAigcWatermark,
    supportsEnglishNormalization: params.supportsEnglishNormalization,
    summaryFields: params.summaryFields,
    paramLayout: params.paramLayout,
    voiceModifyFormats: params.voiceModifyFormats,
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
  voiceFetcher,
}: GenerationParamsSectionProps) {
  const { t, i18n } = useTranslation();
  const params = useMemo(
    () => resolveEffectiveParams(capabilityParams ?? DEFAULT_CAPABILITY_PARAMS),
    [capabilityParams],
  );

  const isImage = isImageModel(params);

  // Cloud-fetched voices state
  const [fetchedVoices, setFetchedVoices] = useState<Array<{ value: string; label: string }> | null>(null);
  const [fetchingVoices, setFetchingVoices] = useState(false);
  // Advanced options collapsed/expanded state
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  const handleFetchVoices = useCallback(async (): Promise<Array<{ value: string; label: string }>> => {
    if (!voiceFetcher) return [];
    setFetchingVoices(true);
    try {
      const voices = await voiceFetcher();
      setFetchedVoices(voices);
      return voices;
    } catch {
      return fetchedVoices ?? [];
    } finally {
      setFetchingVoices(false);
    }
  }, [voiceFetcher, fetchedVoices]);

  // ─── Use provider-declared layout ───
  //
  // The layout comes from params.paramLayout (defined by each provider).
  // If the provider doesn't define a layout, fall back to an empty array.
  // The renderer handles dynamic option population (optionsFrom, rangeFrom)
  // and icon name → Lucide component mapping.

  const layout: ParamLayoutItem[] = params.paramLayout ?? [];

  // ─── onChange with declarative side effects ───
  //
  // Instead of hardcoding "if format changes, do X", we look up the
  // changed parameter in the layout and call its adjustOnChange (if any).
  // This keeps all parameter interdependencies declared alongside the
  // parameter definition, not scattered across the component.

  const wrappedOnChange = useCallback((next: GenerationParamsValue) => {
    // Find which parameter changed and apply its declarative side-effect
    for (const item of layout) {
      if (!item.valueKey || !item.adjustOnChange) continue;
      const key = item.valueKey as keyof GenerationParamsValue;
      if (next[key] !== value[key]) {
        const adjusted = item.adjustOnChange(next as unknown as Record<string, unknown>);
        if (adjusted !== (next as unknown as Record<string, unknown>)) {
          onChange(adjusted as unknown as GenerationParamsValue);
          return;
        }
      }
    }
    onChange(next);
  }, [value, onChange, layout]);

  return (
    <Panel
      title={<SummaryBar value={value} params={params} continuousMode={continuousMode} totalDuration={totalDuration} fetchedVoices={fetchedVoices} />}
      defaultCollapsed
    >
      <div className="space-y-5">
        {/* Continuous mode banner — not a parameter, so it's rendered outside the layout */}
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

        {/* Render all visible parameters from the declarative layout */}
        {renderLayoutBlocks(
          layout.filter((item) => !item.advanced),
          params, value, wrappedOnChange, disabled, t, i18n.language,
          voiceFetcher, handleFetchVoices, fetchingVoices, fetchedVoices,
          continuousMode, continuousPlan, totalDuration,
        )}

        {/* Advanced options — collapsible section */}
        {(() => {
          const advancedVisible = layout.filter((item) => item.advanced && resolveVisibleWhen(item.visibleWhen, params, value as unknown as Record<string, unknown>));
          if (advancedVisible.length === 0) return null;
          return (
            <div className="border border-zinc-700/50 rounded-lg overflow-hidden">
              <button
                onClick={() => setAdvancedExpanded(!advancedExpanded)}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors"
              >
                <span className="text-sm text-zinc-400 font-medium">{t('generationParams.advancedOptions')}</span>
                <ChevronDown
                  size={16}
                  className={`text-zinc-500 transition-transform ${advancedExpanded ? 'rotate-180' : ''}`}
                />
              </button>
              {advancedExpanded && (
                <div className="p-3 space-y-4">
                  {renderLayoutBlocks(
                    advancedVisible,
                    params, value, wrappedOnChange, disabled, t, i18n.language,
                    voiceFetcher, handleFetchVoices, fetchingVoices, fetchedVoices,
                    continuousMode, continuousPlan, totalDuration,
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </Panel>
  );
}

// ─── Layout renderer — handles row grouping (e.g. sampleRate + bitrate side by side) ───

function renderLayoutBlocks(
  items: ParamLayoutItem[],
  params: CapabilityParams,
  value: GenerationParamsValue,
  onChange: (v: GenerationParamsValue) => void,
  disabled: boolean | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
  lang: string,
  voiceFetcher: (() => Promise<Array<{ value: string; label: string }>>) | undefined,
  handleFetchVoices: () => Promise<Array<{ value: string; label: string }>>,
  fetchingVoices: boolean,
  fetchedVoices: Array<{ value: string; label: string }> | null,
  continuousMode: boolean | undefined,
  continuousPlan: number[] | undefined,
  totalDuration: number | undefined,
): React.ReactNode {
  const commonProps = {
    value,
    onChange,
    params,
    disabled,
    t,
    lang,
    voiceFetcher: voiceFetcher ? {
      onFetch: handleFetchVoices,
      fetching: fetchingVoices,
      fetchedVoices,
      showFetchUnavailableHint: voiceFetcher === undefined,
    } : undefined,
    continuousMode,
    continuousPlan,
    totalDuration,
  };

  // Filter to visible items only
  const visible = items.filter((item) => resolveVisibleWhen(item.visibleWhen, params, value as unknown as Record<string, unknown>));

  // Separate row items from standalone items, preserving order
  const blocks: Array<{ type: 'single' | 'row'; items: ParamLayoutItem[] }> = [];
  const rowMap = new Map<string, ParamLayoutItem[]>();

  for (const item of visible) {
    if (item.row) {
      const existing = rowMap.get(item.row);
      if (existing) {
        existing.push(item);
      } else {
        const group: ParamLayoutItem[] = [item];
        rowMap.set(item.row, group);
        blocks.push({ type: 'row', items: group });
      }
    } else {
      blocks.push({ type: 'single', items: [item] });
    }
  }

  return blocks.map((block, blockIdx) => {
    if (block.type === 'single') {
      const item = block.items[0];
      return (
        <div key={item.id}>
          {renderParam({ item, ...commonProps })}
        </div>
      );
    }
    // Row block: items already passed resolveVisibleWhen in the `visible` filter above
    const rowItems = block.items;
    if (rowItems.length === 0) return null;
    return (
      <div key={`row-${blockIdx}`} className="flex gap-3">
        {rowItems.map((item) => (
          <div key={item.id} className="flex-1 min-w-0">
            {renderParam({ item, ...commonProps })}
          </div>
        ))}
      </div>
    );
  });
}

// ─── SummaryBar: fully declarative, uses item.summaryFormat and toggle.iconOn/iconOff ───

function SummaryBar({ value, params, continuousMode, totalDuration, fetchedVoices }: { value: GenerationParamsValue; params: CapabilityParams; continuousMode?: boolean; totalDuration?: number; fetchedVoices?: Array<{ value: string; label: string }> | null }) {
  const { t, i18n } = useTranslation();
  const layout = params.paramLayout ?? [];

  interface SummaryEntry {
    key: string;
    icon: ReactNode;
    active: boolean;
  }

  const entries: SummaryEntry[] = [];
  const summaryFields = params.summaryFields;
  const allowedKeys = new Set(summaryFields ?? []);
  const hasSummaryFilter = summaryFields && summaryFields.length > 0;

  // Shared formatting context passed to summaryFormat
  const formatCtx = {
    continuousMode,
    totalDuration,
    t,
    lang: i18n.language,
    fetchedVoices: fetchedVoices ?? undefined,
    allValues: value as unknown as Record<string, unknown>,
  };

  for (const item of layout) {
    if (item.showInSummary === false) continue;
    if (!resolveVisibleWhen(item.visibleWhen, params, value as unknown as Record<string, unknown>)) continue;
    if (item.advanced) continue;

    const control = item.control;

    if (control.type === 'toggle-pill-grid') {
      // Each toggle becomes a summary entry; iconOn/iconOff come from the layout definition
      for (const toggle of control.toggles) {
        if ((params as Record<string, unknown>)[toggle.key] === undefined) continue;
        if (hasSummaryFilter && !allowedKeys.has(toggle.key)) continue;

        const isOn = value[toggle.key as keyof GenerationParamsValue] as boolean;
        const iconName = isOn
          ? (toggle.iconOn ?? toggle.icon)
          : (toggle.iconOff ?? toggle.icon);

        entries.push({
          key: toggle.key,
          icon: resolveParamIcon(iconName, 15),
          active: isOn,
        });
      }
    } else if (control.type === 'slider-group') {
      // Composite: each slider + trailing select as separate entries
      const iconName = item.summaryIcon ?? item.icon;
      const iconEl = resolveParamIcon(iconName);

      for (const slider of control.sliders) {
        if (hasSummaryFilter && !allowedKeys.has(slider.key)) continue;
        const raw = value[slider.key as keyof GenerationParamsValue];
        if (raw === undefined || raw === null || raw === '') continue;
        if (typeof raw === 'boolean' && !raw) continue;
        // Use item-level summaryFormat with the sub-key, or fall back to String()
        const formatted = item.summaryFormat
          ? item.summaryFormat(raw, params, { ...formatCtx, allValues: { ...formatCtx.allValues, __subKey: slider.key } })
          : String(raw);
        if (formatted === null) continue;
        entries.push({
          key: slider.key,
          icon: <>{iconEl}<span className="text-sm font-medium ml-1">{formatted}</span></>,
          active: true,
        });
      }
      if (control.trailingSelect) {
        const ts = control.trailingSelect;
        if (hasSummaryFilter && !allowedKeys.has(ts.key)) continue;
        const raw = value[ts.key as keyof GenerationParamsValue];
        if (raw === undefined || raw === null || raw === '') continue;
        if (typeof raw === 'boolean' && !raw) continue;
        const formatted = item.summaryFormat
          ? item.summaryFormat(raw, params, { ...formatCtx, allValues: { ...formatCtx.allValues, __subKey: ts.key } })
          : String(raw);
        if (formatted === null) continue;
        entries.push({
          key: ts.key,
          icon: <>{iconEl}<span className="text-sm font-medium ml-1">{formatted}</span></>,
          active: true,
        });
      }
    } else if (item.valueKey) {
      // Simple value item — use declarative summaryFormat
      if (hasSummaryFilter && !allowedKeys.has(item.valueKey)) continue;

      const val = value[item.valueKey as keyof GenerationParamsValue];
      if (val === undefined || val === null || val === '') continue;
      if (typeof val === 'boolean' && !val) continue;

      const displayVal = item.summaryFormat
        ? item.summaryFormat(val, params, formatCtx)
        : String(val);
      if (displayVal === null) continue;

      const iconName = item.summaryIcon ?? item.icon;
      const iconEl = resolveParamIcon(iconName);

      entries.push({
        key: item.valueKey,
        icon: (
          <>
            {iconEl}
            <span className="text-sm font-medium ml-1">{displayVal}</span>
          </>
        ),
        active: true,
      });
    }
  }

  return (
    <div className="flex items-center gap-3 w-full">
      {entries.map((entry) => (
        <div
          key={entry.key}
          className={`flex items-center ${
            entry.active === false ? 'text-zinc-600' : 'text-zinc-300'
          }`}
        >
          {entry.icon}
        </div>
      ))}
    </div>
  );
}
