import i18next, { type i18n as I18nInstance, type TOptions } from 'i18next';
import { resources } from './resources';

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = 'zh-CN';

export function isSupportedLanguage(value: unknown): value is AppLanguage {
  return value === 'zh-CN' || value === 'en-US';
}

export function normalizeLanguage(locale: string | null | undefined): AppLanguage {
  const normalized = locale?.trim().replace('_', '-').toLowerCase();
  if (!normalized) {
    return DEFAULT_LANGUAGE;
  }
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en-US';
  }
  return DEFAULT_LANGUAGE;
}

export const i18n: I18nInstance = i18next.createInstance();

void i18n.init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false, skipOnVariables: true },
  returnNull: false,
  initAsync: false,
});

export async function initializeI18n(language: AppLanguage = DEFAULT_LANGUAGE): Promise<typeof i18n> {
  if (i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
  return i18n;
}

export async function changeI18nLanguage(language: AppLanguage): Promise<void> {
  await i18n.changeLanguage(language);
}

export function t(key: string, options?: TOptions): string {
  return i18n.t(key, options);
}

export type TranslationKey = string;
