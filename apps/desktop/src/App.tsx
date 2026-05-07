import { clamp } from '@opendirector/core/utils/common';
import { isTauri } from '@opendirector/core/utils/platform';
import { useLayoutStore, LAYOUT_CONSTRAINTS } from '@opendirector/core/stores/layoutStore';
import { useProjectStore, registerProjectOpenCallback } from '@opendirector/core/stores/projectStore';
import { Resizer } from '@opendirector/ui/components/layout/Resizer';
import { TitleBar } from '@opendirector/ui/components/layout/TitleBar';
import type { MenuAction } from '@opendirector/ui/components/layout/TitleBar';
import { Modal } from '@opendirector/ui/components/common/Modal';
import { Button } from '@opendirector/ui/components/common/Button';
import { useWindowCloseHandler } from '@opendirector/ui/hooks/useWindowCloseHandler';
import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

declare global {
  interface Window {
    __refreshGenerations?: () => Promise<void>;
  }
}

const { MIN_ASSETS_WIDTH, MAX_ASSETS_WIDTH, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH, MIN_PREVIEW_WIDTH, RESIZER_WIDTH } = LAYOUT_CONSTRAINTS;
const LazyTimelineCanvas = lazy(async () => ({
  default: (await import('@opendirector/ui/components/timeline/TimelineCanvas')).TimelineCanvas,
}));
const LazyInspectorPanel = lazy(async () => ({
  default: (await import('@opendirector/ui/components/inspector/InspectorPanel')).InspectorPanel,
}));
const LazyAssetPanel = lazy(async () => ({
  default: (await import('@opendirector/ui/components/assets/AssetPanel')).AssetPanel,
}));
const LazyPreviewPanel = lazy(async () => ({
  default: (await import('@opendirector/ui/components/preview/PreviewPanel')).PreviewPanel,
}));
const LazyProviderSettingsPanel = lazy(async () => ({
  default: (await import('@opendirector/ui/components/settings/ProviderSettingsPanel')).ProviderSettingsPanel,
}));

function PanelFallback({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div className={`flex h-full items-center justify-center text-xs text-zinc-500 ${className}`}>
      {label}
    </div>
  );
}

function GenerationPanel({ ready, loadingLabel, initLabel, className, children }: {
  ready: boolean; loadingLabel: string; initLabel: string; className: string; children: React.ReactNode;
}) {
  return ready ? (
    <Suspense fallback={<PanelFallback label={loadingLabel} className={className} />}>
      {children}
    </Suspense>
  ) : (
    <PanelFallback label={initLabel} className={className} />
  );
}

