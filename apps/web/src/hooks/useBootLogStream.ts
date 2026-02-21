import { useState, useEffect, useRef, useCallback } from 'react';
import type { BootLogEntry } from '@simple-agent-manager/shared';
import { getTerminalToken } from '../lib/api';

/**
 * WebSocket message from the vm-agent boot-log endpoint.
 * Matches the BootLogWSEntry struct in bootlog_ws.go.
 */
interface BootLogWSMessage {
  type: 'log' | 'complete';
  step?: string;
  status?: string;
  message?: string;
  detail?: string;
  timestamp?: string;
}

/** Delay before retrying a failed WebSocket connection. */
const RECONNECT_DELAY_MS = 3_000;

/** Maximum number of reconnection attempts. */
const MAX_RECONNECT_ATTEMPTS = 10;

interface UseBootLogStreamResult {
  /** Accumulated boot log entries from the WebSocket stream. */
  logs: BootLogEntry[];
  /** Whether the WebSocket is currently connected. */
  connected: boolean;
}

/**
 * Hook that streams boot log entries from the VM agent via WebSocket during
 * workspace creation. Falls back gracefully — if the WebSocket cannot connect
 * (e.g., VM not yet provisioned), the caller should use the polled KV logs.
 *
 * The hook:
 * 1. Fetches a terminal token (now allowed for "creating" workspaces)
 * 2. Connects to wss://ws-{id}.{domain}/boot-log/ws?token={token}
 * 3. Accumulates BootLogEntry[] from incoming messages
 * 4. Cleans up when workspace transitions away from "creating"
 */
export function useBootLogStream(
  workspaceId: string | undefined,
  workspaceUrl: string | undefined,
  status: string | undefined
): UseBootLogStreamResult {
  const [logs, setLogs] = useState<BootLogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
  }, []);

  const connect = useCallback(
    async (id: string, url: string) => {
      if (!mountedRef.current || completedRef.current) return;

      // Fetch a terminal token for authentication.
      let token: string;
      try {
        const resp = await getTerminalToken(id);
        token = resp.token;
      } catch {
        // Token fetch failed — VM agent may not be ready yet. Retry later.
        if (
          mountedRef.current &&
          !completedRef.current &&
          reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS
        ) {
          reconnectAttempts.current++;
          reconnectTimer.current = setTimeout(() => {
            void connect(id, url);
          }, RECONNECT_DELAY_MS);
        }
        return;
      }

      if (!mountedRef.current || completedRef.current) return;

      // Build WebSocket URL from the workspace HTTP URL.
      try {
        const wsUrl = new URL(url);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl.pathname = '/boot-log/ws';
        wsUrl.searchParams.set('token', token);

        const ws = new WebSocket(wsUrl.toString());
        wsRef.current = ws;

        ws.onopen = () => {
          if (mountedRef.current) {
            setConnected(true);
            reconnectAttempts.current = 0;
          }
        };

        ws.onmessage = (event) => {
          if (!mountedRef.current) return;

          try {
            const msg: BootLogWSMessage = JSON.parse(event.data as string);

            if (msg.type === 'complete') {
              completedRef.current = true;
              cleanup();
              return;
            }

            if (msg.type === 'log' && msg.step && msg.status && msg.message) {
              const entry: BootLogEntry = {
                step: msg.step,
                status: msg.status as BootLogEntry['status'],
                message: msg.message,
                detail: msg.detail,
                timestamp: msg.timestamp || new Date().toISOString(),
              };
              setLogs((prev) => [...prev, entry]);
            }
          } catch {
            // Ignore malformed messages
          }
        };

        ws.onclose = () => {
          if (!mountedRef.current) return;
          setConnected(false);

          // Reconnect if not completed and under retry limit.
          if (
            !completedRef.current &&
            reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS
          ) {
            reconnectAttempts.current++;
            reconnectTimer.current = setTimeout(() => {
              void connect(id, url);
            }, RECONNECT_DELAY_MS);
          }
        };

        ws.onerror = () => {
          // onerror is always followed by onclose, so we handle reconnection there.
        };
      } catch {
        // URL construction failed — shouldn't happen but handle gracefully.
      }
    },
    [cleanup]
  );

  useEffect(() => {
    mountedRef.current = true;

    if (status !== 'creating' || !workspaceId || !workspaceUrl) {
      cleanup();
      return;
    }

    // Reset state for a new creation session.
    completedRef.current = false;
    reconnectAttempts.current = 0;
    setLogs([]);

    void connect(workspaceId, workspaceUrl);

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [status, workspaceId, workspaceUrl, connect, cleanup]);

  return { logs, connected };
}
