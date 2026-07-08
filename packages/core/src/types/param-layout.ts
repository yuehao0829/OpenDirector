/**
 * Declarative parameter layout types — provider-defined, no React dependency.
 *
 * Providers declare their parameter layout as a ParamLayoutItem[]. The array
 * order determines display order. The UI renderer maps icon names to Lucide
 * components and renders the appropriate control.
 */

import type { CapabilityParams } from './provider-system';

// ─── Value type ───

/** Generic parameter value map — replaces GenerationParamsValue for provider-side use. */
export type ParamValueMap = Record<string, unknown>;

// ─── Declarative Visibility Condition DSL ───

/**
 * A declarative condition for visibleWhen / disabledWhen.
 * Evaluated against CapabilityParams and the current ParamValueMap.
 */
export type VisibleWhenCondition =
  /** Check if a field on params exists (is not undefined). */
  | { paramsField: string; op: 'exists' | 'notExists' }
  /** Check if a field on params is truthy / falsy (arrays: length > 0). */
  | { paramsField: string; op: 'truthy' | 'falsy' }
  /** Check if a field on params equals / doesn't equal a value. */
  | { paramsField: string; op: 'equals' | 'notEquals'; value: unknown }
  /** Check if a field on value (current param state) equals / doesn't equal a value. */
  | { valueField: string; op: 'equals' | 'notEquals'; value: unknown }
  /** Check if a field's value is contained in a given list (e.g. audioFormat in ['mp3','wav','flac']). */
  | { valueField: string; op: 'in'; value: unknown[] }
  /** Check if a field on params is contained in a given list. */
  | { paramsField: string; op: 'in'; value: unknown[] }
  /** Check if a field on value is truthy / falsy. */
  | { valueField: string; op: 'truthy' | 'falsy' }
  /** Logical NOT of a nested condition. */
  | { not: VisibleWhenCondition }
  /** All sub-conditions must be true (logical AND). */
  | { all: VisibleWhenCondition[] }
  /** At least one sub-condition must be true (logical OR). */
  | { any: VisibleWhenCondition[] };

/** Evaluate a declarative VisibleWhenCondition against params and value. */
export function evaluateCondition(
  cond: VisibleWhenCondition,
  params: CapabilityParams,
  value: ParamValueMap,
): boolean {
  if ('not' in cond) {
    return !evaluateCondition(cond.not, params, value);
  }
  if ('all' in cond) {
    return cond.all.every((c) => evaluateCondition(c, params, value));
  }
  if ('any' in cond) {
    return cond.any.some((c) => evaluateCondition(c, params, value));
  }

  // Single-field condition
  const source = 'paramsField' in cond ? 'params' : 'value';
  const field = 'paramsField' in cond ? cond.paramsField : cond.valueField;
  const op = cond.op;
  const sourceObj = source === 'params' ? params : value;
  const fieldVal = (sourceObj as Record<string, unknown>)[field];

  switch (op) {
    case 'exists':
      return fieldVal !== undefined;
    case 'notExists':
      return fieldVal === undefined;
    case 'truthy':
      if (Array.isArray(fieldVal)) return fieldVal.length > 0;
      return !!fieldVal;
    case 'falsy':
      if (Array.isArray(fieldVal)) return fieldVal.length === 0;
      return !fieldVal;
    case 'equals':
      return fieldVal === (cond as { value: unknown }).value;
    case 'notEquals':
      return fieldVal !== (cond as { value: unknown }).value;
    case 'in': {
      const list = (cond as { value: unknown[] }).value;
      return Array.isArray(list) && list.includes(fieldVal);
    }
    default:
      return true;
  }
}

/** Evaluate a visibleWhen that may be declarative or a function. */
export function resolveVisibleWhen(
  condition: VisibleWhenCondition | ((params: CapabilityParams, value: ParamValueMap) => boolean) | undefined,
  params: CapabilityParams,
  value: ParamValueMap,
): boolean {
  if (!condition) return true;
  if (typeof condition === 'function') return condition(params, value);
  return evaluateCondition(condition, params, value);
}

// ─── Shared summaryFormat helpers ───

/** `String(value)` — the most common summaryFormat. */
export function formatAsString(v: unknown): string {
  return String(v);
}

