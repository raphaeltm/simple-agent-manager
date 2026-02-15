import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
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
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--sam-color-bg-base, #0a0a0a)',
          color: 'var(--sam-color-fg-primary, #e5e5e5)',
          padding: '24px',
        }}
      >
        <div
          style={{
            maxWidth: '480px',
            width: '100%',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: '2rem',
              marginBottom: '16px',
              color: 'var(--sam-color-danger, #f87171)',
            }}
          >
            Something went wrong
          </div>

          <p
            style={{
              color: 'var(--sam-color-fg-secondary, #a3a3a3)',
              fontSize: '0.95rem',
              lineHeight: 1.6,
              marginBottom: '24px',
            }}
          >
            An unexpected error occurred. The error has been reported automatically.
          </p>

          {this.state.error && (
            <div
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '24px',
                textAlign: 'left',
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                color: '#f87171',
                wordBreak: 'break-word',
                maxHeight: '120px',
                overflow: 'auto',
              }}
            >
              {this.state.error.message}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: '12px',
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={this.handleReload}
              style={{
                minHeight: '48px',
                padding: '0 24px',
                backgroundColor: 'var(--sam-color-accent-primary, #10b981)',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '0.95rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reload Page
            </button>
            <button
              onClick={this.handleGoHome}
              style={{
                minHeight: '48px',
                padding: '0 24px',
                backgroundColor: 'var(--sam-color-bg-surface, #1a1a1a)',
                color: 'var(--sam-color-fg-primary, #e5e5e5)',
                border: '1px solid var(--sam-color-border-default, #333)',
                borderRadius: '8px',
                fontSize: '0.95rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Go Home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
