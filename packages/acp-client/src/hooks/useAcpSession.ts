import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentStatusMessage, AgentSessionStatus } from '../transport/types';
import { createAcpWebSocketTransport } from '../transport/websocket';
import type { AcpTransport } from '../transport/websocket';

/** Default reconnection delay in ms */
const DEFAULT_RECONNECT_DELAY_MS = 2000;
/** Default total reconnection timeout in ms */
const DEFAULT_RECONNECT_TIMEOUT_MS = 30000;
/** Default maximum reconnection delay cap in ms */
const DEFAULT_RECONNECT_MAX_DELAY_MS = 16000;

/** ACP session state machine */
export type AcpSessionState =
  | 'disconnected'
  | 'connecting'
  | 'no_session'
  | 'initializing'
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

/** Options for the useAcpSession hook */
export interface UseAcpSessionOptions {
  /** WebSocket URL for the ACP gateway (e.g., wss://host/agent/ws?token=JWT) */
  wsUrl: string | null;
  /** Called when an ACP message is received from the agent */
  onAcpMessage?: (message: AcpMessage) => void;
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
  /** Switch to a different agent */
  switchAgent: (agentType: string) => void;
  /** Send an ACP JSON-RPC message to the agent */
  sendMessage: (message: unknown) => void;
  /** Whether the WebSocket is connected */
  connected: boolean;
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
    onAcpMessage,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    reconnectTimeoutMs = DEFAULT_RECONNECT_TIMEOUT_MS,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
  } = options;

  const [state, setState] = useState<AcpSessionState>('disconnected');
  const [agentType, setAgentType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transportRef = useRef<AcpTransport | null>(null);
  const onAcpMessageRef = useRef(onAcpMessage);
  onAcpMessageRef.current = onAcpMessage;

  // Reconnection state (refs to avoid re-triggering the effect)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectStartRef = useRef<number>(0);
  const reconnectAttemptRef = useRef<number>(0);
  const intentionalCloseRef = useRef(false);
  const wasConnectedRef = useRef(false);

  // Map VM Agent status to session state
  const handleAgentStatus = useCallback((msg: AgentStatusMessage) => {
    const statusMap: Record<AgentSessionStatus, AcpSessionState> = {
      starting: 'initializing',
      ready: 'ready',
      error: 'error',
      restarting: 'initializing',
    };

    const newState = statusMap[msg.status] || 'error';
    setState(newState);
    setAgentType(msg.agentType);

    if (msg.error) {
      setError(msg.error);
    } else if (newState !== 'error') {
      setError(null);
    }
  }, []);

  // Handle incoming ACP messages
  const handleAcpMessage = useCallback((data: unknown) => {
    onAcpMessageRef.current?.(data as AcpMessage);
  }, []);

  // Connect to the ACP WebSocket
  const connect = useCallback((url: string) => {
    const ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      // Reset reconnection state on successful connect
      reconnectAttemptRef.current = 0;
      reconnectStartRef.current = 0;
      wasConnectedRef.current = true;
      setState('no_session');
    });

    const transport = createAcpWebSocketTransport(
      ws,
      handleAgentStatus,
      handleAcpMessage,
      () => {
        // WebSocket closed — attempt reconnection if not intentional
        transportRef.current = null;
        if (intentionalCloseRef.current) {
          setState('disconnected');
          return;
        }

        // Only reconnect if we were previously connected
        if (wasConnectedRef.current) {
          attemptReconnect(url);
        } else {
          setState('error');
          setError('WebSocket connection failed');
        }
      },
      () => {
        // WebSocket error
        if (!intentionalCloseRef.current && wasConnectedRef.current) {
          // Will be followed by close event which handles reconnection
          return;
        }
        setState('error');
        setError('WebSocket connection error');
      }
    );

    transportRef.current = transport;
    return transport;
  }, [handleAgentStatus, handleAcpMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attempt reconnection with exponential backoff
  const attemptReconnect = useCallback((url: string) => {
    const now = Date.now();

    // Start the reconnect timer on first attempt
    if (reconnectStartRef.current === 0) {
      reconnectStartRef.current = now;
    }

    // Check total timeout
    const elapsed = now - reconnectStartRef.current;
    if (elapsed >= reconnectTimeoutMs) {
      setState('error');
      setError('Reconnection timed out');
      reconnectStartRef.current = 0;
      reconnectAttemptRef.current = 0;
      return;
    }

    setState('reconnecting');
    const attempt = reconnectAttemptRef.current++;
    const delay = Math.min(reconnectDelayMs * Math.pow(2, attempt), reconnectMaxDelayMs);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect(url);
    }, delay);
  }, [reconnectDelayMs, reconnectTimeoutMs, reconnectMaxDelayMs, connect]);

  // Main connection effect
  useEffect(() => {
    if (!wsUrl) {
      setState('disconnected');
      return;
    }

    intentionalCloseRef.current = false;
    wasConnectedRef.current = false;
    reconnectAttemptRef.current = 0;
    reconnectStartRef.current = 0;

    setState('connecting');
    setError(null);

    const transport = connect(wsUrl);

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      transport.close();
      transportRef.current = null;
    };
  }, [wsUrl, connect]);

  // Switch to a different agent
  const switchAgent = useCallback((newAgentType: string) => {
    if (transportRef.current?.connected) {
      transportRef.current.sendSelectAgent(newAgentType);
      setState('initializing');
      setAgentType(newAgentType);
      setError(null);
    }
  }, []);

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
    switchAgent,
    sendMessage,
    connected: transportRef.current?.connected ?? false,
  };
}
