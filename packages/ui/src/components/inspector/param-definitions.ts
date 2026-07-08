/**
 * Backward-compatibility re-exports.
 *
 * The canonical type definitions now live in @opendirector/core/types/param-layout.
 * This file re-exports them so existing imports continue to work.
 */

export type {
  ParamLayoutItem,
  ParamControl,
  ParamValueMap,
  VisibleWhenCondition,
  ButtonGroupControl,
  TogglePillGridControl,
  SliderControl,
  SelectControl,
  VoiceSelectorControl,
  TextInputListControl,
  SwitchRowControl,
  SliderGroupControl,
  TextInputControl,
  TextAreaControl,
  NumberInputControl,
  StepperControl,
  CheckboxControl,
  ColorPickerControl,
  InfoBannerControl,
  DividerControl,
  RangeSliderControl,
  TokenDisplayControl,
} from '@opendirector/core/types/param-layout';

export { evaluateCondition, resolveVisibleWhen } from '@opendirector/core/types/param-layout';
