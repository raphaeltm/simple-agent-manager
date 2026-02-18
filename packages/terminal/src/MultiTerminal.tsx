import React, { useEffect, useRef, useState, useCallback, useImperativeHandle } from 'react';
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
  encodeTerminalWsListSessions,
  encodeTerminalWsReattachSession,
  parseTerminalWsServerMessage,
  isSessionCreatedMessage,
  isSessionClosedMessage,
  isOutputMessage,
  isErrorMessage,
  isSessionReattachedMessage,
  isScrollbackMessage,
  isSessionListMessage,
} from './protocol';
import type {
  MultiTerminalProps,
  MultiTerminalHandle,
  MultiTerminalSessionSnapshot,
  TerminalConfig,
} from './types/multi-terminal';

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
export const MultiTerminal = React.forwardRef<MultiTerminalHandle, MultiTerminalProps>(
  (props, ref) => {
    const {
      wsUrl,
      resolveWsUrl,
      defaultWorkDir,
      onActivity,
      className = '',
      config,
      persistenceKey,
      hideTabBar = false,
      onSessionsChange,
    } = props;
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
      updateServerSessionId,
      getPersistedSessions,
    } = useTerminalSessions(terminalConfig.maxSessions, persistenceKey);

    // Refs that persist across renders
    const wsRef = useRef<WebSocket | null>(null);
    const wsUrlRef = useRef(wsUrl);
    wsUrlRef.current = wsUrl;
    const resolveWsUrlRef = useRef(resolveWsUrl);
    resolveWsUrlRef.current = resolveWsUrl;
    const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
    const [wsConnected, setWsConnected] = useState(false);
    // Guard against duplicate list_sessions requests during rapid reconnect cycles
    const reconnectingRef = useRef(false);

    // ── Stable refs for latest callback/state versions ──
    // This prevents re-creating the WebSocket connection when callbacks change reference.
    // The WS event handlers read from latestRef.current to always get the latest versions.
    const latestRef = useRef({
      createSession,
      closeSession,
      updateSessionStatus,
      updateSessionWorkingDirectory,
      updateServerSessionId,
      onActivity,
      sessions,
      getPersistedSessions,
      defaultWorkDir,
    });
    latestRef.current = {
      createSession,
      closeSession,
      updateSessionStatus,
      updateSessionWorkingDirectory,
      updateServerSessionId,
      onActivity,
      sessions,
      getPersistedSessions,
      defaultWorkDir,
    };

    const resolveLocalSessionId = useCallback((sessionId?: string): string | null => {
      if (!sessionId) return null;
      if (latestRef.current.sessions.has(sessionId)) return sessionId;
      for (const [localId, localSession] of latestRef.current.sessions.entries()) {
        if (localSession.serverSessionId === sessionId) {
          return localId;
        }
      }
      return null;
    }, []);

    const getOutboundSessionId = useCallback((localSessionId: string): string => {
      const localSession = latestRef.current.sessions.get(localSessionId);
      return localSession?.serverSessionId ?? localSessionId;
    }, []);

    // Create xterm.js instance for a session (stable — only depends on scrollback config)
    const createTerminalInstance = useCallback(
      (sessionId: string): TerminalInstance => {
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
            ws.send(encodeTerminalWsInput(data, getOutboundSessionId(sessionId)));
          }
        });

        const instance: TerminalInstance = { terminal, fitAddon, containerEl: null };
        terminalsRef.current.set(sessionId, instance);
        return instance;
      },
      [getOutboundSessionId, terminalConfig.scrollbackLines]
    );

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
        ws.send(
          encodeTerminalWsCreateSession(
            sessionId,
            24,
            80,
            undefined,
            latestRef.current.defaultWorkDir
          )
        );
      }
      return sessionId;
    }, [createTerminalInstance]);

    // Handle tab close
    const handleCloseTab = useCallback(
      (sessionId: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeTerminalWsCloseSession(getOutboundSessionId(sessionId)));
        }
        destroyTerminalInstance(sessionId);
        latestRef.current.closeSession(sessionId);
      },
      [destroyTerminalInstance, getOutboundSessionId]
    );

    // Handle tab rename
    const handleRenameTab = useCallback(
      (sessionId: string, name: string) => {
        renameSession(sessionId, name);
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeTerminalWsRenameSession(getOutboundSessionId(sessionId), name));
        }
      },
      [getOutboundSessionId, renameSession]
    );

    // ── WebSocket connection lifecycle ──
    // This single effect manages the ENTIRE WebSocket: connect, message routing,
    // ping heartbeat, and reconnection. It resolves a fresh URL before reconnect.
    useEffect(() => {
      let disposed = false;
      let reconnectTimeout: ReturnType<typeof setTimeout>;
      let pingInterval: ReturnType<typeof setInterval>;
      let currentWs: WebSocket | null = null;

      const scheduleReconnect = () => {
        if (disposed) return;
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
          void connect();
        }, RECONNECT_DELAY_MS);
      };

      const resolveConnectUrl = async (): Promise<string | null> => {
        if (resolveWsUrlRef.current) {
          const resolved = await resolveWsUrlRef.current();
          if (resolved) {
            return resolved;
          }
        }
        return wsUrlRef.current;
      };

      const connect = async () => {
        if (disposed) return;

        let connectUrl: string | null = null;
        try {
          connectUrl = await resolveConnectUrl();
        } catch {
          setWsConnected(false);
          scheduleReconnect();
          return;
        }

        if (!connectUrl) {
          setWsConnected(false);
          scheduleReconnect();
          return;
        }

        try {
          const ws = new WebSocket(connectUrl);
          currentWs = ws;

          ws.onopen = () => {
            if (disposed) {
              ws.close();
              return;
            }
            setWsConnected(true);
            wsRef.current = ws;

            // Start ping heartbeat
            pingInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodeTerminalWsPing());
              }
            }, PING_INTERVAL_MS);

            // Always ask for the authoritative server-side session list on connect.
            // Guard: if a previous reconnect is still pending, skip duplicate list_sessions.
            if (reconnectingRef.current) return;
            reconnectingRef.current = true;
            ws.send(encodeTerminalWsListSessions());
          };

          ws.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            const msg = parseTerminalWsServerMessage(event.data);
            if (!msg) return;

            if (isSessionListMessage(msg) && msg.data) {
              // Clear reconnecting guard — response received
              reconnectingRef.current = false;

              const serverSessions = msg.data.sessions
                .filter((s) => s.status !== 'exited')
                .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
              const serverMap = new Map(serverSessions.map((s) => [s.sessionId, s]));

              const currentSessions = Array.from(latestRef.current.sessions.entries());
              const pendingLocalSessions: Array<{
                localId: string;
                name: string;
                serverSessionId?: string;
              }> = currentSessions.map(([localId, localSession]) => ({
                localId,
                name: localSession.name,
                serverSessionId: localSession.serverSessionId,
              }));

              if (pendingLocalSessions.length === 0) {
                const persisted = latestRef.current.getPersistedSessions();
                const sortedPersisted = persisted
                  ? [...persisted].sort((a, b) => a.order - b.order)
                  : [];
                const hasPersistedServerIds = sortedPersisted.some((entry) =>
                  Boolean(entry.serverSessionId)
                );

                if (
                  sortedPersisted.length > 0 &&
                  (hasPersistedServerIds || serverSessions.length === 0)
                ) {
                  for (const entry of sortedPersisted) {
                    const localId = latestRef.current.createSession(entry.name);
                    createTerminalInstance(localId);
                    latestRef.current.updateSessionStatus(localId, 'reconnecting');
                    if (entry.serverSessionId) {
                      latestRef.current.updateServerSessionId(localId, entry.serverSessionId);
                    }
                    pendingLocalSessions.push({
                      localId,
                      name: entry.name,
                      serverSessionId: entry.serverSessionId,
                    });
                  }
                }
              }

              if (pendingLocalSessions.length === 0 && serverSessions.length === 0) {
                const sessionId = latestRef.current.createSession();
                createTerminalInstance(sessionId);
                ws.send(
                  encodeTerminalWsCreateSession(
                    sessionId,
                    24,
                    80,
                    undefined,
                    latestRef.current.defaultWorkDir
                  )
                );
              } else {
                for (const localSession of pendingLocalSessions) {
                  const serverId = localSession.serverSessionId;
                  const serverInfo = serverId ? serverMap.get(serverId) : undefined;

                  if (serverId && serverInfo) {
                    latestRef.current.updateSessionStatus(localSession.localId, 'reconnecting');
                    if (serverInfo.workingDirectory) {
                      latestRef.current.updateSessionWorkingDirectory(
                        localSession.localId,
                        serverInfo.workingDirectory
                      );
                    }
                    const instance = terminalsRef.current.get(localSession.localId);
                    const rows = instance?.terminal?.rows ?? 24;
                    const cols = instance?.terminal?.cols ?? 80;
                    ws.send(encodeTerminalWsReattachSession(serverId, rows, cols));
                    serverMap.delete(serverId);
                  } else {
                    ws.send(
                      encodeTerminalWsCreateSession(
                        localSession.localId,
                        24,
                        80,
                        localSession.name,
                        latestRef.current.defaultWorkDir
                      )
                    );
                  }
                }

                // Server has sessions not represented locally (e.g. no local cache after reload).
                for (const serverInfo of serverMap.values()) {
                  const localId = latestRef.current.createSession(serverInfo.name);
                  createTerminalInstance(localId);
                  latestRef.current.updateSessionStatus(localId, 'reconnecting');
                  latestRef.current.updateServerSessionId(localId, serverInfo.sessionId);
                  if (serverInfo.workingDirectory) {
                    latestRef.current.updateSessionWorkingDirectory(
                      localId,
                      serverInfo.workingDirectory
                    );
                  }
                  const instance = terminalsRef.current.get(localId);
                  const rows = instance?.terminal?.rows ?? 24;
                  const cols = instance?.terminal?.cols ?? 80;
                  ws.send(encodeTerminalWsReattachSession(serverInfo.sessionId, rows, cols));
                }
              }
            } else if (isSessionReattachedMessage(msg) && msg.data) {
              // Find the local session that maps to this server session ID
              const serverId = msg.data.sessionId;
              const localId = resolveLocalSessionId(serverId);
              if (localId) {
                latestRef.current.updateSessionStatus(localId, 'connected');
                if (msg.data.workingDirectory) {
                  latestRef.current.updateSessionWorkingDirectory(
                    localId,
                    msg.data.workingDirectory
                  );
                }
              }
            } else if (isScrollbackMessage(msg) && msg.sessionId && msg.data) {
              // Find the local session mapped to this server session ID and write scrollback
              const localId = resolveLocalSessionId(msg.sessionId);
              if (localId) {
                const instance = terminalsRef.current.get(localId);
                if (instance && msg.data.data) {
                  instance.terminal.write(msg.data.data);
                }
              }
            } else if (isSessionCreatedMessage(msg) && msg.data) {
              const localId = resolveLocalSessionId(msg.data.sessionId) ?? msg.data.sessionId;
              latestRef.current.updateSessionStatus(localId, 'connected');
              // Store the server session ID for future reconnection matching
              latestRef.current.updateServerSessionId(localId, msg.data.sessionId);
              if (msg.data.workingDirectory) {
                latestRef.current.updateSessionWorkingDirectory(localId, msg.data.workingDirectory);
              }
            } else if (isSessionClosedMessage(msg) && msg.data) {
              const localId = resolveLocalSessionId(msg.data.sessionId) ?? msg.data.sessionId;
              destroyTerminalInstance(localId);
              latestRef.current.closeSession(localId);
            } else if (isOutputMessage(msg) && msg.sessionId) {
              // Output can come with server session ID — route to the right local terminal
              const targetLocalId = resolveLocalSessionId(msg.sessionId) ?? msg.sessionId;
              const instance = terminalsRef.current.get(targetLocalId);
              if (instance && msg.data?.data) {
                instance.terminal.write(msg.data.data);
              }
            } else if (isErrorMessage(msg)) {
              if (msg.sessionId) {
                const localId = resolveLocalSessionId(msg.sessionId) ?? msg.sessionId;
                latestRef.current.updateSessionStatus(localId, 'error');
                const instance = terminalsRef.current.get(localId);
                const errorText =
                  typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
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
            reconnectingRef.current = false;
            clearInterval(pingInterval);
            scheduleReconnect();
          };
        } catch {
          setWsConnected(false);
          scheduleReconnect();
        }
      };

      void connect();

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
    }, [wsUrl, createTerminalInstance, destroyTerminalInstance, resolveLocalSessionId]);

    // Attach/fit xterm.js to DOM container via ref callback
    const attachTerminal = useCallback(
      (sessionId: string, containerEl: HTMLDivElement | null) => {
        const instance = terminalsRef.current.get(sessionId);
        if (!instance) return;

        if (containerEl && instance.containerEl !== containerEl) {
          instance.containerEl = containerEl;
          if (!containerEl.querySelector('.xterm')) {
            instance.terminal.open(containerEl);
          }
          instance.fitAddon.fit();

          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              encodeTerminalWsResize(
                instance.terminal.rows,
                instance.terminal.cols,
                getOutboundSessionId(sessionId)
              )
            );
          }
        }
      },
      [getOutboundSessionId]
    );

    // Fit active terminal on window resize
    useEffect(() => {
      const handleResize = () => {
        if (!activeSessionId) return;
        const instance = terminalsRef.current.get(activeSessionId);
        if (instance && instance.containerEl) {
          instance.fitAddon.fit();
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              encodeTerminalWsResize(
                instance.terminal.rows,
                instance.terminal.cols,
                getOutboundSessionId(activeSessionId)
              )
            );
          }
        }
      };
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, [activeSessionId, getOutboundSessionId]);

    // When active tab changes, fit the terminal
    useEffect(() => {
      if (!activeSessionId) return;
      const instance = terminalsRef.current.get(activeSessionId);
      if (instance && instance.containerEl) {
        requestAnimationFrame(() => {
          instance.fitAddon.fit();
          instance.terminal.focus();
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              encodeTerminalWsResize(
                instance.terminal.rows,
                instance.terminal.cols,
                getOutboundSessionId(activeSessionId)
              )
            );
          }
        });
      }
    }, [activeSessionId, getOutboundSessionId]);

    const sessionsArray = Array.from(sessions.values());

    useImperativeHandle(
      ref,
      () => ({
        createSession: (): string | null => {
          if (!canCreateSession) {
            return null;
          }
          return handleNewTab();
        },
        activateSession: (sessionId: string) => {
          activateSession(sessionId);
        },
        closeSession: (sessionId: string) => {
          handleCloseTab(sessionId);
        },
        renameSession: (sessionId: string, name: string) => {
          handleRenameTab(sessionId, name);
        },
        focus: () => {
          if (activeSessionId) {
            const instance = terminalsRef.current.get(activeSessionId);
            instance?.terminal.focus();
          }
        },
      }),
      [
        activeSessionId,
        activateSession,
        canCreateSession,
        handleCloseTab,
        handleNewTab,
        handleRenameTab,
      ]
    );

    useEffect(() => {
      if (!onSessionsChange) return;

      const snapshots: MultiTerminalSessionSnapshot[] = sessionsArray
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((session) => ({
          id: session.id,
          name: session.name,
          status: session.status,
          workingDirectory: session.workingDirectory,
          serverSessionId: session.serverSessionId,
        }));

      onSessionsChange(snapshots, activeSessionId);
    }, [activeSessionId, onSessionsChange, sessionsArray]);

    return (
      <div
        className={`multi-terminal-container ${className}`}
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      >
        {!hideTabBar && (
          <TabBar
            sessions={sessionsArray}
            activeSessionId={activeSessionId}
            onTabActivate={activateSession}
            onTabClose={handleCloseTab}
            onTabRename={handleRenameTab}
            onNewTab={handleNewTab}
            maxTabs={terminalConfig.maxSessions}
          />
        )}

        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {sessionsArray.map((session) => (
            <div
              key={session.id}
              style={{
                display: session.id === activeSessionId ? 'block' : 'none',
                position: 'absolute',
                inset: 0,
              }}
            >
              {/* Terminal container — keep DOM alive across WS disconnects (T033) */}
              {session.status === 'error' ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: '#f7768e',
                    backgroundColor: '#1a1b26',
                  }}
                >
                  Terminal connection error. Please try again.
                </div>
              ) : terminalsRef.current.has(session.id) || wsConnected ? (
                <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                  <div
                    ref={(el) => attachTerminal(session.id, el)}
                    style={{ width: '100%', height: '100%' }}
                  />
                  {/* Per-terminal reconnecting overlay (T028) */}
                  {(session.status === 'reconnecting' ||
                    (!wsConnected && session.status !== 'connecting')) && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(26, 27, 38, 0.7)',
                        color: '#7aa2f7',
                        fontSize: '14px',
                        zIndex: 10,
                      }}
                    >
                      Reconnecting...
                    </div>
                  )}
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: '#a9b1d6',
                    backgroundColor: '#1a1b26',
                  }}
                >
                  Connecting to terminal...
                </div>
              )}
            </div>
          ))}

          {sessions.size === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#a9b1d6',
                backgroundColor: '#1a1b26',
                gap: '16px',
              }}
            >
              <p>No terminal sessions</p>
              <button
                onClick={handleNewTab}
                disabled={!canCreateSession}
                style={{
                  padding: '8px 16px',
                  border: '1px solid #7aa2f7',
                  borderRadius: '4px',
                  backgroundColor: 'transparent',
                  color: '#7aa2f7',
                  cursor: 'pointer',
                }}
              >
                Create New Terminal
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
);

MultiTerminal.displayName = 'MultiTerminal';
