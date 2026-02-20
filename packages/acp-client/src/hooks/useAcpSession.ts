import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentStatusMessage, AgentSessionStatus, SessionStateMessage, LifecycleEventCallback } from '../transport/types';
import { createAcpWebSocketTransport } from '../transport/websocket';
import type { AcpTransport } from '../transport/websocket';

/** Default reconnection delay in ms */
const DEFAULT_RECONNECT_DELAY_MS = 1000;
/** Default total reconnection timeout in ms */
const DEFAULT_RECONNECT_TIMEOUT_MS = 60000;
/** Default maximum reconnection delay cap in ms */
const DEFAULT_RECONNECT_MAX_DELAY_MS = 16000;

/**
 * Add ±25% jitter to a delay value to prevent thundering-herd reconnections
 * when many clients lose connectivity simultaneously (e.g., server restart).
 */
export function addJitter(delayMs: number): number {
  // jitter range: [0.75 * delay, 1.25 * delay]
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.round(delayMs * jitterFactor);
}

/**
 * Classify a WebSocket close code to determine reconnection strategy.
 *
 * Returns:
 * - 'no-reconnect': The close was clean or the server explicitly rejected us.
 *    Do not reconnect (e.g., auth failure, policy violation).
 * - 'immediate': A transient issue where immediate reconnect is appropriate
 *    (e.g., going-away during server restart, abnormal closure).
 * - 'backoff': An unexpected close where exponential backoff should apply
 *    (e.g., unknown codes, internal errors, service restart).
 */
export type CloseCodeStrategy = 'no-reconnect' | 'immediate' | 'backoff';

export function classifyCloseCode(code: number | undefined): CloseCodeStrategy {
  if (code === undefined) return 'backoff';
  switch (code) {
    // 1000: Normal closure — the server intentionally closed the connection
    case 1000:
      return 'no-reconnect';
    // 1001: Going away — server shutting down or navigating away; retry quickly
    case 1001:
      return 'immediate';
    // 1008: Policy violation — auth failure, bad token; don't retry
    case 1008:
      return 'no-reconnect';
    // 1011: Unexpected condition — server error; back off
    case 1011:
      return 'backoff';
    // 4000: Our custom heartbeat timeout code; retry with backoff
    case 4000:
      return 'backoff';
    // 4001: Custom code — auth expired/invalid; don't retry blindly
    case 4001:
      return 'no-reconnect';
    // 1006: Abnormal closure (no close frame) — network drop; retry immediately
    case 1006:
      return 'immediate';
    default:
      // Unknown codes: use backoff as the safe default
      return 'backoff';
  }
}

/** ACP session state machine */
export type AcpSessionState =
  | 'disconnected'
  | 'connecting'
  | 'no_session'
  | 'initializing'
  | 'replaying'
  | 'ready'
  | 'prompting'
  | 'error'
  | 'reconnecting';

/** Messages received from the agent (ACP JSON-RPC) */
export interface AcpMessage {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  id?: number | string;
  result?: unknown;
  error?: unknown;
}

interface GatewayErrorMessage {
  error: string;
  message?: string;
}

function isGatewayErrorMessage(data: unknown): data is GatewayErrorMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const record = data as Record<string, unknown>;
  return typeof record.error === 'string' &&
    (typeof record.message === 'string' || record.message === undefined);
}

/** Options for the useAcpSession hook */
export interface UseAcpSessionOptions {
  /** WebSocket URL for the ACP gateway (e.g., wss://host/agent/ws?token=JWT) */
  wsUrl: string | null;
  /** Optional resolver to fetch/build a fresh WebSocket URL before connect/reconnect. */
  resolveWsUrl?: () => Promise<string | null> | string | null;
  /** Called when an ACP message is received from the agent */
  onAcpMessage?: (message: AcpMessage) => void;
  /** Optional callback for lifecycle event logging */
  onLifecycleEvent?: LifecycleEventCallback;
  /**
   * Called synchronously when a session_state message with replayCount > 0
   * arrives, BEFORE any replay messages are delivered. Use this to clear
   * conversation items so replay doesn't append to stale state.
   */
  onPrepareForReplay?: () => void;
  /** Initial reconnect delay in ms (default: 2000) */
  reconnectDelayMs?: number;
  /** Total reconnect timeout before giving up in ms (default: 30000) */
  reconnectTimeoutMs?: number;
  /** Maximum delay cap for exponential backoff in ms (default: 16000) */
  reconnectMaxDelayMs?: number;
}

