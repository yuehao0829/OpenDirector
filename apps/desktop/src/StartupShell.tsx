import { t } from '@opendirector/core/i18n';

interface StartupShellProps {
  detail: string;
}

export function StartupShell({ detail }: StartupShellProps) {
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
            <p style={{ margin: 0, fontSize: 14, color: '#e4e4e7' }}>{t('app.startup.title')}</p>
            <p style={{ margin: 0, fontSize: 12, color: '#71717a' }}>{detail}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
