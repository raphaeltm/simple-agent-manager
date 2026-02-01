import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConnectionState, UseWebSocketOptions, UseWebSocketReturn } from './types';

/**
 * Hook for managing WebSocket connection with automatic reconnection.
 * Implements exponential backoff for reliability.
 */
export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    url,
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

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Clean up existing socket
    if (socketRef.current) {
      socketRef.current.close(1000);
    }

    updateState(retriesRef.current === 0 ? 'connecting' : 'reconnecting');

    try {
      const ws = new WebSocket(url);

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

        // Attempt reconnection
        if (retriesRef.current < maxRetries) {
          updateState('reconnecting');
          const delay = getDelay(retriesRef.current);
          retriesRef.current++;
          setRetryCount(retriesRef.current);

          reconnectTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              connect();
            }
          }, delay);
        } else {
          updateState('failed');
        }
      };

      ws.onerror = () => {
        // Error will be followed by close event, handle reconnection there
      };

      socketRef.current = ws;
      setSocket(ws);
    } catch (error) {
      console.error('WebSocket connection error:', error);
      updateState('failed');
    }
  }, [url, maxRetries, getDelay, updateState]);

  // Manual retry function
  const retry = useCallback(() => {
    retriesRef.current = 0;
    setRetryCount(0);
    clearTimeout(reconnectTimeoutRef.current);
    connect();
  }, [connect]);

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
    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimeoutRef.current);
      if (socketRef.current) {
        socketRef.current.close(1000);
      }
    };
  }, [connect]);

  return {
    socket,
    state,
    retryCount,
    retry,
    disconnect,
  };
}
