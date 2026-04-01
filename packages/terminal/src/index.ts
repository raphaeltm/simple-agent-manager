/**
 * Shared terminal package for Cloud AI Workspaces.
 *
 * Provides a terminal component with:
 * - Automatic WebSocket reconnection with exponential backoff
 * - Connection state visualization (connecting, reconnecting, failed)
 * - xterm.js integration
 */

// Main terminal component
export { Terminal } from './Terminal';

// Multi-terminal components (new)
export { TabBar } from './components/TabBar';
export { TabItem } from './components/TabItem';
export { TabOverflowMenu } from './components/TabOverflowMenu';
export { MultiTerminal } from './MultiTerminal';

// Sub-components
export { ConnectionOverlay } from './ConnectionOverlay';
export { StatusBar } from './StatusBar';

// Hooks
export { useTabShortcuts } from './hooks/useTabShortcuts';
export { useTerminalSessions } from './hooks/useTerminalSessions';
export { useWebSocket } from './useWebSocket';

// Types for multi-terminal
export type {
  MultiTerminalError,
  MultiTerminalHandle,
  MultiTerminalProps,
  MultiTerminalSessionSnapshot,
  PersistedSession,
  TabBarProps,
  TabItemProps,
  TabShortcutActions,
  TerminalConfig,
  TerminalSession,
  TerminalTabState,
  UseTabShortcutsReturn,
  UseTerminalSessionsReturn,
} from './types/multi-terminal';

// Types
export type {
  ConnectionOverlayProps,
  ConnectionState,
  StatusBarProps,
  TerminalProps,
  UseWebSocketOptions,
  UseWebSocketReturn,
} from './types';
