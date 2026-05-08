import { Component, type ReactNode, type ErrorInfo } from 'react';
import { t as translate } from '@opendirector/core/i18n';
import { FragmentInspector } from './FragmentInspector';
import { useLayoutStore } from '@opendirector/core/stores/layoutStore';
import { PanelRightOpen, PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Error boundary specifically for the Inspector panel.
 * Catches errors when selecting fragments or interacting with provider UI,
 * without crashing the entire app.
 */
class InspectorErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[InspectorErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 text-center">
          <p className="text-sm text-red-400 mb-2">{translate('errors.inspectorFailed')}</p>
          <pre className="text-xs text-zinc-500 whitespace-pre-wrap mb-3 max-h-40 overflow-y-auto">
            {this.state.error?.message}
            {'\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded"
          >
            {translate('errors.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function InspectorPanel() {
  const { t } = useTranslation();
  const inspectorExpanded = useLayoutStore((s) => s.inspectorExpanded);
  const toggleInspectorExpanded = useLayoutStore((s) => s.toggleInspectorExpanded);

  return (
    <div className="relative flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        <InspectorErrorBoundary>
          <FragmentInspector />
        </InspectorErrorBoundary>
      </div>
      <button
        onClick={toggleInspectorExpanded}
        className="absolute bottom-2 right-2 p-1.5 rounded-md bg-zinc-800/80 hover:bg-zinc-700 transition-colors text-zinc-500 hover:text-zinc-300 border border-zinc-700/50"
        title={inspectorExpanded ? t('errors.collapseInspector') : t('errors.expandInspector')}
      >
        {inspectorExpanded ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
      </button>
    </div>
  );
}
