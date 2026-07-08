/**
 * Shared icon name → Lucide component mapping for parameter inspector.
 * Both ParamRenderer (control rendering) and GenerationParamsSection
 * (SummaryBar) use this to resolve string icon names to React elements.
 *
 * To add a new icon: import it from lucide-react and add it here.
 */

import {
  Mic, Sliders, Monitor, RectangleHorizontal, Clock,
  Volume2, VolumeX, Music, Music4, Subtitles, Stamp, Languages,
} from 'lucide-react';
import { createElement, type ReactNode } from 'react';

type IconComponentType = React.ComponentType<{ size?: number | string; className?: string }>;

const ICON_MAP: Record<string, IconComponentType> = {
  'mic': Mic,
  'sliders': Sliders,
  'monitor': Monitor,
  'rectangle-horizontal': RectangleHorizontal,
  'clock': Clock,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  'music': Music,
  'music-off': Music4,
  'subtitles': Subtitles,
  'stamp': Stamp,
  'languages': Languages,
};

/** Resolve an icon name (string) to a Lucide ReactNode. Returns undefined for unknown names. */
export function resolveParamIcon(iconName: string | undefined, size = 15): ReactNode {
  if (!iconName) return undefined;
  const Component = ICON_MAP[iconName];
  if (!Component) return undefined;
  return createElement(Component, { size });
}
