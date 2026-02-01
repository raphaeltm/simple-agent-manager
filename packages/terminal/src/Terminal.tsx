import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AttachAddon } from '@xterm/addon-attach';
import type { TerminalProps } from './types';
import { useWebSocket } from './useWebSocket';
import { StatusBar } from './StatusBar';
import { ConnectionOverlay } from './ConnectionOverlay';

import '@xterm/xterm/css/xterm.css';

const MAX_RETRIES = 5;

/**
 * Main terminal component with WebSocket connection and automatic reconnection.
 * Uses xterm.js for terminal emulation.
 */
export function Terminal({
  wsUrl,
  shutdownDeadline,
  onActivity,
  className = '',
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const attachAddonRef = useRef<AttachAddon | null>(null);

  const { socket, state, retryCount, retry } = useWebSocket({
    url: wsUrl,
    maxRetries: MAX_RETRIES,
  });

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

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

    // Track user activity
    terminal.onData(() => {
      onActivity?.();
    });

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onActivity]);

  // Attach WebSocket when connected
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !socket || state !== 'connected') return;

    // Dispose of previous attach addon
    if (attachAddonRef.current) {
      attachAddonRef.current.dispose();
    }

    const attachAddon = new AttachAddon(socket);
    terminal.loadAddon(attachAddon);
    attachAddonRef.current = attachAddon;

    // Fit terminal after connection
    fitAddonRef.current?.fit();

    return () => {
      attachAddon.dispose();
      attachAddonRef.current = null;
    };
  }, [socket, state]);

  // Refit terminal when container size changes
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });

    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, []);

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
        shutdownDeadline={shutdownDeadline}
        reconnectAttempts={retryCount}
      />
    </div>
  );
}
