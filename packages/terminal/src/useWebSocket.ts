import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConnectionState, UseWebSocketOptions, UseWebSocketReturn } from './types';

/**
 * Hook for managing WebSocket connection with automatic reconnection.
 * Implements exponential backoff for reliability.
 */
export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    url,
    resolveUrl,
    maxRetries = 5,
    baseDelay = 1000,
    maxDelay = 30000,
    onStateChange,
  } = options;

  const [state, setState] = useState<ConnectionState>('connecting');
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retriesRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const socketRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const connectRef = useRef<() => Promise<void>>(async () => {});
  const urlRef = useRef(url);
  const resolveUrlRef = useRef(resolveUrl);
  urlRef.current = url;
  resolveUrlRef.current = resolveUrl;

  // Update state and notify callback
  const updateState = useCallback(
    (newState: ConnectionState) => {
      if (!mountedRef.current) return;
      setState(newState);
      onStateChange?.(newState);
    },
    [onStateChange]
  );

  // Calculate delay with exponential backoff
  const getDelay = useCallback(
    (attempt: number) => {
      return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    },
    [baseDelay, maxDelay]
  );

  const resolveConnectUrl = useCallback(async (): Promise<string | null> => {
    if (resolveUrlRef.current) {
      const resolved = await resolveUrlRef.current();
      if (resolved) {
        return resolved;
      }
    }
    return urlRef.current;
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    if (retriesRef.current < maxRetries) {
      updateState('reconnecting');
      const delay = getDelay(retriesRef.current);
      retriesRef.current++;
      setRetryCount(retriesRef.current);

      reconnectTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          void connectRef.current();
        }
      }, delay);
    } else {
      updateState('failed');
    }
  }, [maxRetries, getDelay, updateState]);

  // Connect to WebSocket
  const connect = useCallback(async () => {
    if (!mountedRef.current) return;

    updateState(retriesRef.current === 0 ? 'connecting' : 'reconnecting');

    // Clean up existing socket
    if (socketRef.current) {
      socketRef.current.close(1000);
      socketRef.current = null;
      setSocket(null);
    }

    let connectUrl: string | null = null;
    try {
      connectUrl = await resolveConnectUrl();
    } catch (error) {
      console.error('WebSocket URL resolution error:', error);
      scheduleReconnect();
      return;
    }

    if (!connectUrl) {
      scheduleReconnect();
      return;
    }

    try {
      const ws = new WebSocket(connectUrl);

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close(1000);
          return;
        }
        retriesRef.current = 0;
        setRetryCount(0);
        updateState('connected');
      };

      ws.onclose = (event) => {
        if (!mountedRef.current) return;

        // Code 1000 = normal closure, don't reconnect
        if (event.code === 1000) {
          return;
        }

        scheduleReconnect();
      };

      ws.onerror = () => {
        // Error will be followed by close event, handle reconnection there
      };

      socketRef.current = ws;
      setSocket(ws);
    } catch (error) {
      console.error('WebSocket connection error:', error);
      scheduleReconnect();
    }
  }, [resolveConnectUrl, scheduleReconnect, updateState]);
  connectRef.current = connect;

  // Manual retry function
  const retry = useCallback(() => {
    retriesRef.current = 0;
    setRetryCount(0);
    clearTimeout(reconnectTimeoutRef.current);
    void connectRef.current();
  }, []);

  // Disconnect and cleanup
  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimeoutRef.current);
    if (socketRef.current) {
      socketRef.current.close(1000);
      socketRef.current = null;
    }
    setSocket(null);
  }, []);

  // Initial connection
  useEffect(() => {
    mountedRef.current = true;
    if (!url && !resolveUrlRef.current) {
      updateState('failed');
      return () => {
        mountedRef.current = false;
        clearTimeout(reconnectTimeoutRef.current);
      };
    }
    void connectRef.current();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimeoutRef.current);
      if (socketRef.current) {
        socketRef.current.close(1000);
      }
    };
  }, [url, updateState]);

  return {
    socket,
    state,
    retryCount,
    retry,
    disconnect,
  };
}
