/**
 * Multi-Terminal UI Type Definitions
 * Provides TypeScript types for multi-terminal session management
 */

/**
 * Represents a single terminal session within a workspace
 */
export interface TerminalSession {
  /** UUID for session identification */
  id: string;

  /** User-editable tab name (max 50 chars) */
  name: string;

  /** Current connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting';

  /** Session creation timestamp */
  createdAt: Date;

  /** Last activity timestamp */
  lastActivityAt: Date;

  /** Current working directory (if available) */
  workingDirectory?: string;

  /** Whether this is the currently visible tab */
  isActive: boolean;

  /** Tab position (0-based) */
  order: number;

  /** Associated WebSocket connection (if connected) */
  websocket?: WebSocket;

  /** Associated xterm.js instance reference */
  terminalInstance?: any; // Will be Terminal type from xterm

  /** Server-assigned session ID for reconnection matching */
  serverSessionId?: string;
}

/**
 * UI state for the tabbed terminal interface
 */
export interface TerminalTabState {
  /** Map of sessionId to session */
  sessions: Map<string, TerminalSession>;

  /** Currently active session ID */
  activeSessionId: string | null;

  /** Maximum concurrent sessions allowed */
  maxSessions: number;

  /** UI behavior for tab overflow */
  tabOverflowMode: 'scroll' | 'menu';

  /** Whether tabs are currently being reordered */
  isReordering: boolean;
}

/**
 * Extended WebSocket message types for session routing
 */
export interface ClientMessage {
  /** Target session ID (optional for backward compatibility) */
  sessionId?: string;

  /** Message type */
  type: 'input' | 'resize' | 'ping' | 'create_session' | 'close_session' | 'rename_session' | 'list_sessions' | 'reattach_session';

  /** Message payload */
  data?: any;
}

export interface ServerMessage {
  /** Source session ID */
  sessionId?: string;

  /** Message type */
  type: 'output' | 'session' | 'error' | 'pong' | 'session_created' | 'session_closed' | 'session_renamed' | 'session_list' | 'session_reattached' | 'scrollback';

  /** Message payload */
  data?: any;
}

/**
 * Message payloads for session management
 */
export interface CreateSessionData {
  sessionId: string;
  rows: number;
  cols: number;
  name?: string;
}

export interface SessionCreatedData {
  sessionId: string;
  workingDirectory?: string;
  shell?: string;
}

export interface CloseSessionData {
  sessionId: string;
}

export interface SessionClosedData {
  sessionId: string;
  reason: 'user_requested' | 'idle_timeout' | 'process_exit' | 'error';
  exitCode?: number;
}

export interface RenameSessionData {
  sessionId: string;
  name: string;
}

export interface SessionListData {
  sessions: Array<{
    sessionId: string;
    name?: string;
    status?: string; // "running" or "exited"
    workingDirectory?: string;
    createdAt: string;
    lastActivityAt?: string;
  }>;
}

export interface SessionReattachedData {
  sessionId: string;
  workingDirectory?: string;
  shell?: string;
}

export interface ScrollbackData {
  data: string;
}

export interface ReattachSessionData {
  sessionId: string;
  rows: number;
  cols: number;
}

/**
 * Terminal configuration from environment variables
 */
export interface TerminalConfig {
  /** Maximum concurrent terminal sessions */
  maxSessions: number;

  /** Tab switch animation duration in ms */
  tabSwitchAnimationMs: number;

  /** Lines of scrollback per terminal */
  scrollbackLines: number;

  /** Session idle timeout in seconds (VM Agent) */
  sessionIdleTimeout?: number;

  /** Memory limit per session in MB (VM Agent) */
  resourceLimitMb?: number;

  /** Keyboard shortcuts configuration */
  shortcuts: {
    newTab: string;
    closeTab: string;
    nextTab: string;
    previousTab: string;
    jumpToTab: string; // Pattern like "Alt+{n}"
  };
}

/**
 * Tab component props
 */
export interface TabItemProps {
  session: TerminalSession;
  isActive: boolean;
  onActivate: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onRename: (sessionId: string, name: string) => void;
  isDraggable?: boolean;
}

export interface TabBarProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onTabActivate: (sessionId: string) => void;
  onTabClose: (sessionId: string) => void;
  onTabRename: (sessionId: string, name: string) => void;
  onNewTab: () => void;
  maxTabs: number;
  className?: string;
}

/**
 * Hook return types
 */
/** Serializable session metadata for persistence */
export interface PersistedSession {
  name: string;
  order: number;
  /** Server-assigned session ID for reconnection matching */
  serverSessionId?: string;
}

export interface UseTerminalSessionsReturn {
  sessions: Map<string, TerminalSession>;
  activeSessionId: string | null;
  createSession: (name?: string) => string;
  closeSession: (sessionId: string) => void;
  activateSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  reorderSessions: (fromIndex: number, toIndex: number) => void;
  getSessionByOrder: (order: number) => TerminalSession | undefined;
  canCreateSession: boolean;
  updateSessionStatus: (sessionId: string, status: TerminalSession['status']) => void;
  updateSessionWorkingDirectory: (sessionId: string, workingDirectory: string) => void;
  /** Update the server-assigned session ID for reconnection matching */
  updateServerSessionId: (sessionId: string, serverSessionId: string) => void;
  /** Get persisted session metadata from sessionStorage */
  getPersistedSessions: () => PersistedSession[] | null;
  /** Clear persisted session state */
  clearPersistedSessions: () => void;
}

export interface UseTabShortcutsReturn {
  registerShortcuts: (actions: TabShortcutActions) => void;
  unregisterShortcuts: () => void;
  isShortcutPressed: (event: KeyboardEvent) => boolean;
}

export interface TabShortcutActions {
  onNewTab: () => void;
  onCloseTab: () => void;
  onNextTab: () => void;
  onPreviousTab: () => void;
  onJumpToTab: (index: number) => void;
}

/**
 * Multi-terminal container props
 */
export interface MultiTerminalProps {
  /** WebSocket URL for terminal connections */
  wsUrl: string;

  /** Optional shutdown deadline */
  shutdownDeadline?: string | null;

  /** Callback when user activity is detected */
  onActivity?: () => void;

  /** Optional CSS class name */
  className?: string;

  /** Terminal configuration */
  config?: Partial<TerminalConfig>;

  /** Key for sessionStorage persistence. Sessions survive page refresh while VM is alive. */
  persistenceKey?: string;
}

/**
 * Error types for multi-terminal operations
 */
export enum MultiTerminalError {
  MAX_SESSIONS_REACHED = 'MAX_SESSIONS_REACHED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  SESSION_CREATION_FAILED = 'SESSION_CREATION_FAILED',
  INVALID_SESSION_NAME = 'INVALID_SESSION_NAME',
}

export class MultiTerminalException extends Error {
  constructor(
    public readonly type: MultiTerminalError,
    message: string,
    public readonly sessionId?: string
  ) {
    super(message);
    this.name = 'MultiTerminalException';
  }
}