/** `String(value).toUpperCase()` — for enum-like values displayed uppercase (e.g. MP3, JPEG). */
export function formatAsUpperCase(v: unknown): string {
  return String(v).toUpperCase();
}

// ─── Control type definitions ───

export interface ButtonGroupControl {
  type: 'button-group';
  /** Static options. When optionsFrom is set, these serve as fallback. */
  options?: Array<{ value: string | number; label: string }>;
  /**
   * If set, options are dynamically read from this CapabilityParams field.
   * E.g. 'aspectRatios' → reads params.aspectRatios.
   */
  optionsFrom?: string;
  /** When true, buttons get flex-1 min-w-0 (aspect-ratio style). Default: equal flex. */
  flexibleWidth?: boolean;
  /** Value that gets flex-[1.5] (e.g. 'adaptive' in aspect ratios). */
  extraWideValue?: string;
  /** When true, labels get uppercase class. */
  uppercase?: boolean;
  /** When true, buttons get flex-wrap (emotion style). Default: single row. */
  wrap?: boolean;
  /** Explicit button padding+text class (e.g. "px-1 py-2 text-sm"). Overrides buttonSize. */
  buttonClassName?: string;
  /** Button size preset: 'sm' = px-2 py-1.5 text-xs (emotion), 'md' = px-3 py-2 text-sm (resolution). */
  buttonSize?: 'sm' | 'md';
  /** When true, clicking the currently active button deselects it (value set to undefined). */
  allowDeselect?: boolean;
}

export interface TogglePillGridControl {
  type: 'toggle-pill-grid';
  /** Each toggle's definition. */
  toggles: Array<{
    key: string;
    /** Icon name (e.g. 'volume-2', 'music'). Mapped to Lucide component at render time. */
    icon: string;
    /** Icon name when toggle is ON. Overrides 'icon' for the on state. */
    iconOn?: string;
    /** Icon name when toggle is OFF. Overrides 'icon' for the off state. */
    iconOff?: string;
    labelKey: string;
    /** If set, this toggle is disabled when the referenced key is falsy. */
    disabledWhenOff?: string;
    /** If set, turning this off also turns off the referenced key. */
    cascadesOffTo?: string;
    /**
     * If set, the visual "active" state of this toggle also requires
     * the referenced key to be truthy. E.g. enableMusic active state
     * depends on enableAudio being on.
     */
    activeDependsOn?: string;
  }>;
}

export interface SliderControl {
  type: 'slider';
  /** Static min value. When rangeFrom is set, this serves as fallback. */
  min?: number;
  /** Static max value. When rangeFrom is set, this serves as fallback. */
  max?: number;
  /** Static step value. When rangeFrom is set, this serves as fallback. */
  step?: number;
  /**
   * If set, min/max/step are dynamically read from this CapabilityParams field.
   * E.g. 'durationRange' → reads params.durationRange.{min,max,step}.
   */
  rangeFrom?: string;
  /** Format the value display (e.g. "1.0x" for speed, "5s" for duration). */
  valueFormat?: (v: number) => string;
  /** Show min/max labels below the slider (duration style). */
  showRangeLabels?: boolean;
  /** Unit for range labels (e.g. "s"). */
  rangeLabelUnit?: string;
  /** Custom labels for slider extremes (e.g. "低沉" / "明亮"). Overrides numeric labels. */
  rangeLabels?: { min: string; max: string };
  /** Decimal places for value display. Default: 1. */
  decimals?: number;
  /**
   * Tick marks displayed below the slider. Each mark has a value and an optional label.
   * When labels are omitted, the numeric value is shown.
   */
  marks?: Array<{ value: number; label?: string }>;
  /**
   * Declarative header toggle config (e.g. autoDuration).
   * When set, the renderer renders a toggle button in the SettingCard header
   * that controls the specified value key.
   */
  headerToggle?: {
    /** The value key controlled by this toggle (e.g. 'autoDuration'). */
    key: string;
    /** i18n key for the toggle label (e.g. 'generationParams.adaptive'). */
    labelKey: string;
  };
  /**
   * When true, the slider is hidden when the headerToggle is on.
   * Used for duration + autoDuration: when adaptive is enabled, slider disappears.
   */
  hideWhenHeaderToggleOn?: boolean;
  /**
   * When true, the slider is disabled in continuousMode.
   * Used for duration slider.
   */
  disabledInContinuousMode?: boolean;
  /**
   * Label template for continuous mode. Receives totalDuration from context.
   * If set, used instead of item.label when continuousMode is active.
   * The renderer will call t(labelKey, { seconds }).
   */
  continuousLabelKey?: string;
  /**
   * When true, the slider is disabled when the headerToggle is ON
   * (not just hidden). Used alongside hideWhenHeaderToggleOn for
   * duration + autoDuration.
   */
  disabledWhenHeaderToggleOn?: boolean;
  /**
   * When set, the SettingCard label includes the current formatted value.
   * formatKey is an i18n key that accepts a { value } interpolation param.
   * E.g. { formatKey: 'generationParams.duration' } → "时长：5s"
   */
  valueInLabel?: { formatKey: string };
}

