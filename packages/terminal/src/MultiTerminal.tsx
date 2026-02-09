import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TabBar } from './components/TabBar';
import { useTerminalSessions } from './hooks/useTerminalSessions';
import {
  encodeTerminalWsInput,
  encodeTerminalWsResize,
  encodeTerminalWsPing,
  encodeTerminalWsCreateSession,
  encodeTerminalWsCloseSession,
  encodeTerminalWsRenameSession,
  parseTerminalWsServerMessage,
  isSessionCreatedMessage,
  isSessionClosedMessage,
  isOutputMessage,
  isErrorMessage,
} from './protocol';
import type { MultiTerminalProps, TerminalConfig } from './types/multi-terminal';

import '@xterm/xterm/css/xterm.css';

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 3000;

/** xterm.js instance + FitAddon pair for a session */
interface TerminalInstance {
  terminal: XTerm;
  fitAddon: FitAddon;
  containerEl: HTMLDivElement | null;
}

/**
 * Multi-terminal container component.
 * Maintains a SINGLE shared WebSocket using the multi-session protocol.
 * Each tab has its own raw xterm.js instance for rendering.
 */
export const MultiTerminal: React.FC<MultiTerminalProps> = (props) => {
  const { wsUrl, onActivity, className = '', config } = props;
  const terminalConfig: TerminalConfig = {
    maxSessions: config?.maxSessions || 10,
    tabSwitchAnimationMs: config?.tabSwitchAnimationMs || 200,
    scrollbackLines: config?.scrollbackLines || 1000,
    shortcuts: config?.shortcuts || {
      newTab: 'Ctrl+Shift+T',
      closeTab: 'Ctrl+Shift+W',
      nextTab: 'Ctrl+Tab',
      previousTab: 'Ctrl+Shift+Tab',
      jumpToTab: 'Alt+{n}',
    },
  };

  const {
    sessions,
    activeSessionId,
    createSession,
    closeSession,
    activateSession,
    renameSession,
    canCreateSession,
    updateSessionStatus,
    updateSessionWorkingDirectory,
  } = useTerminalSessions(terminalConfig.maxSessions);

  // Refs that persist across renders
  const wsRef = useRef<WebSocket | null>(null);
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const [wsConnected, setWsConnected] = useState(false);

  // ── Stable refs for latest callback/state versions ──
  // This prevents re-creating the WebSocket connection when callbacks change reference.
  // The WS event handlers read from latestRef.current to always get the latest versions.
  const latestRef = useRef({
    createSession,
    closeSession,
    updateSessionStatus,
    updateSessionWorkingDirectory,
    onActivity,
    sessions,
  });
  latestRef.current = {
    createSession,
    closeSession,
    updateSessionStatus,
    updateSessionWorkingDirectory,
    onActivity,
    sessions,
  };

  // Create xterm.js instance for a session (stable — only depends on scrollback config)
  const createTerminalInstance = useCallback((sessionId: string): TerminalInstance => {
    const terminal = new XTerm({
      cursorBlink: true,
      scrollback: terminalConfig.scrollbackLines,
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

    // Handle user input — route through shared WebSocket with sessionId
    terminal.onData((data) => {
      latestRef.current.onActivity?.();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeTerminalWsInput(data, sessionId));
      }
    });

    const instance: TerminalInstance = { terminal, fitAddon, containerEl: null };
    terminalsRef.current.set(sessionId, instance);
    return instance;
  }, [terminalConfig.scrollbackLines]);

  // Destroy xterm.js instance (completely stable)
  const destroyTerminalInstance = useCallback((sessionId: string) => {
    const instance = terminalsRef.current.get(sessionId);
    if (instance) {
      instance.terminal.dispose();
      terminalsRef.current.delete(sessionId);
    }
  }, []);

  // Handle new tab creation
  const handleNewTab = useCallback(() => {
    const sessionId = latestRef.current.createSession();
    createTerminalInstance(sessionId);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeTerminalWsCreateSession(sessionId, 24, 80));
    }
    return sessionId;
  }, [createTerminalInstance]);

  // Handle tab close
  const handleCloseTab = useCallback((sessionId: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeTerminalWsCloseSession(sessionId));
    }
    destroyTerminalInstance(sessionId);
    latestRef.current.closeSession(sessionId);
  }, [destroyTerminalInstance]);

  // Handle tab rename
  const handleRenameTab = useCallback((sessionId: string, name: string) => {
    renameSession(sessionId, name);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeTerminalWsRenameSession(sessionId, name));
    }
  }, [renameSession]);

  // ── WebSocket connection lifecycle ──
  // This single effect manages the ENTIRE WebSocket: connect, message routing,
  // ping heartbeat, and reconnection. It only re-runs when wsUrl changes.
  useEffect(() => {
    let disposed = false;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let pingInterval: ReturnType<typeof setInterval>;
    let currentWs: WebSocket | null = null;

    function connect() {
      if (disposed) return;

      try {
        const ws = new WebSocket(wsUrl);
        currentWs = ws;

        ws.onopen = () => {
          if (disposed) { ws.close(); return; }
          setWsConnected(true);
          wsRef.current = ws;

          // Start ping heartbeat
          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(encodeTerminalWsPing());
            }
          }, PING_INTERVAL_MS);

          // Create initial terminal session if none exist
          if (latestRef.current.sessions.size === 0) {
            const sessionId = latestRef.current.createSession();
            createTerminalInstance(sessionId);
            ws.send(encodeTerminalWsCreateSession(sessionId, 24, 80));
          } else {
            // Re-create server-side sessions for existing tabs after reconnect
            for (const [sessionId] of terminalsRef.current) {
              ws.send(encodeTerminalWsCreateSession(sessionId, 24, 80));
            }
          }
        };

        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') return;
          const msg = parseTerminalWsServerMessage(event.data);
          if (!msg) return;

          if (isSessionCreatedMessage(msg) && msg.data) {
            latestRef.current.updateSessionStatus(msg.data.sessionId, 'connected');
            if (msg.data.workingDirectory) {
              latestRef.current.updateSessionWorkingDirectory(msg.data.sessionId, msg.data.workingDirectory);
            }
          } else if (isSessionClosedMessage(msg) && msg.data) {
            destroyTerminalInstance(msg.data.sessionId);
            latestRef.current.closeSession(msg.data.sessionId);
          } else if (isOutputMessage(msg) && msg.sessionId) {
            const instance = terminalsRef.current.get(msg.sessionId);
            if (instance && msg.data?.data) {
              instance.terminal.write(msg.data.data);
            }
          } else if (isErrorMessage(msg)) {
            if (msg.sessionId) {
              latestRef.current.updateSessionStatus(msg.sessionId, 'error');
              const instance = terminalsRef.current.get(msg.sessionId);
              const errorText = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
              if (instance) {
                instance.terminal.writeln(`\r\n\x1b[31mError: ${errorText}\x1b[0m\r\n`);
              }
            }
          }

          latestRef.current.onActivity?.();
        };

        ws.onerror = () => {
          setWsConnected(false);
        };

        ws.onclose = () => {
          setWsConnected(false);
          wsRef.current = null;
          clearInterval(pingInterval);
          if (!disposed) {
            reconnectTimeout = setTimeout(connect, RECONNECT_DELAY_MS);
          }
        };
      } catch {
        setWsConnected(false);
        if (!disposed) {
          reconnectTimeout = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      }
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimeout);
      clearInterval(pingInterval);
      if (currentWs) currentWs.close();
      wsRef.current = null;
      // Dispose all terminal instances
      for (const [, instance] of terminalsRef.current) {
        instance.terminal.dispose();
      }
      terminalsRef.current.clear();
    };
  }, [wsUrl, createTerminalInstance, destroyTerminalInstance]);

  // Attach/fit xterm.js to DOM container via ref callback
  const attachTerminal = useCallback((sessionId: string, containerEl: HTMLDivElement | null) => {
    const instance = terminalsRef.current.get(sessionId);
    if (!instance) return;

    if (containerEl && instance.containerEl !== containerEl) {
      instance.containerEl = containerEl;
      // Open the terminal into the container if not already opened
      if (!containerEl.querySelector('.xterm')) {
        instance.terminal.open(containerEl);
      }
      instance.fitAddon.fit();

      // Send resize to server so PTY matches
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeTerminalWsResize(instance.terminal.rows, instance.terminal.cols, sessionId));
      }
    }
  }, []);

  // Fit active terminal on window resize
  useEffect(() => {
    const handleResize = () => {
      if (!activeSessionId) return;
      const instance = terminalsRef.current.get(activeSessionId);
      if (instance && instance.containerEl) {
        instance.fitAddon.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeTerminalWsResize(instance.terminal.rows, instance.terminal.cols, activeSessionId));
        }
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeSessionId]);

  // When active tab changes, fit the terminal
  useEffect(() => {
    if (!activeSessionId) return;
    const instance = terminalsRef.current.get(activeSessionId);
    if (instance && instance.containerEl) {
      // Small delay to allow DOM to render the visible container
      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        instance.terminal.focus();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeTerminalWsResize(instance.terminal.rows, instance.terminal.cols, activeSessionId));
        }
      });
    }
  }, [activeSessionId]);

  const sessionsArray = Array.from(sessions.values());

  return (
    <div className={`multi-terminal-container ${className}`} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TabBar
        sessions={sessionsArray}
        activeSessionId={activeSessionId}
        onTabActivate={activateSession}
        onTabClose={handleCloseTab}
        onTabRename={handleRenameTab}
        onNewTab={handleNewTab}
        maxTabs={terminalConfig.maxSessions}
      />

      <div className="multi-terminal-content" style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {sessionsArray.map((session) => (
          <div
            key={session.id}
            style={{
              display: session.id === activeSessionId ? 'block' : 'none',
              position: 'absolute',
              inset: 0,
            }}
          >
            {wsConnected && (session.status === 'connected' || session.status === 'connecting') ? (
              <div
                ref={(el) => attachTerminal(session.id, el)}
                style={{ width: '100%', height: '100%' }}
              />
            ) : !wsConnected ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: '#a9b1d6', backgroundColor: '#1a1b26',
              }}>
                Connecting to terminal...
              </div>
            ) : session.status === 'error' ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: '#f7768e', backgroundColor: '#1a1b26',
              }}>
                Terminal connection error. Please try again.
              </div>
            ) : null}
          </div>
        ))}

        {sessions.size === 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: '#a9b1d6', backgroundColor: '#1a1b26', gap: '16px',
          }}>
            <p>No terminal sessions</p>
            <button
              onClick={handleNewTab}
              disabled={!canCreateSession}
              style={{
                padding: '8px 16px', border: '1px solid #7aa2f7', borderRadius: '4px',
                backgroundColor: 'transparent', color: '#7aa2f7', cursor: 'pointer',
              }}
            >
              Create New Terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
