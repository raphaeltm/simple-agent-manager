import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessageResponse, ChatSessionResponse } from '../lib/api';
import { getChatSession } from '../lib/api';

export type ChatConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;
const PING_INTERVAL_MS = 30000;

interface UseChatWebSocketOptions {
  projectId: string;
  sessionId: string;
  /** Only connect when the session is active. */
  enabled: boolean;
  /** Called when a new message arrives via WebSocket. */
  onMessage: (msg: ChatMessageResponse) => void;
  /** Called when the session is stopped server-side. */
  onSessionStopped: () => void;
  /** Called when we catch up with missed messages after reconnect. */
  onCatchUp: (messages: ChatMessageResponse[], session: ChatSessionResponse, hasMore: boolean) => void;
}

export interface UseChatWebSocketReturn {
  connectionState: ChatConnectionState;
  wsRef: React.RefObject<WebSocket | null>;
  retry: () => void;
}

/**
 * WebSocket hook for chat sessions with exponential backoff reconnection
 * and message catch-up on reconnect (TDF-8).
 *
 * Follows the same pattern as useAdminLogStream for consistency.
 */
export function useChatWebSocket({
  projectId,
  sessionId,
  enabled,
  onMessage,
  onSessionStopped,
  onCatchUp,
}: UseChatWebSocketOptions): UseChatWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ChatConnectionState>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});
  const hadConnectionRef = useRef(false);

  // Keep callbacks stable via refs
  const onMessageRef = useRef(onMessage);
  const onSessionStoppedRef = useRef(onSessionStopped);
  const onCatchUpRef = useRef(onCatchUp);
  onMessageRef.current = onMessage;
  onSessionStoppedRef.current = onSessionStopped;
  onCatchUpRef.current = onCatchUp;

  const getReconnectDelay = useCallback((attempt: number) => {
    return Math.min(BASE_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (retriesRef.current >= MAX_RETRIES) {
      setConnectionState('disconnected');
      return;
    }

    setConnectionState('reconnecting');
    const delay = getReconnectDelay(retriesRef.current);
    retriesRef.current++;

    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        connectRef.current();
      }
    }, delay);
  }, [getReconnectDelay]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    setConnectionState(retriesRef.current === 0 ? 'connecting' : 'reconnecting');

    // Clean up existing socket
    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }

    const API_URL = import.meta.env.VITE_API_URL || '';
    const wsUrl = API_URL.replace(/^http/, 'ws') + `/api/projects/${projectId}/sessions/ws`;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close(1000);
          return;
        }
        const wasReconnect = hadConnectionRef.current;
        retriesRef.current = 0;
        setConnectionState('connected');
        hadConnectionRef.current = true;

        // On reconnect, fetch missed messages via REST
        if (wasReconnect) {
          void catchUpMessages();
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;

        try {
          const data = JSON.parse(event.data);
          if (data.type === 'message.new' && data.sessionId === sessionId) {
            const newMsg: ChatMessageResponse = {
              id: data.id || crypto.randomUUID(),
              sessionId: data.sessionId,
              role: data.role,
              content: data.content,
              toolMetadata: data.toolMetadata || null,
              createdAt: data.createdAt || Date.now(),
            };
            onMessageRef.current(newMsg);
          } else if (data.type === 'session.stopped' && data.sessionId === sessionId) {
            onSessionStoppedRef.current();
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;
        wsRef.current = null;
        if (event.code !== 1000) {
          scheduleReconnect();
        } else {
          setConnectionState('disconnected');
        }
      };

      ws.onerror = () => {
        // Error is followed by close event
      };

      wsRef.current = ws;
    } catch {
      scheduleReconnect();
    }
  }, [projectId, sessionId, scheduleReconnect]);

  connectRef.current = connect;

  const catchUpMessages = useCallback(async () => {
    try {
      const data = await getChatSession(projectId, sessionId);
      onCatchUpRef.current(data.messages, data.session, data.hasMore);
    } catch {
      // Best-effort catch-up — poll fallback will handle it
    }
  }, [projectId, sessionId]);

  // Ping keep-alive
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  // Connection lifecycle
  useEffect(() => {
    if (!enabled) {
      // Disconnect when disabled
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
      clearTimeout(reconnectTimerRef.current);
      setConnectionState('disconnected');
      hadConnectionRef.current = false;
      retriesRef.current = 0;
      return;
    }

    mountedRef.current = true;
    connectRef.current();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
    };
  }, [enabled, projectId, sessionId]);

  const retry = useCallback(() => {
    retriesRef.current = 0;
    hadConnectionRef.current = false;
    clearTimeout(reconnectTimerRef.current);
    connectRef.current();
  }, []);

  return {
    connectionState,
    wsRef,
    retry,
  };
}