export interface SelectControl {
  type: 'select';
  /** Static options. When optionsFrom is set, these serve as fallback. */
  options?: Array<{ value: string; label: string }>;
  /**
   * If set, options are dynamically read from this CapabilityParams field.
   * E.g. 'bitrates' → reads params.bitrates, formats as "X kbps".
   * The renderer handles known fields: bitrates, channels, sampleRates, etc.
   */
  optionsFrom?: string;
  placeholder?: string;
  /** When true, allows selecting multiple options. Value becomes a string[]. */
  multiple?: boolean;
  /** Maximum number of selections when multiple is true. */
  maxSelected?: number;
}

export interface VoiceSelectorControl {
  type: 'voice-selector';
  /** Static options. When optionsFrom is set, these serve as fallback. */
  options?: Array<{ value: string; label: string; labelEn?: string }>;
  /**
   * If set, options are dynamically read from this CapabilityParams field.
   * E.g. 'voiceIds' → reads params.voiceIds.
   */
  optionsFrom?: string;
  showFetchButton?: boolean;
  showFetchUnavailableHint?: boolean;
}

export interface TextInputListControl {
  type: 'text-input-list';
  placeholder?: string;
  addLabel: string;
}

export interface SwitchRowControl {
  type: 'switch-row';
  switches: Array<{
    key: string;
    label: string;
    /** When set, the switch is "on" when value === onValue (instead of truthy). */
    onValue?: string | number | boolean;
    /** Value to set when the switch is turned off. */
    offValue?: string | number | boolean;
  }>;
}

export interface SliderGroupControl {
  type: 'slider-group';
  /** Icon name (mapped to Lucide at render time). */
  icon?: string;
  sliders: Array<{
    key: string;
    label: string;
    min: number;
    max: number;
    step: number;
    decimals?: number;
    /**
     * If set, min/max/step are dynamically read from this CapabilityParams field.
     * E.g. 'voiceModifyPitchRange' → reads params.voiceModifyPitchRange.{min,max,step}.
     */
    rangeFrom?: string;
    /** Format the value display (e.g. "1.0x" for speed). */
    valueFormat?: (v: number) => string;
    /** Custom labels for slider extremes. Overrides numeric labels. */
    rangeLabels?: { min: string; max: string };
  }>;
  /** Optional select rendered after the sliders (e.g. sound effects). */
  trailingSelect?: {
    key: string;
    label: string;
    options: Array<{ value: string; label: string }>;
    /** If set, options are dynamically read from this CapabilityParams field. */
    optionsFrom?: string;
    placeholder?: string;
    /** Include a "none" option with empty value. */
    includeNone?: boolean;
  };
}

// ─── New control types ───

/** Single-line text input (e.g. seed value, style keyword). */
export interface TextInputControl {
  type: 'text-input';
  placeholder?: string;
  /** Maximum character length. */
  maxLength?: number;
  /** When true, the input is cleared on submit (one-shot entry like a seed). */
  clearOnSubmit?: boolean;
  /** Input type attribute — 'text' (default), 'password', 'email', 'url', 'search'. */
  inputType?: 'text' | 'password' | 'email' | 'url' | 'search';
}

/** Multi-line text area (e.g. negative prompt, style description). */
export interface TextAreaControl {
  type: 'text-area';
  placeholder?: string;
  /** Maximum character length. */
  maxLength?: number;
  /** Number of visible text rows. Default: 3. */
  rows?: number;
  /** When true, shows a character count below the textarea. */
  showCharCount?: boolean;
  /** When true, auto-resizes to fit content up to maxRows. */
  autoResize?: boolean;
  /** Maximum rows when autoResize is true. Default: 8. */
  maxRows?: number;
}

