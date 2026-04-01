import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

import { reportRawError } from '../lib/error-reporter';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global error boundary that catches unhandled React errors.
 * Shows a recovery UI instead of a white screen.
 * Reports errors to CF Workers observability via the error reporter.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportRawError(error, 'react-error-boundary', {
      componentStack: errorInfo.componentStack ?? undefined,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas text-fg-primary p-6">
        <div className="max-w-md w-full text-center">
          <div className="text-3xl mb-4 text-danger">
            Something went wrong
          </div>

          <p className="text-fg-muted text-base leading-relaxed mb-6">
            An unexpected error occurred. The error has been reported automatically.
          </p>

          {this.state.error && (
            <div className="bg-danger-tint border border-danger/30 rounded-lg px-4 py-3 mb-6 text-left text-xs font-mono text-danger-fg break-words max-h-30 overflow-auto">
              {this.state.error.message}
            </div>
          )}

          <div className="flex gap-3 justify-center flex-wrap">
            <button
              onClick={this.handleReload}
              className="min-h-12 px-6 bg-accent text-fg-on-accent border-none rounded-lg text-base font-semibold cursor-pointer"
            >
              Reload Page
            </button>
            <button
              onClick={this.handleGoHome}
              className="min-h-12 px-6 bg-surface text-fg-primary border border-border-default rounded-lg text-base font-semibold cursor-pointer"
            >
              Go Home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
