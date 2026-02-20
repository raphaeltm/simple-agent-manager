// =============================================================================
// ACP Error Taxonomy — Structured error codes for session observability
// =============================================================================

/**
 * Structured error codes covering all known ACP session failure modes.
 * Each code maps to a user-facing message, suggested action, and severity.
 */
export type AcpErrorCode =
  // Network & transport
  | 'NETWORK_DISCONNECTED'
  | 'HEARTBEAT_TIMEOUT'
  | 'NETWORK_OFFLINE'
  // Authentication
  | 'AUTH_EXPIRED'
  | 'AUTH_REJECTED'
  // Server
  | 'SERVER_RESTART'
  | 'SERVER_ERROR'
  // Agent lifecycle
  | 'AGENT_CRASH'
  | 'AGENT_INSTALL_FAILED'
  | 'AGENT_START_FAILED'
  | 'AGENT_ERROR'
  // Prompt
  | 'PROMPT_TIMEOUT'
  // Reconnection
  | 'RECONNECT_TIMEOUT'
  // Connection
  | 'CONNECTION_FAILED'
  | 'URL_UNAVAILABLE'
  // Catch-all
  | 'UNKNOWN';

/** How recoverable the error is — drives UX treatment */
export type ErrorSeverity =
  /** Will auto-recover (reconnection in progress) */
  | 'transient'
  /** Manual action needed (click reconnect, check settings) */
  | 'recoverable'
  /** Session is broken, needs restart or new session */
  | 'fatal';

/** Metadata for a structured error code */
export interface AcpErrorMeta {
  code: AcpErrorCode;
  severity: ErrorSeverity;
  /** Short user-facing message */
  userMessage: string;
  /** Suggested action for the user */
  suggestedAction: string;
}

/** Error metadata registry — maps each code to UX-relevant information */
const ERROR_REGISTRY: Record<AcpErrorCode, Omit<AcpErrorMeta, 'code'>> = {
  // Network & transport
  NETWORK_DISCONNECTED: {
    severity: 'transient',
    userMessage: 'Network connection lost',
    suggestedAction: 'Reconnecting automatically...',
  },
  HEARTBEAT_TIMEOUT: {
    severity: 'transient',
    userMessage: 'Connection timed out',
    suggestedAction: 'Reconnecting automatically...',
  },
  NETWORK_OFFLINE: {
    severity: 'recoverable',
    userMessage: 'You are offline',
    suggestedAction: 'Check your internet connection. Reconnection will resume when you are back online.',
  },
  // Authentication
  AUTH_EXPIRED: {
    severity: 'recoverable',
    userMessage: 'Session expired',
    suggestedAction: 'Refresh the page to get a new session token.',
  },
  AUTH_REJECTED: {
    severity: 'fatal',
    userMessage: 'Authentication failed',
    suggestedAction: 'Your session is no longer valid. Please refresh and sign in again.',
  },
  // Server
  SERVER_RESTART: {
    severity: 'transient',
    userMessage: 'Server is restarting',
    suggestedAction: 'Reconnecting automatically...',
  },
  SERVER_ERROR: {
    severity: 'recoverable',
    userMessage: 'Server error',
    suggestedAction: 'Try reconnecting. If the problem persists, restart the workspace.',
  },
  // Agent lifecycle
  AGENT_CRASH: {
    severity: 'recoverable',
    userMessage: 'Agent process crashed',
    suggestedAction: 'Try reconnecting or restarting the workspace.',
  },
  AGENT_INSTALL_FAILED: {
    severity: 'recoverable',
    userMessage: 'Agent installation failed',
    suggestedAction: 'Check your API key in Settings, then try restarting the workspace.',
  },
  AGENT_START_FAILED: {
    severity: 'recoverable',
    userMessage: 'Agent failed to start',
    suggestedAction: 'Try restarting the workspace. Check Settings if the problem persists.',
  },
  AGENT_ERROR: {
    severity: 'recoverable',
    userMessage: 'Agent error',
    suggestedAction: 'Try reconnecting or switching to a different agent.',
  },
  // Prompt
  PROMPT_TIMEOUT: {
    severity: 'recoverable',
    userMessage: 'Prompt timed out',
    suggestedAction: 'The agent took too long to respond. Try a simpler prompt or reconnect.',
  },
  // Reconnection
  RECONNECT_TIMEOUT: {
    severity: 'recoverable',
    userMessage: 'Could not reconnect',
    suggestedAction: 'Click Reconnect to try again, or refresh the page.',
  },
  // Connection
  CONNECTION_FAILED: {
    severity: 'recoverable',
    userMessage: 'Connection failed',
    suggestedAction: 'The workspace may still be starting. Try reconnecting in a moment.',
  },
  URL_UNAVAILABLE: {
    severity: 'recoverable',
    userMessage: 'Could not reach workspace',
    suggestedAction: 'The workspace URL is unavailable. Check that the workspace is running.',
  },
  // Catch-all
  UNKNOWN: {
    severity: 'recoverable',
    userMessage: 'Something went wrong',
    suggestedAction: 'Try reconnecting. If the problem persists, restart the workspace.',
  },
};

/** Get full error metadata for a given error code */
export function getErrorMeta(code: AcpErrorCode): AcpErrorMeta {
  const meta = ERROR_REGISTRY[code];
  return { code, ...meta };
}

/**
 * Classify a WebSocket close code into a structured AcpErrorCode.
 * Complements the existing CloseCodeStrategy by providing richer semantics.
 */
export function errorCodeFromCloseCode(code: number | undefined): AcpErrorCode {
  if (code === undefined) return 'UNKNOWN';
  switch (code) {
    case 1000: return 'UNKNOWN'; // Normal close — not really an error
    case 1001: return 'SERVER_RESTART';
    case 1006: return 'NETWORK_DISCONNECTED';
    case 1008: return 'AUTH_REJECTED';
    case 1011: return 'SERVER_ERROR';
    case 4000: return 'HEARTBEAT_TIMEOUT';
    case 4001: return 'AUTH_EXPIRED';
    default: return 'UNKNOWN';
  }
}

/**
 * Classify a gateway error message or agent status error into a structured code.
 * Attempts keyword matching against known error patterns.
 */
export function errorCodeFromMessage(message: string | undefined | null): AcpErrorCode {
  if (!message) return 'UNKNOWN';
  const lower = message.toLowerCase();

  if (lower.includes('install') && (lower.includes('fail') || lower.includes('error'))) {
    return 'AGENT_INSTALL_FAILED';
  }
  if (lower.includes('crash') || lower.includes('exited unexpectedly') || lower.includes('signal')) {
    return 'AGENT_CRASH';
  }
  if (lower.includes('start') && (lower.includes('fail') || lower.includes('error'))) {
    return 'AGENT_START_FAILED';
  }
  if (lower.includes('timeout') && lower.includes('prompt')) {
    return 'PROMPT_TIMEOUT';
  }
  if (lower.includes('auth') || lower.includes('token') || lower.includes('unauthorized')) {
    return 'AUTH_EXPIRED';
  }
  if (lower.includes('container') && lower.includes('not found')) {
    return 'AGENT_ERROR';
  }

  return 'AGENT_ERROR';
}
