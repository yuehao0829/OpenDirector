import { changeI18nLanguage } from '@opendirector/core/i18n';
import type { AppLanguage } from '@opendirector/core/i18n';
import { useSettingsStore } from '@opendirector/core/stores/settingsStore';
import { useTranslation } from 'react-i18next';

const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; labelKey: string }> = [
  { value: 'zh-CN', labelKey: 'settings.general.chinese' },
  { value: 'en-US', labelKey: 'settings.general.english' },
];

export function GeneralSettingsPanel() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  const handleLanguageChange = (nextLanguage: AppLanguage) => {
    setLanguage(nextLanguage);
    void changeI18nLanguage(nextLanguage);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-zinc-200 mb-1">{t('settings.general.title')}</h2>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-zinc-300">{t('settings.general.language')}</label>
        <div className="inline-flex rounded-lg bg-zinc-800 p-0.5">
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleLanguageChange(option.value)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
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
    </div>
  );
}
