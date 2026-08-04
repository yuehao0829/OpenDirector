/**
 * Generic parameter renderer — renders a ParamLayoutItem using the
 * appropriate control component. The output is byte-for-byte identical
 * to the original hardcoded JSX for Seedance parameters.
 */

import {
  X, Plus, RefreshCw, Loader2,
} from 'lucide-react';
import type { ParamLayoutItem, ParamControl } from '@opendirector/core/types/param-layout';
import type { GenerationParamsValue } from './GenerationParamsSection';
import type { CapabilityParams } from '@opendirector/core/types/provider-system';
import { ratesForFormat } from '@opendirector/core/utils/audio-params';
import { TogglePill, SettingCard } from '../shared/GenerationControls';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { resolveParamIcon } from './param-icons';

// ─── Dynamic options resolution from CapabilityParams ───

function resolveOptionsFromParams(
  optionsFrom: string | undefined,
  params: CapabilityParams,
  value: GenerationParamsValue,
  t: (key: string, options?: Record<string, unknown>) => string,
): Array<{ value: string; label: string }> {
  if (!optionsFrom) return [];

  switch (optionsFrom) {
    case 'aspectRatios':
      return (params.aspectRatios ?? []).map((r) => ({ value: r, label: r }));
    case 'resolution':
      return (params.resolution ?? []).map((r) => ({ value: r, label: r }));
    case 'imageQuality':
      return (params.imageQuality ?? []).map((q) => ({ value: q, label: q }));
    case 'imageOutputFormats':
      return (params.imageOutputFormats ?? []).map((f) => ({ value: f, label: f }));
    case 'imageBackgrounds':
      return (params.imageBackgrounds ?? [])
        .filter((b) => b !== 'transparent' || value.imageOutputFormat !== 'jpeg')
        .map((b) => ({ value: b, label: b }));
    case 'emotions':
      return (params.emotions ?? []).map((e) => ({ value: e, label: e }));
    case 'audioFormats':
      return (params.audioFormats ?? []).map((f) => ({ value: f, label: f }));
    case 'channels':
      return (params.channels ?? []).map((c) => ({
        value: String(c),
        label: c === 1 ? t('generationParams.channelMono') : t('generationParams.channelStereo'),
      }));
    case 'sampleRates': {
      const rates = ratesForFormat(params.sampleRateByFormat, params.sampleRates, value.audioFormat ?? '')
        ?? params.sampleRates;
      return (rates ?? []).map((s) => ({ value: s, label: `${s} Hz` }));
    }
    case 'bitrates':
      return (params.bitrates ?? []).map((b) => ({ value: String(b), label: `${Math.round(b / 1000)} kbps` }));
    case 'languageBoostOptions':
      return (params.languageBoostOptions ?? []).map((lb) => ({ value: lb, label: lb }));
    case 'voiceIds':
      return (params.voiceIds ?? []).map((v) => ({ value: v.value, label: v.label }));
    case 'voiceModifySoundEffects':
      return (params.voiceModifySoundEffects ?? []).map((s) => ({ value: s.value, label: s.label }));
    default:
      return [];
  }
}

// ─── Dynamic range resolution from CapabilityParams ───

function resolveRangeFromParams(
  rangeFrom: string | undefined,
  params: CapabilityParams,
): { min: number; max: number; step: number } | null {
  if (!rangeFrom) return null;
  const range = (params as Record<string, unknown>)[rangeFrom] as
    | { min: number; max: number; step: number }
    | undefined;
  return range ?? null;
}

export interface RendererProps {
  item: ParamLayoutItem;
  value: GenerationParamsValue;
  onChange: (v: GenerationParamsValue) => void;
  params: CapabilityParams;
  disabled?: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  /** Current language code (e.g. 'zh' / 'en') — used for labelEn selection. */
  lang?: string;
  /** Voice fetcher state (passed from parent). */
  voiceFetcher?: {
    onFetch: () => Promise<Array<{ value: string; label: string }>>;
    fetching: boolean;
    fetchedVoices: Array<{ value: string; label: string }> | null;
    showFetchUnavailableHint?: boolean;
  };
  /** Continuous mode context (for duration slider). */
  continuousMode?: boolean;
  continuousPlan?: number[];
  totalDuration?: number;
}

