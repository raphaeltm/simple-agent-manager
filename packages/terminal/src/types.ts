/**
 * Shared types for the terminal package.
 */

/** WebSocket connection state */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** Props for the main Terminal component */
export interface TerminalProps {
  /** WebSocket URL for terminal connection */
  wsUrl: string;
  /** Optional shutdown deadline (ISO 8601 timestamp) */
  shutdownDeadline?: string | null;
  /** Callback when user activity is detected */
  onActivity?: () => void;
  /** Additional CSS class name */
  className?: string;
}

/** Props for the StatusBar component */
export interface StatusBarProps {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Optional shutdown deadline (ISO 8601 timestamp) */
  shutdownDeadline?: string | null;
  /** Number of reconnection attempts (when reconnecting) */
  reconnectAttempts?: number;
}

/** Props for the ConnectionOverlay component */
export interface ConnectionOverlayProps {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Number of reconnection attempts */
  reconnectAttempts: number;
  /** Maximum number of retries before failure */
  maxRetries: number;
  /** Callback to manually retry connection */
  onRetry?: () => void;
  /** Whether the workspace has been stopped (optional, for showing appropriate message) */
  workspaceStopped?: boolean;
}

/** Options for useWebSocket hook */
export interface UseWebSocketOptions {
  /** WebSocket URL to connect to */
  url: string;
  /** Maximum number of reconnection attempts (default: 5) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelay?: number;
  /** Maximum delay between retries in ms (default: 30000) */
  maxDelay?: number;
  /** Callback when connection state changes */
  onStateChange?: (state: ConnectionState) => void;
}

/** Return type for useWebSocket hook */
export interface UseWebSocketReturn {
  /** Current WebSocket instance (null if not connected) */
  socket: WebSocket | null;
  /** Current connection state */
  state: ConnectionState;
  /** Number of reconnection attempts */
  retryCount: number;
  /** Manually trigger reconnection */
  retry: () => void;
  /** Disconnect and cleanup */
  disconnect: () => void;
}
