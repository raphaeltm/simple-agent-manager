import type { BootLogEntry } from '@simple-agent-manager/shared';
import { useEffect, useRef, useState } from 'react';

import { getTerminalToken } from '../lib/api';

interface BootLogWSMessage {
  type: 'log' | 'complete';
  step: string;
  status: string;
  message: string;
  detail?: string;
  timestamp: string;
}

interface UseBootLogStreamResult {
  logs: BootLogEntry[];
  connected: boolean;
}

/**
 * Closes the WebSocket stored in wsRef and resets connected state.
 * Extracted as a plain function (not a callback) to avoid putting it
 * in useEffect dependency arrays, which was a source of unnecessary re-renders.
 */
function cleanupWebSocket(
  wsRef: React.RefObject<WebSocket | null>,
  setConnected: React.Dispatch<React.SetStateAction<boolean>>
): void {
  if (wsRef.current) {
    wsRef.current.close();
    wsRef.current = null;
  }
  setConnected(false);
}

/**
 * Hook that manages a WebSocket connection to the VM agent's /boot-log/ws
 * endpoint during workspace creation, providing real-time boot log streaming.
 *
 * Falls back gracefully: if the WebSocket can't connect (VM not ready yet),
 * the caller should still display polled logs from workspace.bootLogs.
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

  // Unmount cleanup — mountedRef is already true from useRef(true) initialization
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      cleanupWebSocket(wsRef, setConnected);
    };
  }, []);

  useEffect(() => {
    // Only connect during workspace creation
    if (status !== 'creating' || !workspaceId || !workspaceUrl) {
      cleanupWebSocket(wsRef, setConnected);
      return;
    }

    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      try {
        const { token } = await getTerminalToken(workspaceId);
        if (cancelled || !mountedRef.current) return;

        const url = new URL(workspaceUrl);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${url.host}/boot-log/ws?token=${encodeURIComponent(token)}&workspace=${encodeURIComponent(workspaceId!)}`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!cancelled && mountedRef.current) {
            setConnected(true);
          }
        };

        ws.onmessage = (event) => {
          if (cancelled || !mountedRef.current) return;
          try {
            const msg: BootLogWSMessage = JSON.parse(event.data);
            if (msg.type === 'complete') {
              // Bootstrap finished — close connection
              ws.close();
              return;
            }
            if (msg.type === 'log') {
              const entry: BootLogEntry = {
                step: msg.step,
                status: msg.status as BootLogEntry['status'],
                message: msg.message,
                detail: msg.detail,
                timestamp: msg.timestamp,
              };
              setLogs((prev) => [...prev, entry]);
            }
          } catch {
            // Ignore malformed messages
          }
        };

        ws.onclose = () => {
          if (!cancelled && mountedRef.current) {
            setConnected(false);
            wsRef.current = null;
          }
        };

        ws.onerror = () => {
          // Will trigger onclose
        };
      } catch {
        // Token fetch failed (workspace not ready yet) — retry after a delay
        if (!cancelled && mountedRef.current) {
          retryTimeout = setTimeout(() => {
            if (!cancelled && mountedRef.current) {
              void connect();
            }
          }, 3000);
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
      cleanupWebSocket(wsRef, setConnected);
    };
  }, [workspaceId, workspaceUrl, status]);

  // Reset logs when workspace changes or status leaves 'creating'
  useEffect(() => {
    if (status !== 'creating') {
      setLogs([]);
    }
  }, [status, workspaceId]);

  return { logs, connected };
}