/** Return type of the useAcpSession hook */
export interface AcpSessionHandle {
  /** Current session state */
  state: AcpSessionState;
  /** Currently active agent type (e.g., 'claude-code') */
  agentType: string | null;
  /** Error message if state is 'error' */
  error: string | null;
  /** Whether the session is replaying buffered messages from a late join */
  replaying: boolean;
  /** Switch to a different agent */
  switchAgent: (agentType: string) => void;
  /** Send an ACP JSON-RPC message to the agent */
  sendMessage: (message: unknown) => void;
  /** Whether the WebSocket is connected */
  connected: boolean;
  /** Manually trigger a reconnection attempt */
  reconnect: () => void;
}

/** Extract host from a WebSocket URL for safe logging (no tokens) */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * React hook for managing an ACP session with the VM Agent gateway.
 *
 * Handles:
 * - WebSocket connection to /agent/ws
 * - Agent selection via select_agent control messages
 * - Agent status tracking (starting -> ready -> prompting -> etc.)
 * - Reconnection with exponential backoff on unexpected disconnect
 */
export function useAcpSession(options: UseAcpSessionOptions): AcpSessionHandle {
  const {
    wsUrl,
    resolveWsUrl,
    onAcpMessage,
    onLifecycleEvent,
    onPrepareForReplay,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    reconnectTimeoutMs = DEFAULT_RECONNECT_TIMEOUT_MS,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
  } = options;

  const [state, setState] = useState<AcpSessionState>('disconnected');
  const [agentType, setAgentType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  const transportRef = useRef<AcpTransport | null>(null);
  const onAcpMessageRef = useRef(onAcpMessage);
  onAcpMessageRef.current = onAcpMessage;

  const onLifecycleEventRef = useRef(onLifecycleEvent);
  onLifecycleEventRef.current = onLifecycleEvent;

  const onPrepareForReplayRef = useRef(onPrepareForReplay);
  onPrepareForReplayRef.current = onPrepareForReplay;
  const wsUrlRef = useRef(wsUrl);
  wsUrlRef.current = wsUrl;
  const resolveWsUrlRef = useRef(resolveWsUrl);
  resolveWsUrlRef.current = resolveWsUrl;

  // Track the server-reported status so we can restore it after replay completes.
  // Without this, reconnecting during a prompt transitions replaying → ready,
  // even though the server is still in 'prompting' (deadlocking new prompts).
  const serverStatusRef = useRef<string>('');
  // Track prompt completion observed during replay so replay_complete does not
  // restore a stale prompting snapshot captured before replay started.
  const replaySawPromptDoneRef = useRef(false);
  // Guard against re-entering replay mode after a replay has just completed.
  // Set to true in handleSessionReplayComplete, cleared on new WebSocket connection.
  // Prevents a post-replay session_state with stale replayCount > 0 from
  // triggering prepareForReplay() and wiping all just-replayed messages.
  const replayCompletedRef = useRef(false);
  // Track most recent URL used for connection attempts.
  const connectUrlRef = useRef<string | null>(wsUrl);

  // Reconnection state (refs to avoid re-triggering the effect)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectStartRef = useRef<number>(0);
  const reconnectAttemptRef = useRef<number>(0);
  const intentionalCloseRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const attemptReconnectRef = useRef<() => void>(() => {});

  // Lifecycle logging helper
  const logLifecycle = useCallback((
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>
  ) => {
    onLifecycleEventRef.current?.({ source: 'acp-session', level, message, context });
  }, []);

  // Map VM Agent status to session state
  const handleAgentStatus = useCallback((msg: AgentStatusMessage) => {
    const statusMap: Record<AgentSessionStatus, AcpSessionState> = {
      starting: 'initializing',
      installing: 'initializing',
      ready: 'ready',
      error: 'error',
      restarting: 'initializing',
    };

    const newState = statusMap[msg.status] || 'error';
    setState(newState);
    setAgentType(msg.agentType);

    logLifecycle('info', `Agent status: ${msg.status}`, {
      agentType: msg.agentType,
      status: msg.status,
      mappedState: newState,
      ...(msg.error ? { error: msg.error } : {}),
    });

    if (msg.error) {
      setError(msg.error);
    } else if (newState !== 'error') {
      setError(null);
    }
  }, [logLifecycle]);

  // Handle incoming ACP messages
  const handleAcpMessage = useCallback((data: unknown) => {
    if (isGatewayErrorMessage(data)) {
      logLifecycle('error', 'Gateway error received', {
        error: data.error,
        message: data.message,
      });
      setState('error');
      setError(data.message || data.error);
      return;
    }
    onAcpMessageRef.current?.(data as AcpMessage);
  }, [logLifecycle]);

  // Handle session_state control message from SessionHost on viewer attach.
  // This tells us the current server-side state of the agent session.
  const handleSessionState = useCallback((msg: SessionStateMessage) => {
    logLifecycle('info', 'Session state received', {
      status: msg.status,
      agentType: msg.agentType,
      replayCount: msg.replayCount,
      error: msg.error,
    });

    // Map SessionHost status to our state machine
    const status = msg.status;
    // Remember the server-reported status so handleSessionReplayComplete
    // can restore it (e.g., 'prompting') instead of defaulting to 'ready'.
    serverStatusRef.current = status;

    // Always sync agentType from server state — clear to null when empty/idle
    setAgentType(msg.agentType || null);
    if (msg.error) {
      setError(msg.error);
    } else {
      setError(null);
    }

    if (status === 'idle') {
      // No agent selected yet — equivalent to no_session
      setState('no_session');
      setReplaying(false);
    } else if (status === 'starting') {
      setState('initializing');
      setReplaying(false);
    } else if (status === 'ready' || status === 'prompting') {
      // Agent is running — we'll receive buffered messages, then replay_complete
      if (msg.replayCount > 0 && !replayCompletedRef.current) {
        // Clear conversation items SYNCHRONOUSLY before replay messages arrive.
        // This avoids the race where useEffect-based clear runs after replay
        // messages have already been appended (causing jumbled/duplicate text).
        // The replayCompletedRef guard prevents the post-replay authoritative
        // session_state snapshot (which has stale replayCount > 0) from
        // triggering a second clear that would wipe all just-replayed messages.
        onPrepareForReplayRef.current?.();
        replaySawPromptDoneRef.current = false;
        setState('replaying');
        setReplaying(true);
      } else {
        replaySawPromptDoneRef.current = false;
        setState(status === 'prompting' ? 'prompting' : 'ready');
        setReplaying(false);
      }
    } else if (status === 'error') {
      setState('error');
      setReplaying(false);
    } else if (status === 'stopped') {
      setState('disconnected');
      setReplaying(false);
    } else {
      // Unknown status — treat as no_session
      setState('no_session');
      setReplaying(false);
    }
  }, [logLifecycle]);

  // Handle session_replay_complete — all buffered messages have been delivered
  const handleSessionReplayComplete = useCallback(() => {
    const serverStatus = serverStatusRef.current;
    const sawPromptDone = replaySawPromptDoneRef.current;
    replaySawPromptDoneRef.current = false;
    // Mark replay as completed so subsequent session_state messages with stale
    // replayCount > 0 (e.g., the post-replay authoritative snapshot) do not
    // trigger another prepareForReplay cycle that would wipe all messages.
    replayCompletedRef.current = true;
    logLifecycle('info', 'Session replay complete', { serverStatus, sawPromptDone });
    setReplaying(false);
    // Restore the server-reported status instead of unconditionally going to
    // 'ready'. If the agent was 'prompting' when we reconnected, we must stay
    // in 'prompting' so the input is disabled and the cancel button is shown.
    // Without this, the user can submit a new prompt that deadlocks on the
    // server's promptMu (the previous prompt is still blocking).
    setState((prev) => {
      if (prev !== 'replaying') return prev;
      if (sawPromptDone) return 'ready';
      if (serverStatus === 'prompting') return 'prompting';
      return 'ready';
    });
  }, [logLifecycle]);

  // Handle session prompting state changes
  const handleSessionPrompting = useCallback((prompting: boolean) => {
    logLifecycle('info', `Session prompting: ${prompting}`);
    if (prompting) {
      setState('prompting');
    } else {
      // Mark prompt completion immediately so replay_complete in the same
      // event loop tick can observe it before React flushes state updates.
      replaySawPromptDoneRef.current = true;
      setState((prev) => {
        return prev === 'prompting' ? 'ready' : prev;
      });
    }
  }, [logLifecycle]);

  // Connect to the ACP WebSocket
  const connect = useCallback((url: string) => {
    // Close any stale transport before opening a new connection.
    // This prevents duplicate connections when a reconnect fires while a
    // previous WebSocket is still in CLOSING state.
    if (transportRef.current) {
      intentionalCloseRef.current = true;
      transportRef.current.close();
      transportRef.current = null;
      intentionalCloseRef.current = false;
    }

    const host = safeHost(url);
    const ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      // Reset reconnection state on successful connect
      const wasReconnect = wasConnectedRef.current;
      reconnectAttemptRef.current = 0;
      reconnectStartRef.current = 0;
      wasConnectedRef.current = true;
      // Reset the replay-completed guard so the new connection's first
      // session_state with replayCount > 0 correctly enters replay mode.
      replayCompletedRef.current = false;
      // Stay in 'connecting' until we receive session_state from the server.
      // The server will send session_state immediately after the viewer
      // attaches, telling us whether an agent is already running.
      setState('connecting');
      setError(null);

      logLifecycle('info', 'WebSocket connected, awaiting session_state', { host, wasReconnect });
    });

    const transport = createAcpWebSocketTransport({
      ws,
      onAgentStatus: handleAgentStatus,
      onAcpMessage: handleAcpMessage,
      onSessionState: handleSessionState,
      onSessionReplayComplete: handleSessionReplayComplete,
      onSessionPrompting: handleSessionPrompting,
      onClose(code?: number, reason?: string) {
        // WebSocket closed — attempt reconnection if not intentional
        transportRef.current = null;

        const strategy = classifyCloseCode(code);

        logLifecycle('info', 'WebSocket closed', {
          host,
          code,
          reason,
          strategy,
          intentional: intentionalCloseRef.current,
          wasConnected: wasConnectedRef.current,
        });

        if (intentionalCloseRef.current) {
          setState('disconnected');
          return;
        }

        // Server explicitly rejected us (auth failure, policy) — don't reconnect
        if (strategy === 'no-reconnect') {
          logLifecycle('warn', 'Server closed connection cleanly — not reconnecting', { code, reason });
          setState('disconnected');
          return;
        }

        // Only reconnect if we were previously connected
        if (wasConnectedRef.current) {
          attemptReconnectRef.current();
        } else {
          logLifecycle('error', 'WebSocket connection failed (never connected)', { host, code, reason });
          setState('error');
          setError('WebSocket connection failed');
        }
      },
      onError() {
        // WebSocket error
        logLifecycle('warn', 'WebSocket error event', {
          host,
          wasConnected: wasConnectedRef.current,
          intentionalClose: intentionalCloseRef.current,
        });

        if (!intentionalCloseRef.current && wasConnectedRef.current) {
          // Will be followed by close event which handles reconnection
          return;
        }
        setState('error');
        setError('WebSocket connection error');
      },
      onLifecycleEvent: onLifecycleEventRef.current,
    });

    transportRef.current = transport;
    return transport;
  }, [handleAgentStatus, handleAcpMessage, handleSessionState, handleSessionReplayComplete, handleSessionPrompting, logLifecycle]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveConnectUrl = useCallback((fallbackUrl?: string | null) => {
    if (resolveWsUrlRef.current) {
      return resolveWsUrlRef.current();
    }
    return fallbackUrl ?? wsUrlRef.current;
  }, []);

  const connectWithResolvedUrl = useCallback((fallbackUrl?: string | null): Promise<boolean> => {
    const handleResolved = (resolved: string | null): boolean => {
      if (!resolved) {
        setState('error');
        setError('WebSocket URL unavailable');
        return false;
      }
      connectUrlRef.current = resolved;
      connect(resolved);
      return true;
    };

    const handleError = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : 'Failed to resolve WebSocket URL';
      logLifecycle('warn', 'Failed to resolve WebSocket URL', { error: message });
      setState('error');
      setError(message);
      return false;
    };

    try {
      const resolvedOrPromise = resolveConnectUrl(fallbackUrl);
      if (
        resolvedOrPromise &&
        typeof resolvedOrPromise === 'object' &&
        'then' in resolvedOrPromise
      ) {
        return (resolvedOrPromise as Promise<string | null>)
          .then((resolved) => handleResolved(resolved))
          .catch((err) => handleError(err));
      }
      return Promise.resolve(handleResolved(resolvedOrPromise as string | null));
    } catch (err) {
      return Promise.resolve(handleError(err));
    }
  }, [connect, logLifecycle, resolveConnectUrl]);

  // Attempt reconnection with exponential backoff
  const attemptReconnect = useCallback(() => {
    const now = Date.now();

    // Start the reconnect timer on first attempt
    if (reconnectStartRef.current === 0) {
      reconnectStartRef.current = now;
    }

    // Check total timeout
    const elapsed = now - reconnectStartRef.current;
    if (elapsed >= reconnectTimeoutMs) {
      logLifecycle('error', 'Reconnection timed out', {
        elapsedMs: elapsed,
        timeoutMs: reconnectTimeoutMs,
        totalAttempts: reconnectAttemptRef.current,
      });
      setState('error');
      setError('Reconnection timed out');
      reconnectStartRef.current = 0;
      reconnectAttemptRef.current = 0;
      return;
    }

    setState('reconnecting');
    const attempt = reconnectAttemptRef.current++;
    const baseDelay = Math.min(reconnectDelayMs * Math.pow(2, attempt), reconnectMaxDelayMs);
    // Add ±25% jitter to prevent thundering-herd when many clients reconnect
    const delay = addJitter(baseDelay);

    logLifecycle('info', `Reconnect attempt ${attempt + 1}`, {
      attempt: attempt + 1,
      baseDelayMs: baseDelay,
      jitteredDelayMs: delay,
      elapsedMs: elapsed,
      timeoutMs: reconnectTimeoutMs,
    });

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connectWithResolvedUrl(connectUrlRef.current).then((ok) => {
        if (!ok) {
          attemptReconnectRef.current();
        }
      });
    }, delay);
  }, [reconnectDelayMs, reconnectTimeoutMs, reconnectMaxDelayMs, connectWithResolvedUrl, logLifecycle]);
  attemptReconnectRef.current = attemptReconnect;

  // Main connection effect
  useEffect(() => {
    if (!wsUrl && !resolveWsUrlRef.current) {
      setState('disconnected');
      return;
    }

    intentionalCloseRef.current = false;
    wasConnectedRef.current = false;
    reconnectAttemptRef.current = 0;
    reconnectStartRef.current = 0;

    setState('connecting');
    setError(null);

    logLifecycle('info', 'Initiating connection', {
      host: wsUrl ? safeHost(wsUrl) : 'resolver',
    });
    void connectWithResolvedUrl(wsUrl);

    return () => {
      logLifecycle('info', 'Connection cleanup (intentional close)');
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (transportRef.current) {
        transportRef.current.close();
      }
      transportRef.current = null;
    };
  }, [wsUrl, connectWithResolvedUrl, logLifecycle]);

  // Reconnect immediately when tab becomes visible again (mobile background tab fix)
  useEffect(() => {
    if (!wsUrl && !resolveWsUrlRef.current) return;
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;

      // Only reconnect if we were previously connected and WebSocket is no longer open
      if (!wasConnectedRef.current) return;
      if (transportRef.current?.connected) return;

      logLifecycle('info', 'Tab became visible, triggering reconnect');

      // Cancel any pending backoff timer — reconnect immediately
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      // Reset backoff state for a fresh immediate attempt
      reconnectAttemptRef.current = 0;
      reconnectStartRef.current = 0;
      intentionalCloseRef.current = false;

      setState('reconnecting');
      void connectWithResolvedUrl(connectUrlRef.current);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [wsUrl, connectWithResolvedUrl, logLifecycle]);

  // Manual reconnect (exposed to UI for "Reconnect" button)
  const reconnect = useCallback(() => {
    if (!wsUrl && !resolveWsUrlRef.current) return;
    if (transportRef.current?.connected) return;

    logLifecycle('info', 'Manual reconnect triggered');

    // Close existing transport if any
    if (transportRef.current) {
      intentionalCloseRef.current = true;
      transportRef.current.close();
      transportRef.current = null;
    }

    // Cancel pending timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Reset state and reconnect
    reconnectAttemptRef.current = 0;
    reconnectStartRef.current = 0;
    intentionalCloseRef.current = false;
    wasConnectedRef.current = true; // We want to reconnect
    setError(null);
    setState('reconnecting');
    void connectWithResolvedUrl(connectUrlRef.current);
  }, [wsUrl, connectWithResolvedUrl, logLifecycle]);

  // Switch to a different agent
  const switchAgent = useCallback((newAgentType: string) => {
    if (transportRef.current?.connected) {
      logLifecycle('info', `Switching agent to ${newAgentType}`, { agentType: newAgentType });
      transportRef.current.sendSelectAgent(newAgentType);
      setState('initializing');
      setAgentType(newAgentType);
      setError(null);
    }
  }, [logLifecycle]);

  // Send a raw ACP message
  const sendMessage = useCallback((message: unknown) => {
    if (transportRef.current?.connected) {
      transportRef.current.sendAcpMessage(message);
    }
  }, []);

  return {
    state,
    agentType,
    error,
    replaying,
    switchAgent,
    sendMessage,
    connected: transportRef.current?.connected ?? false,
    reconnect,
  };
}
