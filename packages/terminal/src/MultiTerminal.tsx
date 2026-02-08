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
  } = useTerminalSessions(terminalConfig.maxSessions);

  // Refs that persist across renders
  const wsRef = useRef<WebSocket | null>(null);
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const pingIntervalRef = useRef<ReturnType<typeof setInterval>>();
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const [wsConnected, setWsConnected] = useState(false);

  // Helper: update session status in the hook state
  const updateSessionStatus = useCallback((sessionId: string, status: 'connecting' | 'connected' | 'error', workDir?: string) => {
    // We access sessions via ref to avoid stale closure
    const session = sessionsRef.current.get(sessionId);
    if (session) {
      session.status = status;
      if (workDir) session.workingDirectory = workDir;
    }
  }, []);

  // Create xterm.js instance for a session
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
      onActivity?.();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeTerminalWsInput(data, sessionId));
      }
    });

    const instance: TerminalInstance = { terminal, fitAddon, containerEl: null };
    terminalsRef.current.set(sessionId, instance);
    return instance;
  }, [onActivity, terminalConfig.scrollbackLines]);

  // Destroy xterm.js instance
  const destroyTerminalInstance = useCallback((sessionId: string) => {
    const instance = terminalsRef.current.get(sessionId);
    if (instance) {
      instance.terminal.dispose();
      terminalsRef.current.delete(sessionId);
    }
  }, []);

  // Send a create_session message to the server
  const sendCreateSession = useCallback((sessionId: string, name?: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeTerminalWsCreateSession(sessionId, 24, 80, name));
    }
  }, []);

  // Handle new tab creation
  const handleNewTab = useCallback(() => {
    if (!canCreateSession) return;
    const sessionId = createSession();
    createTerminalInstance(sessionId);
    sendCreateSession(sessionId);
    return sessionId;
  }, [canCreateSession, createSession, createTerminalInstance, sendCreateSession]);

  // Handle tab close
  const handleCloseTab = useCallback((sessionId: string) => {
    // Send close to server
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeTerminalWsCloseSession(sessionId));
    }
    destroyTerminalInstance(sessionId);
    closeSession(sessionId);
  }, [closeSession, destroyTerminalInstance]);

  // Handle tab rename
  const handleRenameTab = useCallback((sessionId: string, name: string) => {
    renameSession(sessionId, name);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeTerminalWsRenameSession(sessionId, name));
    }
  }, [renameSession]);

  // Connect to WebSocket (multi-session endpoint)
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setWsConnected(true);

        // Create initial terminal session if none exist
        if (sessionsRef.current.size === 0) {
          const sessionId = createSession();
          createTerminalInstance(sessionId);
          sendCreateSession(sessionId);
        }
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const msg = parseTerminalWsServerMessage(event.data);
        if (!msg) return;

        if (isSessionCreatedMessage(msg) && msg.data) {
          updateSessionStatus(msg.data.sessionId, 'connected', msg.data.workingDirectory);
        } else if (isSessionClosedMessage(msg) && msg.data) {
          destroyTerminalInstance(msg.data.sessionId);
          closeSession(msg.data.sessionId);
        } else if (isOutputMessage(msg) && msg.sessionId) {
          const instance = terminalsRef.current.get(msg.sessionId);
          if (instance && msg.data?.data) {
            instance.terminal.write(msg.data.data);
          }
        } else if (isErrorMessage(msg)) {
          if (msg.sessionId) {
            updateSessionStatus(msg.sessionId, 'error');
            const instance = terminalsRef.current.get(msg.sessionId);
            const errorText = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
            if (instance) {
              instance.terminal.writeln(`\r\n\x1b[31mError: ${errorText}\x1b[0m\r\n`);
            }
          }
        }

        onActivity?.();
      };

      ws.onerror = () => {
        setWsConnected(false);
      };

      ws.onclose = () => {
        setWsConnected(false);
        // Attempt reconnection
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, RECONNECT_DELAY_MS);
      };

      wsRef.current = ws;
    } catch {
      setWsConnected(false);
    }
  }, [wsUrl, createSession, createTerminalInstance, sendCreateSession, closeSession, destroyTerminalInstance, updateSessionStatus, onActivity]);

  // Initial connection
  useEffect(() => {
    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (wsRef.current) wsRef.current.close();
      // Dispose all terminal instances
      for (const [, instance] of terminalsRef.current) {
        instance.terminal.dispose();
      }
      terminalsRef.current.clear();
    };
  }, [connectWebSocket]);

  // Heartbeat ping
  useEffect(() => {
    if (!wsConnected) {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      return;
    }
    pingIntervalRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeTerminalWsPing());
      }
    }, PING_INTERVAL_MS);
    return () => {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    };
  }, [wsConnected]);

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
              <div className="terminal-status-message" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: '#a9b1d6', backgroundColor: '#1a1b26',
              }}>
                Connecting to terminal...
              </div>
            ) : session.status === 'error' ? (
              <div className="terminal-status-message error" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: '#f7768e', backgroundColor: '#1a1b26',
              }}>
                Terminal connection error. Please try again.
              </div>
            ) : null}
          </div>
        ))}

        {sessions.size === 0 && (
          <div className="terminal-empty-state" style={{
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