export function renderParam(props: RendererProps): React.ReactNode {
  const { item } = props;
  const { control } = item;

  switch (control.type) {
    case 'button-group':
      return renderButtonGroup(props);
    case 'toggle-pill-grid':
      return renderTogglePillGrid(props);
    case 'slider':
      return renderSlider(props);
    case 'select':
      return renderSelect(props);
    case 'text-input':
      return renderTextInput(props);
    case 'voice-selector':
      return renderVoiceSelector(props);
    case 'text-input-list':
      return renderTextInputList(props);
    case 'switch-row':
      return renderSwitchRow(props);
    case 'slider-group':
      return renderSliderGroup(props);
    default:
      return null;
  }
}

// ─── Button Group ───

function renderButtonGroup({ item, value, onChange, disabled, params, t }: RendererProps): React.ReactNode {
  const control = item.control as Extract<ParamControl, { type: 'button-group' }>;
  if (!item.label) return null;

  // Resolve options: use optionsFrom if set, otherwise use static options
  const dynamicOptions = control.optionsFrom
    ? resolveOptionsFromParams(control.optionsFrom, params, value, t)
    : undefined;
  const options = dynamicOptions && dynamicOptions.length > 0 ? dynamicOptions : (control.options ?? []);

  const { flexibleWidth, extraWideValue, uppercase, wrap } = control;

  const buttonBase = control.buttonClassName
    ? control.buttonClassName
    : control.buttonSize === 'sm'
      ? 'px-2 py-1.5 text-xs'
      : control.buttonSize === 'md'
        ? 'px-3 py-2 text-sm'
        : 'px-2 py-2 text-sm';

  return (
    <SettingCard label={t(item.label)} icon={resolveParamIcon(item.icon)}>
      <div className={`flex gap-1.5${wrap ? ' flex-wrap' : ''}${flexibleWidth ? ' min-w-0' : ''}`}>
        {options.map((opt) => {
          const val = value[item.valueKey as keyof GenerationParamsValue];
          const valForCompare = val === undefined || val === null ? '' : String(val);
          const isActive = valForCompare === String(opt.value);
          // Check if option label is an i18n key (contains a dot and no spaces)
          const label = (opt.label as string).includes('.') && !(opt.label as string).includes(' ')
            ? t(opt.label as string)
            : opt.label;
          const flexClass = flexibleWidth
            ? (String(opt.value) === extraWideValue ? 'flex-[1.5] min-w-0' : 'flex-1 min-w-0')
            : 'flex-1';
          return (
            <button
              key={String(opt.value)}
              onClick={() => onChange({ ...value, [item.valueKey as string]: opt.value } as GenerationParamsValue)}
              disabled={disabled}
              className={`${flexClass} ${buttonBase} rounded-md transition-colors text-center${flexibleWidth ? ' truncate' : ''}${uppercase ? ' uppercase' : ''} ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </SettingCard>
  );
}

// ─── Toggle Pill Grid ───

function renderTogglePillGrid({ item, value, onChange, disabled, t }: RendererProps): React.ReactNode {
  const control = item.control as Extract<ParamControl, { type: 'toggle-pill-grid' }>;

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {control.toggles.map((toggle) => {
        const toggleVal = value[toggle.key as keyof GenerationParamsValue] as boolean;
        // Use declarative activeDependsOn instead of hardcoded enableMusic logic
        const activeDepKey = toggle.activeDependsOn as keyof GenerationParamsValue | undefined;
        const isActive = activeDepKey
          ? (toggleVal && (value[activeDepKey] as boolean)) as boolean
          : toggleVal;
        const depKey = toggle.disabledWhenOff as keyof GenerationParamsValue | undefined;
        const isDisabled = disabled || (depKey && !(value[depKey] as boolean)) || false;

        return (
          <TogglePill
            key={toggle.key}
            icon={resolveParamIcon(toggleVal ? (toggle.iconOn ?? toggle.icon) : (toggle.iconOff ?? toggle.icon), 14) ?? null}
            label={t(toggle.labelKey)}
            active={isActive}
            onClick={() => {
              const currentVal = value[toggle.key as keyof GenerationParamsValue] as boolean;
              // Generic cascading: when turning OFF a toggle that has cascadesOffTo,
              // also turn off the cascaded target.
              if (currentVal && toggle.cascadesOffTo) {
                const next = { ...value, [toggle.key]: false } as unknown as Record<string, unknown>;
                next[toggle.cascadesOffTo] = false;
                onChange(next as unknown as GenerationParamsValue);
              } else {
                onChange({ ...value, [toggle.key]: !currentVal } as GenerationParamsValue);
              }
            }}
            disabled={isDisabled}
          />
        );
      })}
    </div>
  );
}

// ─── Slider ───

function renderSlider(props: RendererProps): React.ReactNode {
  const { item, value, onChange, disabled, t, params, continuousMode, totalDuration } = props;
  const control = item.control as Extract<ParamControl, { type: 'slider' }>;
  if (!item.label) return null;

  // Resolve range from params if rangeFrom is set
  const range = resolveRangeFromParams(control.rangeFrom, params);
  const min = range ? range.min : (control.min ?? 0);
  const max = range ? range.max : (control.max ?? 100);
  const step = range ? range.step : (control.step ?? 1);

  const val = (value[item.valueKey as keyof GenerationParamsValue] as number) ?? 0;
  const decimals = control.decimals ?? 1;

  // Resolve range labels (i18n keys)
  const rangeLabelMin = control.rangeLabels?.min
    ? (control.rangeLabels.min.includes('.') ? t(control.rangeLabels.min) : control.rangeLabels.min)
    : `${min}${control.rangeLabelUnit ?? ''}`;
  const rangeLabelMax = control.rangeLabels?.max
    ? (control.rangeLabels.max.includes('.') ? t(control.rangeLabels.max) : control.rangeLabels.max)
    : `${max}${control.rangeLabelUnit ?? ''}`;

  // Header toggle rendering
  const headerToggleEl = control.headerToggle ? (() => {
    const toggleKey = control.headerToggle.key as keyof GenerationParamsValue;
    const toggleOn = value[toggleKey] as boolean;
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">{t(control.headerToggle.labelKey)}</span>
        <button
          onClick={() => onChange({ ...value, [toggleKey]: !toggleOn } as GenerationParamsValue)}
          disabled={disabled || (control.disabledInContinuousMode && continuousMode)}
          className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
            toggleOn ? 'bg-blue-600' : 'bg-zinc-700'
          } disabled:opacity-50`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
              toggleOn ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
    );
  })() : undefined;

  // Header toggle state (used by label, hide, and disable logic)
  const headerToggleKey = control.headerToggle?.key as keyof GenerationParamsValue | undefined;
  const headerToggleOn = headerToggleKey ? (value[headerToggleKey] as boolean) : false;

  // Label: use declarative valueInLabel if set (shows current value in the header)
  let label: string;
  if (continuousMode && control.continuousLabelKey) {
    label = t(control.continuousLabelKey, { seconds: Math.ceil((totalDuration ?? 0) / 1000) });
  } else if (control.valueInLabel) {
    // Format the value for display in the label
    let formattedVal: string;
    if (headerToggleOn && control.headerToggle) {
      // When header toggle is on, show the toggle label's value (e.g. "自适应")
      formattedVal = t(control.headerToggle.labelKey);
    } else if (control.valueFormat) {
      formattedVal = control.valueFormat(val);
    } else {
      formattedVal = `${val.toFixed(decimals)}${control.rangeLabelUnit ?? ''}`;
    }
    label = t(control.valueInLabel.formatKey, { value: formattedVal });
  } else {
    label = t(item.label);
  }

  // Check if slider should be hidden when header toggle is on
  const hideSlider = control.hideWhenHeaderToggleOn && headerToggleOn;

  // Use declarative disabledWhenHeaderToggleOn
  const sliderDisabled = disabled
    || (control.disabledInContinuousMode && continuousMode)
    || (control.disabledWhenHeaderToggleOn && headerToggleOn);

  return (
    <SettingCard label={label} icon={resolveParamIcon(item.icon)} extra={headerToggleEl}>
      {!hideSlider && (
        <>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={val}
              onChange={(e) => onChange({ ...value, [item.valueKey as string]: Number(e.target.value) } as GenerationParamsValue)}
              disabled={sliderDisabled}
              className="flex-1 accent-blue-500 disabled:opacity-40"
            />
            <span className="text-xs text-zinc-400 w-10 text-right">
              {control.valueFormat ? control.valueFormat(val) : val.toFixed(decimals)}
            </span>
          </div>
          {control.showRangeLabels && (
            <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
              <span>{rangeLabelMin}</span>
              <span>{rangeLabelMax}</span>
            </div>
          )}
        </>
      )}
    </SettingCard>
  );
}

// ─── Select ───

function renderSelect({ item, value, onChange, disabled, params, t }: RendererProps): React.ReactNode {
  const control = item.control as Extract<ParamControl, { type: 'select' }>;
  if (!item.label) return null;

  // Resolve options from params if optionsFrom is set
  const dynamicOptions = control.optionsFrom
    ? resolveOptionsFromParams(control.optionsFrom, params, value, t)
    : undefined;
  const options = dynamicOptions && dynamicOptions.length > 0 ? dynamicOptions : (control.options ?? []);

  const rawVal = value[item.valueKey as keyof GenerationParamsValue];
  const val = rawVal !== undefined && rawVal !== null ? String(rawVal) : '';

  return (
    <SettingCard label={t(item.label)} icon={resolveParamIcon(item.icon)}>
      <Select
        value={val}
        onChange={(e) => {
          const raw = e.target.value;
          const typedVal = typeof rawVal === 'number' ? Number(raw) : raw;
          onChange({ ...value, [item.valueKey as string]: typedVal } as GenerationParamsValue);
        }}
        options={options.map((o) => ({ value: String(o.value), label: o.label }))}
        disabled={disabled}
        placeholder={control.placeholder ? t(control.placeholder) : t(item.label)}
      />
    </SettingCard>
  );
}

// ─── Text Input (single-line free text, e.g. SeedAudio speaker voice ID) ───

function renderTextInput({ item, value, onChange, disabled, t }: RendererProps): React.ReactNode {
  const control = item.control as Extract<ParamControl, { type: 'text-input' }>;
  if (!item.label) return null;

  const rawVal = value[item.valueKey as keyof GenerationParamsValue];
  const val = rawVal !== undefined && rawVal !== null ? String(rawVal) : '';

  return (
    <SettingCard label={t(item.label)} icon={resolveParamIcon(item.icon)}>
      <input
        type={control.inputType ?? 'text'}
        value={val}
        maxLength={control.maxLength}
        placeholder={control.placeholder ? t(control.placeholder) : undefined}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, [item.valueKey as string]: e.target.value } as GenerationParamsValue)}
        className="w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </SettingCard>
  );
}

