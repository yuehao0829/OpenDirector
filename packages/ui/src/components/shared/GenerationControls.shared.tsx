import type { ReactNode } from 'react';
import { Music, Stamp, Subtitles, Volume2 } from 'lucide-react';

export type ToggleKey = 'enableAudio' | 'enableMusic' | 'enableSubtitle' | 'enableWatermark';

export interface ToggleDefinition {
  key: ToggleKey;
  icon: ReactNode;
  labelKey: string;
}

export const TOGGLE_DEFS: ToggleDefinition[] = [
  { key: 'enableAudio', icon: <Volume2 size={14} />, labelKey: 'generation.toggle.audio' },
  { key: 'enableMusic', icon: <Music size={14} />, labelKey: 'generation.toggle.music' },
  { key: 'enableSubtitle', icon: <Subtitles size={14} />, labelKey: 'generation.toggle.subtitle' },
  { key: 'enableWatermark', icon: <Stamp size={14} />, labelKey: 'generation.toggle.watermark' },
];
