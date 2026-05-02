import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function StartupShell({ detail }: { detail: string }) {
  return (
    <div style={{ height: '100vh', background: '#09090b', color: '#fff', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 32,
          padding: '0 12px',
          borderBottom: '1px solid #27272a',
          background: '#18181b',
          fontSize: 14,
          fontWeight: 700,
          color: '#d4d4d8',
        }}
      >
        <span>OpenDirector</span>
      </div>
      <div style={{ display: 'flex', height: 'calc(100vh - 32px)', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '9999px',
              border: '2px solid #3f3f46',
              borderTopColor: '#3b82f6',
              animation: 'boot-spin 0.8s linear infinite',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#e4e4e7' }}>正在启动编辑器</p>
            <p style={{ margin: 0, fontSize: 12, color: '#71717a' }}>{detail}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

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
