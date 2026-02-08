import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from './Terminal';
import { TabBar } from './components/TabBar';
import { useTerminalSessions } from './hooks/useTerminalSessions';
import {
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

/**
 * Multi-terminal container component
 * Manages multiple terminal sessions with tabbed interface
 */
export const MultiTerminal: React.FC<MultiTerminalProps> = ({
  wsUrl,
  shutdownDeadline,
  onActivity,
  className = '',
  config,
}) => {
  // Load configuration from environment or props
  const terminalConfig: TerminalConfig = {
    maxSessions: config?.maxSessions ||
                 parseInt(import.meta.env.VITE_MAX_TERMINAL_SESSIONS || '10'),
    tabSwitchAnimationMs: config?.tabSwitchAnimationMs ||
                         parseInt(import.meta.env.VITE_TAB_SWITCH_ANIMATION_MS || '200'),
    scrollbackLines: config?.scrollbackLines ||
                    parseInt(import.meta.env.VITE_TERMINAL_SCROLLBACK_LINES || '1000'),
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

  // WebSocket connection management
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const terminalsRef = useRef<Map<string, any>>(new Map()); // Terminal instances

  // Connect to WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('MultiTerminal WebSocket connected');
        setWsConnected(true);

        // Create initial terminal session
        if (sessions.size === 0) {
          handleNewTab();
        }
      };

      ws.onmessage = (event) => {
        const msg = parseTerminalWsServerMessage(event.data);
        if (!msg) return;

        // Route messages to appropriate handlers
        if (isSessionCreatedMessage(msg) && msg.data) {
          const { sessionId, workingDirectory } = msg.data;
          // Update session status to connected
          const session = sessions.get(sessionId);
          if (session) {
            session.status = 'connected';
            session.workingDirectory = workingDirectory;
          }
        } else if (isSessionClosedMessage(msg) && msg.data) {
          const { sessionId } = msg.data;
          closeSession(sessionId);
        } else if (isOutputMessage(msg) && msg.sessionId) {
          // Route output to specific terminal
          const terminal = terminalsRef.current.get(msg.sessionId);
          if (terminal && msg.data?.data) {
            terminal.write(msg.data.data);
          }
        } else if (isErrorMessage(msg)) {
          console.error('Terminal error:', msg.data);
        }

        // Notify activity
        if (onActivity) {
          onActivity();
        }
      };

      ws.onerror = (error) => {
        console.error('MultiTerminal WebSocket error:', error);
        setWsConnected(false);
      };

      ws.onclose = () => {
        console.log('MultiTerminal WebSocket closed');
        setWsConnected(false);

        // Attempt reconnection after delay
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, 3000);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      setWsConnected(false);
    }
  }, [wsUrl, sessions, closeSession, onActivity]);

  // Initial connection
  useEffect(() => {
    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connectWebSocket]);

  // Handle new tab creation
  const handleNewTab = useCallback(() => {
    if (!canCreateSession) return;

    const sessionId = createSession();

    // Send create session message to server
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = encodeTerminalWsCreateSession(
        sessionId,
        24, // Default rows
        80, // Default cols
        `Terminal ${sessions.size + 1}`
      );
      wsRef.current.send(message);
    }

    return sessionId;
  }, [canCreateSession, createSession, sessions.size]);

  // Handle tab close
  const handleCloseTab = useCallback((sessionId: string) => {
    // Send close session message to server
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = encodeTerminalWsCloseSession(sessionId);
      wsRef.current.send(message);
    }

    // Remove terminal instance
    terminalsRef.current.delete(sessionId);

    // Close session locally
    closeSession(sessionId);
  }, [closeSession]);

  // Handle tab rename
  const handleRenameTab = useCallback((sessionId: string, name: string) => {
    renameSession(sessionId, name);

    // Send rename message to server
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = encodeTerminalWsRenameSession(sessionId, name);
      wsRef.current.send(message);
    }
  }, [renameSession]);

  // Register terminal instance
  const registerTerminal = useCallback((sessionId: string, terminal: any) => {
    terminalsRef.current.set(sessionId, terminal);
  }, []);

  // Unregister terminal instance
  const unregisterTerminal = useCallback((sessionId: string) => {
    terminalsRef.current.delete(sessionId);
  }, []);

  // Convert sessions map to array for TabBar
  const sessionsArray = Array.from(sessions.values());

  return (
    <div className={`multi-terminal-container ${className}`}>
      <TabBar
        sessions={sessionsArray}
        activeSessionId={activeSessionId}
        onTabActivate={activateSession}
        onTabClose={handleCloseTab}
        onTabRename={handleRenameTab}
        onNewTab={handleNewTab}
        maxTabs={terminalConfig.maxSessions}
      />

      <div className="multi-terminal-content">
        {sessionsArray.map((session) => (
          <div
            key={session.id}
            className={`terminal-wrapper ${
              session.id === activeSessionId ? 'active' : 'inactive'
            }`}
            style={{ display: session.id === activeSessionId ? 'block' : 'none' }}
          >
            {wsConnected && session.status === 'connected' && (
              <Terminal
                wsUrl={wsUrl}
                shutdownDeadline={shutdownDeadline}
                onActivity={onActivity}
                className="terminal-instance"
              />
            )}
            {!wsConnected && (
              <div className="terminal-status-message">
                Connecting to terminal...
              </div>
            )}
            {wsConnected && session.status === 'connecting' && (
              <div className="terminal-status-message">
                Creating terminal session...
              </div>
            )}
            {session.status === 'error' && (
              <div className="terminal-status-message error">
                Terminal connection error. Please try again.
              </div>
            )}
          </div>
        ))}

        {sessions.size === 0 && (
          <div className="terminal-empty-state">
            <p>No terminal sessions</p>
            <button onClick={handleNewTab} disabled={!canCreateSession}>
              Create New Terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
};