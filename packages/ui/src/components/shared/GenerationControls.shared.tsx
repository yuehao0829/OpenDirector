import type { ReactNode } from 'react';
import { Music, Stamp, Subtitles, Volume2 } from 'lucide-react';

export type ToggleKey = 'enableAudio' | 'enableMusic' | 'enableSubtitle' | 'enableWatermark';

export interface ToggleDefinition {
  key: ToggleKey;
  icon: ReactNode;
  label: string;
}

export const TOGGLE_DEFS: ToggleDefinition[] = [
  { key: 'enableAudio', icon: <Volume2 size={14} />, label: '音频' },
  { key: 'enableMusic', icon: <Music size={14} />, label: '音乐' },
  { key: 'enableSubtitle', icon: <Subtitles size={14} />, label: '字幕' },
  { key: 'enableWatermark', icon: <Stamp size={14} />, label: '水印' },
];
