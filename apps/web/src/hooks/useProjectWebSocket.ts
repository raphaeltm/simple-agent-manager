import { useCallback, useEffect, useRef, useState } from 'react';

export type ProjectConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;
const PING_INTERVAL_MS = 30000;
/** Debounce rapid session events to avoid excessive API calls. */
const SESSION_EVENT_DEBOUNCE_MS = 500;

/** Session lifecycle event types the hook listens for. */
const SESSION_LIFECYCLE_EVENTS = new Set([
  'session.created',
  'session.stopped',
  'session.updated',
  'session.agent_completed',
]);

interface UseProjectWebSocketOptions {
  projectId: string;
  /** Called (debounced) when any session lifecycle event arrives. */
  onSessionChange: () => void;
}

export interface UseProjectWebSocketReturn {
  connectionState: ProjectConnectionState;
}

/**
 * Project-wide WebSocket hook for sidebar session list updates.
 *
 * Connects WITHOUT a sessionId query param so the socket is "untagged" and
 * receives ALL events broadcast by the ProjectData DO — both project-wide
 * broadcasts and session-scoped broadcasts (which are also sent to untagged
 * sockets). Session lifecycle events trigger a debounced callback to refresh
 * the session list.
 */
export function useProjectWebSocket({
  projectId,
  onSessionChange,
}: UseProjectWebSocketOptions): UseProjectWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ProjectConnectionState>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});

  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;

  const debouncedSessionChange = useCallback(() => {
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      onSessionChangeRef.current();
    }, SESSION_EVENT_DEBOUNCE_MS);
  }, []);

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

    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }

    const API_URL = import.meta.env.VITE_API_URL || '';
    // No sessionId param — socket is untagged and receives all project events
    const wsUrl = API_URL.replace(/^http/, 'ws') + `/api/projects/${projectId}/sessions/ws`;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close(1000);
          return;
        }
        retriesRef.current = 0;
        setConnectionState('connected');
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current || wsRef.current !== ws) return;

        try {
          const data = JSON.parse(event.data as string) as { type?: string };
          if (data.type && SESSION_LIFECYCLE_EVENTS.has(data.type)) {
            debouncedSessionChange();
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
  }, [projectId, scheduleReconnect, debouncedSessionChange]);

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
      clearTimeout(debounceTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
    };
  }, [projectId]);

  return { connectionState };
}
