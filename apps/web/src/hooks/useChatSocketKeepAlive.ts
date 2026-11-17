import { type RefObject, useEffect } from 'react';

import { PING_INTERVAL_MS, PONG_TIMEOUT_MS } from './chat-websocket-config';

/** Keep the existing socket alive and reconnect after a silent proxy drop. */
export function useChatSocketKeepAlive(
  enabled: boolean,
  wsRef: RefObject<WebSocket | null>,
  pongTimeoutRef: RefObject<ReturnType<typeof setTimeout> | undefined>
) {
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));

        // Start pong deadline — if the server doesn't respond within
        // PONG_TIMEOUT_MS, the connection is silently dead (e.g. Cloudflare
        // proxy dropped it). Force-close with a non-1000 code to trigger
        // the reconnect path in onclose.
        clearTimeout(pongTimeoutRef.current);
        pongTimeoutRef.current = setTimeout(() => {
          const current = wsRef.current;
          if (current && current.readyState === WebSocket.OPEN) {
            current.close(4000, 'pong timeout');
          }
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(pongTimeoutRef.current);
    };
  }, [enabled, wsRef, pongTimeoutRef]);
}
