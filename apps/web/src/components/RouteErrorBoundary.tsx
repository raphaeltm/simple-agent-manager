import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

import { reportRawError } from '../lib/error-reporter';

interface Props {
  children: ReactNode;
  /** Optional label for error reporting (e.g., route name) */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Granular error boundary for route-level and component-level isolation.
 * Shows a "Something went wrong" message with a "Try again" button
 * that resets the boundary without reloading the page.
 *
 * Unlike the global ErrorBoundary, this one is designed to be placed
 * around individual routes or components so that a crash in one area
 * does not take down the entire app.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportRawError(error, `route-error-boundary${this.props.label ? `:${this.props.label}` : ''}`, {
      componentStack: errorInfo.componentStack ?? undefined,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div role="alert" className="flex flex-col items-center justify-center p-8 text-center min-h-[200px]">
        <p className="text-lg font-semibold text-fg-primary mb-2">
          Something went wrong
        </p>
        <p className="text-sm text-fg-muted mb-4">
          An error occurred while rendering this section.
        </p>
        {this.state.error && (
          <div className="bg-danger-tint border border-danger/30 rounded-lg px-4 py-2 mb-4 text-left text-xs font-mono text-danger-fg break-words max-h-24 overflow-auto max-w-md w-full">
            {this.state.error.message}
          </div>
        )}
        <button
          type="button"
          onClick={this.handleReset}
          className="px-4 py-2 min-h-[44px] bg-accent text-fg-on-accent border-none rounded-lg text-sm font-semibold cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          Try again
        </button>
      </div>
    );
  }
}
