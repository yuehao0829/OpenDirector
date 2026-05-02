import { Volume2, Music, Subtitles, Stamp } from 'lucide-react';

export type ToggleKey = 'enableAudio' | 'enableMusic' | 'enableSubtitle' | 'enableWatermark';

export const TOGGLE_DEFS: { key: ToggleKey; icon: React.ReactNode; label: string }[] = [
  { key: 'enableAudio', icon: <Volume2 size={14} />, label: '音频' },
  { key: 'enableMusic', icon: <Music size={14} />, label: '音乐' },
  { key: 'enableSubtitle', icon: <Subtitles size={14} />, label: '字幕' },
  { key: 'enableWatermark', icon: <Stamp size={14} />, label: '水印' },
];

export function TogglePill({
  icon,
  label,
  active,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-md transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-700'
      } disabled:opacity-50`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function SettingCard({
  label,
  icon,
  extra,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {icon && <span className="text-zinc-400">{icon}</span>}
          <label className="text-sm text-zinc-300 font-medium">{label}</label>
        </div>
        {extra}
      </div>
      {children}
    </div>
  );
}
