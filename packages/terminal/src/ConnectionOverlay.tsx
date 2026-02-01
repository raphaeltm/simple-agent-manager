import type { ConnectionOverlayProps } from './types';

/**
 * Overlay shown when terminal is connecting, reconnecting, or has failed.
 * Provides visual feedback and retry option.
 */
export function ConnectionOverlay({
  connectionState,
  reconnectAttempts,
  maxRetries,
  onRetry,
  workspaceStopped = false,
}: ConnectionOverlayProps) {
  // Don't show overlay when connected
  if (connectionState === 'connected') {
    return null;
  }

  const getContent = () => {
    // Show workspace stopped message if applicable
    if (workspaceStopped && connectionState === 'failed') {
      return {
        icon: (
          <svg
            className="w-8 h-8 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728m-9.9-2.829a5 5 0 010-7.07m7.072 0a5 5 0 010 7.07M13 12a1 1 0 11-2 0 1 1 0 012 0z"
            />
          </svg>
        ),
        title: 'Workspace stopped',
        subtitle: 'The workspace has been shut down due to inactivity or manual stop',
        showRetry: false,
      };
    }

    switch (connectionState) {
      case 'connecting':
        return {
          icon: (
            <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          ),
          title: 'Connecting to terminal...',
          subtitle: null,
          showRetry: false,
        };

      case 'reconnecting':
        return {
          icon: (
            <div className="w-8 h-8 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
          ),
          title: 'Reconnecting...',
          subtitle: `Attempt ${reconnectAttempts} of ${maxRetries}`,
          showRetry: false,
        };

      case 'failed':
        return {
          icon: (
            <svg
              className="w-8 h-8 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          ),
          title: 'Connection failed',
          subtitle: 'The terminal connection could not be established',
          showRetry: true,
        };

      default:
        return {
          icon: null,
          title: '',
          subtitle: null,
          showRetry: false,
        };
    }
  };

  const { icon, title, subtitle, showRetry } = getContent();

  return (
    <div className="absolute inset-0 bg-gray-900/90 flex flex-col items-center justify-center z-10">
      {icon}

      <h3 className="mt-4 text-lg font-medium text-gray-200">{title}</h3>

      {subtitle && <p className="mt-1 text-sm text-gray-400">{subtitle}</p>}

      {showRetry && onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
        >
          Try Again
        </button>
      )}
    </div>
  );
}
