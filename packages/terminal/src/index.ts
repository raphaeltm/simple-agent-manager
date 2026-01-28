/**
 * Shared terminal package for Cloud AI Workspaces.
 *
 * Provides a terminal component with:
 * - Automatic WebSocket reconnection with exponential backoff
 * - Connection state visualization (connecting, reconnecting, failed)
 * - Idle deadline tracking and display
 * - xterm.js integration
 */

// Main terminal component
export { Terminal } from './Terminal';

// Sub-components
export { StatusBar } from './StatusBar';
export { ConnectionOverlay } from './ConnectionOverlay';

// Hooks
export { useWebSocket } from './useWebSocket';
export { useIdleDeadline, formatDeadlineDisplay } from './useIdleDeadline';

// Types
export type {
  ConnectionState,
  TerminalProps,
  StatusBarProps,
  ConnectionOverlayProps,
  UseWebSocketOptions,
  UseWebSocketReturn,
} from './types';
