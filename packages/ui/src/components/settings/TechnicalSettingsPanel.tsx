import { changeI18nLanguage } from '@opendirector/core/i18n';
import type { AppLanguage } from '@opendirector/core/i18n';
import { useSettingsStore } from '@opendirector/core/stores/settingsStore';
import { useProjectStore } from '@opendirector/core/stores/projectStore';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; labelKey: string }> = [
  { value: 'zh-CN', labelKey: 'settings.technical.chinese' },
  { value: 'en-US', labelKey: 'settings.technical.english' },
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];

export function TechnicalSettingsPanel() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setDefaultFps = useSettingsStore((s) => s.setDefaultFps);
  const currentFps = useProjectStore((s) => s.currentProject?.settings.fps);
  const updateProjectSettings = useProjectStore((s) => s.updateProjectSettings);
  const hasProject = useProjectStore((s) => !!s.currentProject);

  const handleLanguageChange = (nextLanguage: AppLanguage) => {
    if (nextLanguage === language) return;
    setLanguage(nextLanguage);
    void changeI18nLanguage(nextLanguage);
  };

  const handleFpsChange = (fps: number) => {
    if (fps === currentFps) return;
    updateProjectSettings({ fps });
    setDefaultFps(fps);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium text-zinc-200 mb-1">{t('settings.technical.title')}</h2>

      <div className="flex items-center justify-between gap-4">
        <label className="text-sm font-medium text-zinc-300">{t('settings.technical.language')}</label>
        <div className="inline-grid grid-cols-2 rounded-lg bg-zinc-800 p-0.5">
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleLanguageChange(option.value)}
              className={`w-20 px-3 py-1.5 text-sm rounded-md transition-colors ${
                language === option.value
                  ? 'bg-blue-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <label className="text-sm font-medium text-zinc-300">{t('settings.technical.framerate')}</label>
        <div className="inline-grid grid-cols-5 rounded-lg bg-zinc-800 p-0.5">
          {FPS_OPTIONS.map((fps) => (
            <button
              key={fps}
              type="button"
              disabled={!hasProject}
              onClick={() => handleFpsChange(fps)}
              className={clsx(
                'w-14 px-2 py-1.5 text-sm rounded-md transition-colors',
                currentFps === fps && 'bg-blue-600 text-white',
                currentFps !== fps && hasProject && 'text-zinc-400 hover:text-zinc-200',
                currentFps !== fps && !hasProject && 'text-zinc-600 cursor-not-allowed',
              )}
            >
              {fps}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