function App() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'video' | 'audio'>('video');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generationReady, setGenerationReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastViewportWidthRef = useRef<number>(0);

  const assetsWidth = useLayoutStore((s) => s.assetsWidth);
  const inspectorWidth = useLayoutStore((s) => s.inspectorWidth);
  const topSectionHeight = useLayoutStore((s) => s.topSectionHeight);
  const inspectorExpanded = useLayoutStore((s) => s.inspectorExpanded);

  const projectName = useProjectStore((s) => s.currentProject?.name);
  const isDirty = useProjectStore((s) => s.isDirty);
  const openProjectDialog = useProjectStore((s) => s.openProjectDialog);
  const saveProject = useProjectStore((s) => s.saveProject);
  const newProject = useProjectStore((s) => s.newProject);
  const cleanupTempFolder = useProjectStore((s) => s.cleanupTempFolder);
  const exportTimelineRender = useProjectStore((s) => s.exportTimelineRender);
  const exportXmeml = useProjectStore((s) => s.exportXmeml);
  const importXmeml = useProjectStore((s) => s.importXmeml);

  const { showCloseConfirm, handleSaveAndClose, handleDiscardAndClose, handleCloseCancel } = useWindowCloseHandler();

  const [showNewProjectConfirm, setShowNewProjectConfirm] = useState(false);

  const handleCreateProject = useCallback(async () => {
    if (!isDirty) {
      await cleanupTempFolder();
      await newProject();
      return;
    }
    setShowNewProjectConfirm(true);
  }, [isDirty, cleanupTempFolder, newProject]);

  const handleNewProjectSave = useCallback(async () => {
    setShowNewProjectConfirm(false);
    try {
      await saveProject();
    } catch { /* stay open on save failure */ return; }
    await newProject();
  }, [saveProject, newProject]);

  const handleNewProjectDiscard = useCallback(async () => {
    setShowNewProjectConfirm(false);
    await cleanupTempFolder();
    await newProject();
  }, [cleanupTempFolder, newProject]);
  const handleNewProjectCancel = useCallback(() => {
    setShowNewProjectConfirm(false);
  }, []);

  const titleBarMenuActions = useMemo<MenuAction[]>(() => [
    { icon: 'new', label: t('app.menu.newProject'), action: handleCreateProject, errorLabel: t('app.menu.newProjectFailed') },
    { icon: 'open', label: t('app.menu.openProject'), action: openProjectDialog, errorLabel: t('app.menu.openProjectFailed') },
    { icon: 'save', label: t('app.menu.saveProject'), action: saveProject, errorLabel: t('app.menu.saveProjectFailed') },
    { icon: 'export', label: t('app.menu.exportRender'), action: exportTimelineRender, errorLabel: t('app.menu.exportRenderFailed'), dividerBefore: true },
    { icon: 'export', label: t('app.menu.exportXml'), action: exportXmeml, errorLabel: t('app.menu.exportXmlFailed') },
    { icon: 'import', label: t('app.menu.importXml'), action: importXmeml, errorLabel: t('app.menu.importXmlFailed') },
  ], [
    t,
    handleCreateProject,
    openProjectDialog,
    saveProject,
    exportTimelineRender,
    exportXmeml,
    importXmeml,
  ]);

  useEffect(() => {
    let cancelled = false;
    void import('@opendirector/generation/registration')
      .then(({ registerGenerationServices }) => {
        registerGenerationServices();
        if (!cancelled) {
          setGenerationReady(true);
        }
      })
      .catch((error) => {
        console.error('Failed to register generation services:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Task bridge subscribes to Rust generation:status and asset:status events
  useEffect(() => {
    if (!generationReady || !isTauri()) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void Promise.all([
      import('@opendirector/generation/tasks/bridge'),
      import('@opendirector/generation/tasks/task-recovery'),
      import('@opendirector/generation/tasks/asset-bridge'),
    ])
      .then(([bridgeModule, recoveryModule, assetBridgeModule]) => {
        if (disposed) {
          return;
        }
        bridgeModule.initTaskBridge();
        assetBridgeModule.initAssetTaskBridge();

        window.__refreshGenerations = recoveryModule.refreshActiveGenerations;

        const unregister = registerProjectOpenCallback(async (project) => {
          if (project.folderPath) {
            await Promise.all([
              recoveryModule.restoreProjectGenerations(project.folderPath),
              assetBridgeModule.restoreProjectAssets(project.folderPath),
            ]);
          }
        });

        cleanup = () => {
          unregister();
          delete window.__refreshGenerations;
        };
      })
      .catch((error) => {
        console.error('Failed to initialize generation task bridges:', error);
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [generationReady]);

  // Initialize layout on first mount based on viewport and 16:9 target
  // Use ResizeObserver to ensure DOM layout is complete before measuring
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let initialized = false;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;

      const { isInitialized: alreadyInit } = useLayoutStore.getState();
      if (!alreadyInit && !initialized) {
        const { initializeLayout, topSectionHeight: tsh } = useLayoutStore.getState();
        const topPixelHeight = height * tsh;
        initializeLayout(width, topPixelHeight);
        lastViewportWidthRef.current = width;
        initialized = true;
      } else {
        const oldWidth = lastViewportWidthRef.current;
        if (oldWidth > 0 && width !== oldWidth) {
          useLayoutStore.getState().rescaleLayout(oldWidth, width);
          lastViewportWidthRef.current = width;
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const getViewportWidth = useCallback(() => {
    return containerRef.current?.clientWidth ?? window.innerWidth;
  }, []);

  // Handle horizontal resize for assets panel
  const handleAssetsResize = (delta: number) => {
    const state = useLayoutStore.getState();
    const newAssets = clamp(state.assetsWidth + delta, MIN_ASSETS_WIDTH, MAX_ASSETS_WIDTH);
    // Enforce min preview width
    const projectedPreview = getViewportWidth() - newAssets - state.inspectorWidth - 2 * RESIZER_WIDTH;
    if (projectedPreview < MIN_PREVIEW_WIDTH) {
      const maxAssets = getViewportWidth() - state.inspectorWidth - 2 * RESIZER_WIDTH - MIN_PREVIEW_WIDTH;
      state.setAssetsWidth(clamp(Math.min(newAssets, maxAssets), MIN_ASSETS_WIDTH, MAX_ASSETS_WIDTH));
    } else {
      state.setAssetsWidth(newAssets);
    }
  };

  // Handle horizontal resize for inspector panel
  const handleInspectorResize = (delta: number) => {
    const state = useLayoutStore.getState();
    const newInspector = clamp(state.inspectorWidth - delta, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH);
    // Enforce min preview width
    const projectedPreview = getViewportWidth() - state.assetsWidth - newInspector - 2 * RESIZER_WIDTH;
    if (projectedPreview < MIN_PREVIEW_WIDTH) {
      const maxInspector = getViewportWidth() - state.assetsWidth - 2 * RESIZER_WIDTH - MIN_PREVIEW_WIDTH;
      state.setInspectorWidth(clamp(Math.min(newInspector, maxInspector), MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH));
    } else {
      state.setInspectorWidth(newInspector);
    }
  };

  // Handle vertical resize between top and bottom sections
  const handleVerticalResize = (delta: number) => {
    if (!containerRef.current) return;
    const containerHeight = containerRef.current.clientHeight;
    const pixelDelta = delta / containerHeight;
    const state = useLayoutStore.getState();
    state.setTopSectionHeight(state.topSectionHeight + pixelDelta);
  };

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-white">
      {/* TitleBar - Combined title bar with project name and controls */}
      <TitleBar
        projectName={projectName}
        isDirty={isDirty}
        mode={mode}
        onModeChange={setMode}
        onSettingsClick={() => setSettingsOpen(true)}
        isDesktop={isTauri()}
        onSaveProject={saveProject}
        menuActions={titleBarMenuActions}
      />

      {/* CSS Grid keeps Inspector in the same React tree position to preserve local state on toggle */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{
          display: 'grid',
          gridTemplateColumns: `1fr auto ${inspectorWidth}px`,
          gridTemplateRows: `${topSectionHeight * 100}% auto 1fr`,
        }}
      >
        {/* Top row: Assets + Preview */}
        <div
          className="flex border-b border-zinc-800 overflow-hidden"
          style={{ gridColumn: '1', gridRow: '1' }}
        >
          <div
            className="border-r border-zinc-800 flex flex-col overflow-hidden bg-zinc-900"
            style={{ width: assetsWidth }}
          >
            <GenerationPanel ready={generationReady} loadingLabel={t('app.fallback.loadingAssets')} initLabel={t('app.fallback.initializingAssets')} className="bg-zinc-900">
              <LazyAssetPanel />
            </GenerationPanel>
          </div>
          <Resizer direction="horizontal" onResize={handleAssetsResize} />
          <div className="flex-1 flex flex-col overflow-hidden" style={{ minWidth: MIN_PREVIEW_WIDTH }}>
            <Suspense fallback={<PanelFallback label={t('app.fallback.loadingPreview')} className="bg-black" />}>
              <LazyPreviewPanel />
            </Suspense>
          </div>
        </div>

        <Resizer
          direction="horizontal"
          onResize={handleInspectorResize}
          style={{ gridColumn: '2', gridRow: inspectorExpanded ? '1 / -1' : '1' }}
        />

        <div
          className="border-l border-zinc-800 flex flex-col overflow-hidden bg-zinc-900"
          style={{ gridColumn: '3', gridRow: inspectorExpanded ? '1 / -1' : '1' }}
        >
          <GenerationPanel ready={generationReady} loadingLabel={t('app.fallback.loadingInspector')} initLabel={t('app.fallback.initializingGeneration')} className="bg-zinc-900">
            <LazyInspectorPanel />
          </GenerationPanel>
        </div>

        <Resizer
          direction="vertical"
          onResize={handleVerticalResize}
          style={{ gridColumn: inspectorExpanded ? '1' : '1 / -1', gridRow: '2' }}
        />

        <div
          className="flex flex-col overflow-hidden bg-zinc-950"
          style={{ gridColumn: inspectorExpanded ? '1' : '1 / -1', gridRow: '3' }}
        >
          <Suspense fallback={<PanelFallback label={t('app.fallback.loadingTimeline')} className="bg-zinc-950" />}>
            <LazyTimelineCanvas />
          </Suspense>
        </div>
      </div>

      {/* Close confirmation modal */}
      <Modal isOpen={showCloseConfirm} onClose={handleCloseCancel} title={t('app.modal.unsavedTitle')}>
        <p className="text-sm text-zinc-300 mb-6">
          {t('app.modal.unsavedCloseMessage')}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={handleDiscardAndClose}>
            {t('app.modal.discard')}
          </Button>
          <Button variant="primary" onClick={handleSaveAndClose}>
            {t('common.save')}
          </Button>
        </div>
      </Modal>

      {/* New project confirmation modal */}
      <Modal isOpen={showNewProjectConfirm} onClose={handleNewProjectCancel} title={t('app.menu.newProject')}>
        <p className="text-sm text-zinc-300 mb-6">
          {t('app.modal.unsavedNewProjectMessage')}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={handleNewProjectCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="ghost" onClick={handleNewProjectDiscard}>
            {t('app.modal.discard')}
          </Button>
          <Button variant="primary" onClick={handleNewProjectSave}>
            {t('common.save')}
          </Button>
        </div>
      </Modal>

      {/* Settings Modal */}
      <Modal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} title={t('app.modal.settings')} size="lg">
        <GenerationPanel ready={generationReady} loadingLabel={t('app.fallback.loadingSettings')} initLabel={t('app.fallback.initializingSettings')} className="min-h-[24rem]">
          <LazyProviderSettingsPanel />
        </GenerationPanel>
      </Modal>
    </div>
  );
}

export default App;
