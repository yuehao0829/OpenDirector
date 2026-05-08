import { Component, type ReactNode, type ErrorInfo } from 'react';
import { t as translate } from '@opendirector/core/i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches unhandled render errors to prevent the entire app from crashing.
 * Displays a fallback UI so the user can reload and recover.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Unhandled render error:', error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex items-center justify-center h-screen bg-zinc-950 text-white">
          <div className="text-center max-w-lg px-6">
            <h1 className="text-xl font-semibold mb-2">{translate('errors.somethingWentWrong')}</h1>
            <p className="text-sm text-zinc-400 mb-4">
              {this.state.error?.message ?? translate('errors.unknownError')}
            </p>
            <pre className="text-xs text-red-400 text-left whitespace-pre-wrap bg-zinc-900 p-3 rounded mb-4 max-h-40 overflow-y-auto">
              {this.state.error?.stack}
            </pre>
            <button
              onClick={this.handleReload}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded"
            >
              {translate('errors.retry')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
