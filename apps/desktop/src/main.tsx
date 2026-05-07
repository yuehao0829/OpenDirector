import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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

renderStartupShell('加载主界面');

async function bootstrapApp() {
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

  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
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
