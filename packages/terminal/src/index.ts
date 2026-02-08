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

// Multi-terminal components (new)
export { MultiTerminal } from './MultiTerminal';
export { TabBar } from './components/TabBar';
export { TabItem } from './components/TabItem';
export { TabOverflowMenu } from './components/TabOverflowMenu';

// Sub-components
export { StatusBar } from './StatusBar';
export { ConnectionOverlay } from './ConnectionOverlay';

// Hooks
export { useWebSocket } from './useWebSocket';
export { useIdleDeadline, formatDeadlineDisplay } from './useIdleDeadline';
export { useTerminalSessions } from './hooks/useTerminalSessions';
export { useTabShortcuts } from './hooks/useTabShortcuts';

// Types for multi-terminal
export type {
  TerminalSession,
  TerminalTabState,
  TerminalConfig,
  MultiTerminalProps,
  TabItemProps,
  TabBarProps,
  UseTerminalSessionsReturn,
  UseTabShortcutsReturn,
  TabShortcutActions,
  MultiTerminalError,
} from './types/multi-terminal';

// Types
export type {
  ConnectionState,
  TerminalProps,
  StatusBarProps,
  ConnectionOverlayProps,
  UseWebSocketOptions,
  UseWebSocketReturn,
} from './types';
