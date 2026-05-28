import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_FPS, DEFAULT_ASPECT_RATIO } from '../constants';
import { DEFAULT_GENERATION_PARAMS } from '../types/generation';
import type { GenerationParamDefaults } from '../types/generation';
import { DEFAULT_LANGUAGE, isSupportedLanguage } from '../i18n';
import type { AppLanguage } from '../i18n';

export const SETTINGS_STORAGE_KEY = 'opendirector-settings';

interface SettingsState {
  // UI Settings
  theme: 'dark' | 'light';
  language: AppLanguage;
  sidebarCollapsed: boolean;

  // Editor Settings
  autoSave: boolean;
  autoSaveInterval: number; // milliseconds
  defaultFps: number;
  defaultResolution: { width: number; height: number };
  defaultAspectRatio: string;

  // Generation Settings
  maxConcurrentGenerations: number;
  defaultGenerationParams: GenerationParamDefaults;

  // Actions
  setTheme: (theme: 'dark' | 'light') => void;
  setLanguage: (language: AppLanguage) => void;
  toggleSidebar: () => void;
  setAutoSave: (enabled: boolean) => void;
  setAutoSaveInterval: (interval: number) => void;
  setDefaultFps: (fps: number) => void;
  setDefaultGenerationParams: (params: Partial<GenerationParamDefaults>) => void;
  reset: () => void;
}

const defaultSettings = {
  theme: 'dark' as const,
  language: DEFAULT_LANGUAGE,
  sidebarCollapsed: false,
  autoSave: true,
  autoSaveInterval: 30000,
  defaultFps: DEFAULT_FPS,
  defaultResolution: { ...DEFAULT_PROJECT_SETTINGS.resolution },
  defaultAspectRatio: DEFAULT_ASPECT_RATIO,
  maxConcurrentGenerations: 3,
  defaultGenerationParams: { ...DEFAULT_GENERATION_PARAMS },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,

      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setAutoSave: (enabled) => set({ autoSave: enabled }),
      setAutoSaveInterval: (interval) => set({ autoSaveInterval: Math.max(5000, interval) }),
      setDefaultFps: (fps) => set({ defaultFps: fps }),
      setDefaultGenerationParams: (params) =>
        set((state) => ({ defaultGenerationParams: { ...state.defaultGenerationParams, ...params } })),
      reset: () => set(defaultSettings),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
    }
  )
);

export function getPersistedLanguage(): AppLanguage | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }

  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { state?: { language?: unknown } };
    return isSupportedLanguage(parsed.state?.language) ? parsed.state.language : undefined;
  } catch {
    return undefined;
  }
}