/** Numeric input with optional min/max/step (e.g. seed, CFG scale). */
export interface NumberInputControl {
  type: 'number-input';
  min?: number;
  max?: number;
  step?: number;
  /**
   * If set, min/max/step are dynamically read from this CapabilityParams field.
   * E.g. 'cfgScaleRange' → reads params.cfgScaleRange.{min,max,step}.
   */
  rangeFrom?: string;
  /** Placeholder text shown when value is empty. */
  placeholder?: string;
  /** When true, shows increment/decrement buttons on the side. */
  showStepper?: boolean;
  /** Unit label displayed after the input (e.g. "px", "%"). */
  unit?: string;
  /** Decimal places for display. Default: 0 (integer). */
  decimals?: number;
}

/** Numeric stepper with +/- buttons (e.g. frame count, iteration count). */
export interface StepperControl {
  type: 'stepper';
  min: number;
  max: number;
  step: number;
  /**
   * If set, min/max/step are dynamically read from this CapabilityParams field.
   */
  rangeFrom?: string;
  /** Unit label displayed after the value (e.g. "fps", "frames"). */
  unit?: string;
  /** When true, value wraps around at min/max boundaries. */
  wrap?: boolean;
}

/** Single checkbox with label (simpler than switch-row for standalone booleans). */
export interface CheckboxControl {
  type: 'checkbox';
  /** Checkbox label text (i18n key or plain text). */
  label: string;
  /** Optional description shown below the label. */
  description?: string;
  /** When set, the checkbox is checked when value === checkedValue (instead of truthy). */
  checkedValue?: string | number | boolean;
  /** Value to set when the checkbox is unchecked. */
  uncheckedValue?: string | number | boolean;
  /** When true, renders as an indeterminate tri-state checkbox. */
  triState?: boolean;
}

/** Color picker (e.g. background color, brand color). */
export interface ColorPickerControl {
  type: 'color-picker';
  /**
   * Preset color swatches displayed below the picker.
   * Each entry has a value (hex color) and optional label.
   */
  presets?: Array<{ value: string; label?: string }>;
  /** When true, allows custom color input (not just presets). Default: true. */
  allowCustom?: boolean;
  /** When true, shows alpha/opacity slider. Default: false. */
  showAlpha?: boolean;
  /** Placeholder text when no color is selected. */
  placeholder?: string;
}

/**
 * Non-interactive informational banner (e.g. continuous mode notice,
 * API quota warning). Replaces hardcoded banners in the inspector.
 */
export interface InfoBannerControl {
  type: 'info-banner';
  /** Banner variant — determines color and icon. */
  variant: 'info' | 'warning' | 'error' | 'success';
  /** i18n key for the banner title (bold first line). */
  titleKey: string;
  /** i18n key for the banner body (second line, optional). */
  bodyKey?: string;
  /**
   * When set, the banner is only shown when this condition returns true.
   * Accepts a declarative VisibleWhenCondition or a function.
   */
  showWhen?: VisibleWhenCondition | ((params: CapabilityParams, value: ParamValueMap) => boolean);
  /** When true, the banner can be dismissed (hidden after user clicks X). */
  dismissible?: boolean;
}

/** Visual divider / section separator. */
export interface DividerControl {
  type: 'divider';
  /** Optional label displayed inline with the divider (e.g. "Advanced"). */
  label?: string;
  /** Divider style. Default: 'line'. */
  style?: 'line' | 'spaced' | 'dashed';
}

/** Dual-thumb range slider for selecting a min-max pair (e.g. duration range). */
export interface RangeSliderControl {
  type: 'range-slider';
  min: number;
  max: number;
  step: number;
  /**
   * If set, min/max/step are dynamically read from this CapabilityParams field.
   */
  rangeFrom?: string;
  /** Key for the min value in the value map. */
  minKey: string;
  /** Key for the max value in the value map. */
  maxKey: string;
  /** Unit for value display (e.g. "s", "px"). */
  unit?: string;
  /** Show min/max labels below the slider. */
  showRangeLabels?: boolean;
  /** Decimal places for value display. Default: 0. */
  decimals?: number;
}

