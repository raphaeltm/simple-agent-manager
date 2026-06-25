import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ConnectionOverlay } from './ConnectionOverlay';
import {
  encodeTerminalWsInput,
  encodeTerminalWsPing,
  encodeTerminalWsResize,
  parseTerminalWsServerMessage,
} from './protocol';
import { StatusBar } from './StatusBar';
import type { TerminalProps } from './types';
import { useWebSocket } from './useWebSocket';

const MAX_RETRIES = 5;
const PING_INTERVAL_MS = 30_000;

/**
 * Main terminal component with WebSocket connection and automatic reconnection.
 * Uses xterm.js for terminal emulation.
 */
export function Terminal({
  wsUrl,
  resolveWsUrl,
  onActivity,
  className = '',
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const { socket, state, retryCount, retry } = useWebSocket({
    url: wsUrl,
    resolveUrl: resolveWsUrl,
    maxRetries: MAX_RETRIES,
  });

  const connected = state === 'connected';

  // Latest-callback refs so effects don't need to re-run when these change (UE336/UE337/UE338)
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const sendMessage = useCallback((payload: string) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(payload);
  }, []);

  const sendResize = useCallback(() => {
    const term = terminalRef.current;
    if (!connectedRef.current || !sessionIdRef.current || !term) return;
    sendMessage(encodeTerminalWsResize(term.rows, term.cols));
  }, [sendMessage]);

  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const term = terminalRef.current;
    if (!fitAddon || !term) return;

    fitAddon.fit();
    sendResize();
  }, [sendResize]);

  // UE336: Mount-only xterm initialization.
  // Uses refs for callbacks so this effect runs only once (on mount).
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#32344a',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#ad8ee6',
        cyan: '#449dab',
        white: '#787c99',
        brightBlack: '#444b6a',
        brightRed: '#ff7a93',
        brightGreen: '#b9f27c',
        brightYellow: '#ff9e64',
        brightBlue: '#7da6ff',
        brightMagenta: '#bb9af7',
        brightCyan: '#0db9d7',
        brightWhite: '#acb0d0',
      },
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      fontSize: 14,
      lineHeight: 1.2,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle input — read latest callbacks via refs
    terminal.onData((data) => {
      onActivityRef.current?.();
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeTerminalWsInput(data));
      }
    });

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Mount-only: callbacks accessed via refs

  // UE336: Separate resize observer effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onResize = () => handleResize();

    window.addEventListener('resize', onResize);
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
    };
  }, [handleResize]);

  // UE338: WebSocket message subscription.
  // Uses refs for protocol handling so connection changes don't cause resubscription.
  useEffect(() => {
    if (!socket) return;

    const onMessage = (event: MessageEvent) => {
      const term = terminalRef.current;
      if (!term) return;

      if (typeof event.data !== 'string') return;
      const msg = parseTerminalWsServerMessage(event.data);
      if (!msg) return;

      switch (msg.type) {
        case 'output': {
          const data = (msg.data as { data?: unknown } | undefined)?.data;
          if (typeof data === 'string') {
            term.write(data);
          }
          break;
        }
        case 'session': {
          const id = (msg.data as { sessionId?: unknown } | undefined)?.sessionId;
          if (typeof id === 'string') {
            setSessionId(id);
            // Now that the PTY exists, ensure it matches the UI size.
            sendResize();
          }
          break;
        }
        case 'error': {
          const errorText = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
          term.writeln(`\r\n\x1b[31mError: ${errorText}\x1b[0m\r\n`);
          break;
        }
        case 'pong':
          // Heartbeat response.
          break;
      }
    };

    socket.addEventListener('message', onMessage);
    return () => {
      socket.removeEventListener('message', onMessage);
    };
  }, [socket, sendResize]);

  // Heartbeat (keeps intermediaries from idling out the WS; also supported by VM Agent).
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(() => {
      sendMessage(encodeTerminalWsPing());
    }, PING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [connected, sendMessage]);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0" />

        <ConnectionOverlay
          connectionState={state}
          reconnectAttempts={retryCount}
          maxRetries={MAX_RETRIES}
          onRetry={retry}
        />
      </div>

      <StatusBar
        connectionState={state}
        reconnectAttempts={retryCount}
      />
    </div>
  );
}
