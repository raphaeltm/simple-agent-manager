import { useState, useEffect, useCallback, useRef } from 'react';
import { getAdminLogStreamUrl } from '../lib/api';
import type { LogStreamMessage } from '@simple-agent-manager/shared';

export type StreamConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface StreamLogEntry {
  timestamp: string;
  level: string;
  event: string;
  message: string;
  details: Record<string, unknown>;
  scriptName: string;
}

export interface StreamFilterState {
  levels: string[];
  search: string;
}

export interface UseAdminLogStreamReturn {
  entries: StreamLogEntry[];
  state: StreamConnectionState;
  paused: boolean;
  clientCount: number;
  filter: StreamFilterState;
  setLevels: (levels: string[]) => void;
  setSearch: (search: string) => void;
  togglePause: () => void;
  clear: () => void;
  retry: () => void;
}

const DEFAULT_BUFFER_SIZE = 500;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RETRIES = 10;

export function useAdminLogStream(bufferSize = DEFAULT_BUFFER_SIZE): UseAdminLogStreamReturn {
  const [entries, setEntries] = useState<StreamLogEntry[]>([]);
  const [state, setState] = useState<StreamConnectionState>('connecting');
  const [paused, setPaused] = useState(false);
  const [clientCount, setClientCount] = useState(0);
  const [filter, setFilter] = useState<StreamFilterState>({ levels: [], search: '' });

  const socketRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);
  const pausedRef = useRef(false);
  const filterRef = useRef(filter);
  const connectRef = useRef<() => void>(() => {});

  // Keep refs in sync
  filterRef.current = filter;
  pausedRef.current = paused;

  const getReconnectDelay = useCallback((attempt: number) => {
    return Math.min(BASE_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (retriesRef.current >= MAX_RETRIES) {
      setState('disconnected');
      return;
    }

    setState('reconnecting');
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

    setState(retriesRef.current === 0 ? 'connecting' : 'reconnecting');

    // Clean up existing socket
    if (socketRef.current) {
      socketRef.current.close(1000);
      socketRef.current = null;
    }

    const url = getAdminLogStreamUrl();
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close(1000);
          return;
        }
        retriesRef.current = 0;
        setState('connected');

        // Send current filter state to server
        if (filterRef.current.levels.length > 0 || filterRef.current.search) {
          ws.send(JSON.stringify({
            type: 'filter',
            levels: filterRef.current.levels.length > 0 ? filterRef.current.levels : undefined,
            search: filterRef.current.search || undefined,
          }));
        }

        // If paused, send pause to server
        if (pausedRef.current) {
          ws.send(JSON.stringify({ type: 'pause' }));
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;

        let msg: LogStreamMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (msg.type) {
          case 'log':
            if (msg.entry) {
              setEntries((prev) => {
                const next = [...prev, msg.entry!];
                return next.length > bufferSize ? next.slice(next.length - bufferSize) : next;
              });
            }
            break;

          case 'status':
            if (typeof msg.clientCount === 'number') {
              setClientCount(msg.clientCount);
            }
            break;

          case 'pong':
            // Keep-alive response, no action needed
            break;

          case 'error':
            // Server-side error, log for debugging
            console.warn('[useAdminLogStream] Server error:', msg.message);
            break;
        }
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;
        socketRef.current = null;
        if (event.code !== 1000) {
          scheduleReconnect();
        } else {
          setState('disconnected');
        }
      };

      ws.onerror = () => {
        // Error is followed by close event
      };

      socketRef.current = ws;
    } catch {
      scheduleReconnect();
    }
  }, [bufferSize, scheduleReconnect]);

  connectRef.current = connect;

  // Ping keep-alive interval
  useEffect(() => {
    const interval = setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Initial connection
  useEffect(() => {
    mountedRef.current = true;
    connectRef.current();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) {
        socketRef.current.close(1000);
        socketRef.current = null;
      }
    };
  }, []);

  // Send filter changes to server
  const setLevels = useCallback((levels: string[]) => {
    setFilter((prev) => {
      const next = { ...prev, levels };
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'filter',
          levels: levels.length > 0 ? levels : undefined,
          search: next.search || undefined,
        }));
      }
      return next;
    });
  }, []);

  const setSearch = useCallback((search: string) => {
    setFilter((prev) => {
      const next = { ...prev, search };
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'filter',
          levels: next.levels.length > 0 ? next.levels : undefined,
          search: search || undefined,
        }));
      }
      return next;
    });
  }, []);

  const togglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: next ? 'pause' : 'resume' }));
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  const retry = useCallback(() => {
    retriesRef.current = 0;
    clearTimeout(reconnectTimerRef.current);
    connectRef.current();
  }, []);

  return {
    entries,
    state,
    paused,
    clientCount,
    filter,
    setLevels,
    setSearch,
    togglePause,
    clear,
    retry,
  };
}
