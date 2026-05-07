import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { i18n, initializeI18n, normalizeLanguage, t } from '@opendirector/core/i18n';
import './styles.css';
import { StartupShell } from './StartupShell';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found');
}

const root = createRoot(rootElement);

function renderStartupShell(detail: string) {
  root.render(
    <StrictMode>
      <StartupShell detail={detail} />
    </StrictMode>
  );
}

renderStartupShell(t('app.startup.loadingMain'));

async function getSystemLanguage() {
  try {
    const { locale } = await import('@tauri-apps/plugin-os');
    return normalizeLanguage(await locale());
  } catch {
    return normalizeLanguage(navigator.language);
  }
}

async function resolveInitialLanguage() {
  const { getPersistedLanguage, useSettingsStore } = await import('@opendirector/core/stores/settingsStore');
  const language = getPersistedLanguage() ?? (await getSystemLanguage());
  if (useSettingsStore.getState().language !== language) {
    useSettingsStore.getState().setLanguage(language);
  }
  return language;
}

async function bootstrapApp() {
  const languagePromise = resolveInitialLanguage();
  const appPromise = import('./App');
  const errorBoundaryPromise = import('@opendirector/ui/components/common/ErrorBoundary');
  const projectStorePromise = import('@opendirector/core/stores/projectStore');
  const adapterPromise = import('@opendirector/core/adapters/tauri-adapter').then(async ({ getPlatformAdapter }) => {
    const adapter = await getPlatformAdapter();
    (window as unknown as { __PLATFORM_ADAPTER__?: typeof adapter }).__PLATFORM_ADAPTER__ = adapter;
    return adapter;
  });

  const [{ default: App }, { ErrorBoundary }] = await Promise.all([
    appPromise,
    errorBoundaryPromise,
  ]);
  await initializeI18n(await languagePromise);

  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>
  );

  const { useProjectStore } = await projectStorePromise;
  useProjectStore.getState().ensureProject();

  void adapterPromise;

  if (import.meta.env.DEV) {
    const { useTimelineStore } = await import('@opendirector/core/stores/timelineStore');
    (window as unknown as { __TIMELINE_STORE__?: typeof useTimelineStore }).__TIMELINE_STORE__ =
      useTimelineStore;
  }
}

requestAnimationFrame(() => {
  bootstrapApp().catch((error) => {
    console.error(error);
    renderStartupShell(error instanceof Error ? error.message : String(error));
  });
});