// ─── Voice Selector (composite) ───

function renderVoiceSelector(props: RendererProps): React.ReactNode {
  const { item, value, onChange, disabled, t, lang, voiceFetcher, params } = props;
  if (!item.label) return null;

  const control = item.control as Extract<ParamControl, { type: 'voice-selector' }>;
  const val = value.voiceId ?? '';
  const isEnglish = lang?.startsWith('en') ?? false;

  // Resolve options from params if optionsFrom is set
  let baseOptions: Array<{ value: string; label: string; labelEn?: string }> = control.options ?? [];
  if (control.optionsFrom === 'voiceIds' && params.voiceIds) {
    baseOptions = params.voiceIds;
  }

  type VoiceOpt = { value: string; label: string };
  const map = new Map<string, VoiceOpt>();
  for (const v of baseOptions) {
    const displayLabel = isEnglish && v.labelEn ? v.labelEn : v.label;
    map.set(v.value, { value: v.value, label: displayLabel });
  }
  for (const v of voiceFetcher?.fetchedVoices ?? []) map.set(v.value, v);
  if (val && !map.has(val)) map.set(val, { value: val, label: val });
  const mergedOptions = Array.from(map.values());

  const canFetch = control.showFetchButton && !!voiceFetcher?.onFetch && !voiceFetcher?.fetching;
  const isFetching = !!voiceFetcher?.fetching;
  const showFetchUnavailable = control.showFetchUnavailableHint || !voiceFetcher?.onFetch;

  return (
    <SettingCard label={t(item.label)} icon={resolveParamIcon(item.icon)}>
      <div className="flex gap-1.5">
        <Select
          value={val}
          onChange={(e) => onChange({ ...value, voiceId: e.target.value })}
          options={mergedOptions}
          disabled={disabled}
          placeholder={t('generationParams.voiceId')}
        />
        {control.showFetchButton && (
          <button
            onClick={voiceFetcher?.onFetch}
            disabled={disabled || !canFetch}
            title={isFetching ? t('common.validating') : t('generationParams.fetchVoices')}
            className={`shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-700 transition-colors ${
              isFetching
                ? 'bg-zinc-800 text-zinc-500'
                : canFetch
                  ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white'
                  : 'bg-zinc-800/50 text-zinc-600'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isFetching ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <RefreshCw size={15} />
            )}
          </button>
        )}
      </div>
      {showFetchUnavailable && !voiceFetcher?.onFetch && (
        <p className="text-[10px] text-zinc-500 mt-1.5">{t('generationParams.voiceFetchUnavailable')}</p>
      )}
    </SettingCard>
  );
}

// ─── Text Input List ───

function renderTextInputList({ item, value, onChange, disabled, t }: RendererProps): React.ReactNode {
  const control = item.control as Extract<ParamControl, { type: 'text-input-list' }>;
  if (!item.label) return null;

  const arr = (value[item.valueKey as keyof GenerationParamsValue] as string[]) ?? [];

  return (
    <SettingCard label={t(item.label)} icon={resolveParamIcon(item.icon)}>
      <div className="space-y-2">
        {arr.map((rule: string, idx: number) => (
          <div key={idx} className="flex items-center gap-1.5">
            <input
              type="text"
              value={rule}
              onChange={(e) => {
                const next = [...arr];
                next[idx] = e.target.value;
                onChange({ ...value, [item.valueKey as string]: next } as GenerationParamsValue);
              }}
              placeholder={control.placeholder ? t(control.placeholder) : undefined}
              disabled={disabled}
              className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={() => {
                const next = arr.filter((_: string, i: number) => i !== idx);
                onChange({ ...value, [item.valueKey as string]: next } as GenerationParamsValue);
              }}
              disabled={disabled}
              className="shrink-0 p-1 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40"
              title={t('common.delete')}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          onClick={() => {
            const next = [...arr, ''];
            onChange({ ...value, [item.valueKey as string]: next } as GenerationParamsValue);
          }}
          disabled={disabled}
          className="w-full"
        >
          <Plus size={14} className="mr-1" />
          {t(control.addLabel)}
        </Button>
      </div>
    </SettingCard>
  );
}

// ─── Switch Row ───

function renderSwitchRow({ item, value, onChange, disabled }: RendererProps): React.ReactNode {
  const control = item.control as Extract<ParamControl, { type: 'switch-row' }>;

  return (
    <div className="space-y-2">
      {control.switches.map((sw) => {
        const rawVal = value[sw.key as keyof GenerationParamsValue];
        const isOn = sw.onValue !== undefined
          ? rawVal === sw.onValue
          : Boolean(rawVal);
        return (
          <div key={sw.key} className="flex items-center justify-between bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-3 py-2.5">
            <span className="text-sm text-zinc-300">{sw.label}</span>
            <button
              onClick={() => {
                let nextVal: unknown;
                if (isOn) {
                  nextVal = sw.offValue !== undefined ? sw.offValue : (sw.onValue !== undefined ? '' : false);
                } else {
                  nextVal = sw.onValue !== undefined ? sw.onValue : true;
                }
                onChange({ ...value, [sw.key]: nextVal } as GenerationParamsValue);
              }}
              disabled={disabled}
              className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
                isOn ? 'bg-blue-600' : 'bg-zinc-700'
              } disabled:opacity-50`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                  isOn ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Slider Group (voice_modify style) ───

function renderSliderGroup({ item, value, onChange, disabled, t, params }: RendererProps): React.ReactNode {
  const control = item.control as Extract<ParamControl, { type: 'slider-group' }>;
  if (!item.label) return null;

  // Resolve trailing select options from params if needed
  let trailingOptions = control.trailingSelect?.options ?? [];
  if (control.trailingSelect?.optionsFrom) {
    const dynamic = resolveOptionsFromParams(control.trailingSelect.optionsFrom, params, value, t);
    if (dynamic.length > 0) trailingOptions = dynamic;
  }

  /** Translate a label string if it looks like an i18n key (contains dot, no spaces). */
  const translateIfKey = (s: string) =>
    s.includes('.') && !s.includes(' ') ? t(s) : s;

  return (
    <SettingCard label={t(item.label)} icon={resolveParamIcon(control.icon)}>
      <div className="space-y-3">
        {control.sliders.map((s) => {
          // Resolve range from params if rangeFrom is set
          const range = resolveRangeFromParams(s.rangeFrom, params);
          const min = range ? range.min : s.min;
          const max = range ? range.max : s.max;
          const step = range ? range.step : s.step;

          const val = (value[s.key as keyof GenerationParamsValue] as number) ?? 0;
          const decimals = s.decimals ?? 0;

          // Resolve range labels (translate if i18n keys)
          const rangeLabelMin = s.rangeLabels?.min
            ? translateIfKey(s.rangeLabels.min)
            : `${min}`;
          const rangeLabelMax = s.rangeLabels?.max
            ? translateIfKey(s.rangeLabels.max)
            : `${max}`;

          return (
            <div key={s.key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-400">{translateIfKey(s.label)}</span>
                <span className="text-xs text-zinc-400 w-8 text-right">{val.toFixed(decimals)}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={val}
                onChange={(e) => onChange({ ...value, [s.key]: Number(e.target.value) } as GenerationParamsValue)}
                disabled={disabled}
                className="w-full accent-blue-500 disabled:opacity-40"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                <span>{rangeLabelMin}</span>
                <span>{rangeLabelMax}</span>
              </div>
            </div>
          );
        })}
        {control.trailingSelect && (() => {
          const ts = control.trailingSelect!;
          return (
            <div>
              <div className="text-xs text-zinc-400 mb-1">{translateIfKey(ts.label)}</div>
              <Select
                value={(value[ts.key as keyof GenerationParamsValue] as string) ?? ''}
                onChange={(e) => onChange({ ...value, [ts.key]: e.target.value || undefined } as GenerationParamsValue)}
                options={ts.includeNone
                  ? [{ value: '', label: t('common.none') }, ...trailingOptions.map((o) => ({ value: String(o.value), label: o.label }))]
                  : trailingOptions.map((o) => ({ value: String(o.value), label: o.label }))
                }
                disabled={disabled}
                placeholder={ts.placeholder ? t(ts.placeholder) : undefined}
              />
            </div>
          );
        })()}
      </div>
    </SettingCard>
  );
}
