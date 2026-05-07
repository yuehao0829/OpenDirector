import { changeI18nLanguage } from '@opendirector/core/i18n';
import type { AppLanguage } from '@opendirector/core/i18n';
import { useSettingsStore } from '@opendirector/core/stores/settingsStore';
import { useTranslation } from 'react-i18next';

const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; labelKey: string }> = [
  { value: 'zh-CN', labelKey: 'settings.technical.chinese' },
  { value: 'en-US', labelKey: 'settings.technical.english' },
];

export function TechnicalSettingsPanel() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  const handleLanguageChange = (nextLanguage: AppLanguage) => {
    if (nextLanguage === language) return;
    setLanguage(nextLanguage);
    void changeI18nLanguage(nextLanguage);
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
    </div>
  );
}