/** Token / usage counter display (read-only, e.g. prompt token count). */
export interface TokenDisplayControl {
  type: 'token-display';
  /** Key for the current count value in the value map. */
  countKey: string;
  /** Key for the max/limit value in the value map. If set, shows progress bar. */
  limitKey?: string;
  /** Unit label (e.g. "tokens", "chars"). */
  unit: string;
  /** i18n key for the label displayed above the counter. */
  labelKey?: string;
  /** When true, shows a progress bar (requires limitKey). */
  showProgress?: boolean;
  /** Variant for the progress bar when limit is exceeded. */
  overLimitVariant?: 'warning' | 'error';
}

export type ParamControl =
  | ButtonGroupControl
  | TogglePillGridControl
  | SliderControl
  | SelectControl
  | VoiceSelectorControl
  | TextInputListControl
  | SwitchRowControl
  | SliderGroupControl
  | TextInputControl
  | TextAreaControl
  | NumberInputControl
  | StepperControl
  | CheckboxControl
  | ColorPickerControl
  | InfoBannerControl
  | DividerControl
  | RangeSliderControl
  | TokenDisplayControl;

// ─── Layout item ───

export interface ParamLayoutItem {
  /** Unique key for React rendering. */
  id: string;
  /** SettingCard label. Omit for standalone controls (toggle grid, banner, divider). */
  label?: string;
  /** Icon name for the SettingCard header (e.g. 'mic', 'sliders'). Mapped to Lucide. */
  icon?: string;
  /** The actual control to render. */
  control: ParamControl;
  /**
   * When true, this parameter is grouped under the collapsible
   * "Advanced options" section instead of the main parameter list.
   */
  advanced?: boolean;
  /**
   * When set, items sharing the same row value are rendered side by side
   * in a horizontal flex row (e.g. sampleRate + bitrate).
   */
  row?: string;
  /**
   * Condition for showing this parameter. Can be a declarative VisibleWhenCondition
   * or a function receiving CapabilityParams and the current value map.
   * Returns true to show.
   */
  visibleWhen: VisibleWhenCondition | ((params: CapabilityParams, value: ParamValueMap) => boolean);
  /**
   * The value key this parameter controls (for onChange wiring).
   * For composite controls (toggle-pill-grid, slider-group), use the
   * individual item keys instead.
   */
  valueKey?: string;
  /**
   * Declarative side-effect: when this parameter's value changes,
   * call this function to adjust other parameters in the value object.
   * Returns the full adjusted value.
   */
  adjustOnChange?: (newValue: ParamValueMap) => ParamValueMap;
  /**
   * When false, this parameter is excluded from the summary bar.
   * Default: true (shown in summary).
   */
  showInSummary?: boolean;
  /**
   * Icon name for the summary bar entry. If not set, uses item.icon.
   */
  summaryIcon?: string;
  /**
   * Custom summary label template. If not set, the value is displayed raw.
   * The renderer will call t(summaryLabelKey) if set.
   */
  summaryLabelKey?: string;
  /**
   * Custom formatter for the summary bar value display.
   * Receives the current value, the resolved CapabilityParams, and context.
   * Return a string to display, or null to skip this entry from the summary.
   * If not set, String(value) is used.
   */
  summaryFormat?: (
    value: unknown,
    params: CapabilityParams,
    ctx: {
      continuousMode?: boolean;
      totalDuration?: number;
      t: (key: string, options?: Record<string, unknown>) => string;
      lang?: string;
      fetchedVoices?: Array<{ value: string; label: string }>;
      allValues: ParamValueMap;
    },
  ) => string | null;
  /**
   * Help text / description displayed below the control label or as a tooltip.
   * Supports i18n keys (strings containing a dot are passed through t()).
   */
  description?: string;
  /**
   * Condition for disabling this parameter. Can be a declarative VisibleWhenCondition
   * or a function receiving CapabilityParams and the current value map.
   * Returns true to disable. When set, takes precedence over the global `disabled` prop.
   */
  disabledWhen?: VisibleWhenCondition | ((params: CapabilityParams, value: ParamValueMap) => boolean);
  /**
   * When true, this item is rendered without a SettingCard wrapper
   * (full-bleed, no border / no padding). Useful for banners and dividers.
   */
  noCard?: boolean;
}
