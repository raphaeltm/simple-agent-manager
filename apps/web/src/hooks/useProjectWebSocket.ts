import { useCallback, useEffect, useRef, useState } from 'react';

import { expectJsonRecord } from '../lib/runtime-validation';

export type SessionEventType =
  | 'session.created'
  | 'session.stopped'
  | 'session.failed'
  | 'session.updated'
  | 'session.agent_completed'
  | 'session.activity';

export interface RawSessionEvent {
  type: SessionEventType;
  payload: Record<string, unknown>;
}

export type ProjectConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;
const PING_INTERVAL_MS = 30000;

/** Session lifecycle event types the hook routes as typed deltas. */
const SESSION_DELTA_EVENTS = new Set([
  'session.created',
  'session.stopped',
  'session.failed',
  'session.updated',
  'session.agent_completed',
  'session.activity',
]);

interface UseProjectWebSocketOptions {
  projectId: string;
  /** Called with raw session delta events for incremental state updates. */
  onSessionEvent?: (event: RawSessionEvent) => void;
  /** Called on reconnect so the consumer can do a full refetch to re-sync. */
  onReconnected?: () => void;
}

export interface UseProjectWebSocketReturn {
  connectionState: ProjectConnectionState;
}

/**
 * Project-wide WebSocket hook for sidebar session list updates.
 *
 * Connects WITHOUT a sessionId query param so the socket is "untagged" and
 * receives ALL events broadcast by the ProjectData DO. Session lifecycle
 * events are forwarded as typed deltas via `onSessionEvent` for incremental
 * state updates. On reconnect, `onReconnected` is called so the consumer
 * can do a full refetch to re-sync.
 */
export function useProjectWebSocket({
  projectId,
  onSessionEvent,
  onReconnected,
}: UseProjectWebSocketOptions): UseProjectWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ProjectConnectionState>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});

  const onSessionEventRef = useRef(onSessionEvent);
  onSessionEventRef.current = onSessionEvent;
  const onReconnectedRef = useRef(onReconnected);
  onReconnectedRef.current = onReconnected;

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

    const isReconnect = retriesRef.current > 0;
    setConnectionState(isReconnect ? 'reconnecting' : 'connecting');

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
        const wasReconnect = retriesRef.current > 0;
        retriesRef.current = 0;
        setConnectionState('connected');
        if (wasReconnect) {
          onReconnectedRef.current?.();
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current || wsRef.current !== ws) return;

        try {
          const data = expectJsonRecord(JSON.parse(String(event.data)), 'project.websocket.message');
          const type = typeof data.type === 'string' ? data.type : '';
          if (SESSION_DELTA_EVENTS.has(type)) {
            const payload = (typeof data.payload === 'object' && data.payload !== null)
              ? data.payload as Record<string, unknown>
              : {};
            onSessionEventRef.current?.({ type: type as SessionEventType, payload });
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;
        if (wsRef.current !== ws) return;
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
  }, [projectId, scheduleReconnect]);

  connectRef.current = connect;

  // Ping keep-alive
  useEffect(() => {
    const interval = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Connection lifecycle
  useEffect(() => {
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
  }, [projectId]);

  return { connectionState };
}
