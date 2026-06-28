import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { TabBar } from './components/TabBar';
import { useTerminalSessions } from './hooks/useTerminalSessions';
import {
  encodeTerminalWsCloseSession,
  encodeTerminalWsCreateSession,
  encodeTerminalWsInput,
  encodeTerminalWsListSessions,
  encodeTerminalWsPing,
  encodeTerminalWsReattachSession,
  encodeTerminalWsRenameSession,
  encodeTerminalWsResize,
  isErrorMessage,
  isOutputMessage,
  isScrollbackMessage,
  isSessionClosedMessage,
  isSessionCreatedMessage,
  isSessionListMessage,
  isSessionReattachedMessage,
  parseTerminalWsServerMessage,
} from './protocol';
import { colors, fonts, xtermTheme } from './terminal-tokens';
import type {
  MultiTerminalHandle,
  MultiTerminalProps,
  MultiTerminalSessionSnapshot,
  TerminalConfig,
} from './types/multi-terminal';

const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 3000;

/** xterm.js instance + FitAddon pair for a session */
interface TerminalInstance {
  terminal: XTerm;
  fitAddon: FitAddon;
  containerEl: HTMLDivElement | null;
  resizeObserver: ResizeObserver | null;
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
    } = useTerminalSessions(terminalConfig.maxSessions, persistenceKey, wsUrl);

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
          theme: xtermTheme,
          fontFamily: fonts.terminal,
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

        const instance: TerminalInstance = { terminal, fitAddon, containerEl: null, resizeObserver: null };
        terminalsRef.current.set(sessionId, instance);
        return instance;
      },
      [getOutboundSessionId, terminalConfig.scrollbackLines]
    );

    // Destroy xterm.js instance (completely stable)
    const destroyTerminalInstance = useCallback((sessionId: string) => {
      const instance = terminalsRef.current.get(sessionId);
      if (instance) {
        if (instance.resizeObserver) {
          instance.resizeObserver.disconnect();
          instance.resizeObserver = null;
        }
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

    // UE332: Session reconciliation handler — extracted from main WS effect.
    // Matches incoming server session list to local terminal instances,
    // restores persisted sessions, and creates/reattaches as needed.
    const handleSessionList = useCallback(
      (
        ws: WebSocket,
        serverSessionsList: Array<{
          sessionId: string;
          name?: string;
          status?: string;
          createdAt: string;
          workingDirectory?: string;
        }>
      ) => {
        // Clear reconnecting guard — response received
        reconnectingRef.current = false;

        const serverSessions = serverSessionsList
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
      },
      [createTerminalInstance]
    );

    // ── WebSocket connection lifecycle (UE332) ──
    // Core WebSocket connect/disconnect/reconnect and message routing.
    // Heartbeat is handled by a separate effect below.
    useEffect(() => {
      let disposed = false;
      let reconnectTimeout: ReturnType<typeof setTimeout>;
      let currentWs: WebSocket | null = null;
      // Capture ref value at effect creation time so the cleanup closure
      // always references the same Map instance (react-hooks/exhaustive-deps).
      const terminalsMap = terminalsRef.current;

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
              handleSessionList(ws, msg.data.sessions);
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
        if (currentWs) currentWs.close();
        wsRef.current = null;
        // Dispose all terminal instances using the captured map reference
        for (const [, instance] of terminalsMap) {
          if (instance.resizeObserver) {
            instance.resizeObserver.disconnect();
          }
          instance.terminal.dispose();
        }
        terminalsMap.clear();
      };
    }, [wsUrl, createTerminalInstance, destroyTerminalInstance, resolveLocalSessionId, handleSessionList]);

    // UE332: Heartbeat timer — extracted into its own effect.
    // Runs independently of the WS connect/reconnect lifecycle.
    useEffect(() => {
      if (!wsConnected) return;
      const interval = setInterval(() => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeTerminalWsPing());
        }
      }, PING_INTERVAL_MS);
      return () => clearInterval(interval);
    }, [wsConnected]);

    // Attach/fit xterm.js to DOM container via ref callback
    const attachTerminal = useCallback(
      (sessionId: string, containerEl: HTMLDivElement | null) => {
        const instance = terminalsRef.current.get(sessionId);
        if (!instance) return;

        // Handle unmount: clean up observer when React passes null
        if (!containerEl) {
          if (instance.resizeObserver) {
            instance.resizeObserver.disconnect();
            instance.resizeObserver = null;
          }
          instance.containerEl = null;
          return;
        }

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

          // Add ResizeObserver to handle container size changes (including
          // display:none → display:block transitions on tab switch).
          // Also covers window resize, so acts as safety net alongside the
          // explicit window resize listener.
          if (instance.resizeObserver) {
            instance.resizeObserver.disconnect();
          }
          let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
          instance.resizeObserver = new ResizeObserver(() => {
            if (resizeDebounce) clearTimeout(resizeDebounce);
            resizeDebounce = setTimeout(() => {
              // Guard: instance may have been destroyed while resize was queued
              if (!terminalsRef.current.has(sessionId)) return;
              if (containerEl.offsetWidth > 0 && containerEl.offsetHeight > 0) {
                try {
                  instance.fitAddon.fit();
                } catch {
                  return; // terminal may be disposed
                }
                const currentWs = wsRef.current;
                if (currentWs && currentWs.readyState === WebSocket.OPEN) {
                  currentWs.send(
                    encodeTerminalWsResize(
                      instance.terminal.rows,
                      instance.terminal.cols,
                      getOutboundSessionId(sessionId)
                    )
                  );
                }
              }
            }, 100);
          });
          instance.resizeObserver.observe(containerEl);
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

    // When active tab changes, fit the terminal.
    // Use double-rAF to ensure the browser has fully recalculated layout after
    // the display:none → display:block transition before measuring dimensions.
    // The ResizeObserver also handles this, but double-rAF ensures prompt focus.
    useEffect(() => {
      if (!activeSessionId) return;
      const instance = terminalsRef.current.get(activeSessionId);
      if (!instance || !instance.containerEl) return;

      let innerRaf: number;

      const outerRaf = requestAnimationFrame(() => {
        innerRaf = requestAnimationFrame(() => {
          // Guard: terminal may have been disposed during the two frames
          if (!terminalsRef.current.has(activeSessionId)) return;
          try {
            instance.fitAddon.fit();
          } catch {
            return; // terminal disposed
          }
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
      });

      return () => {
        cancelAnimationFrame(outerRaf);
        cancelAnimationFrame(innerRaf);
      };
    }, [activeSessionId, getOutboundSessionId]);

    // UE335: Memoize sessionsArray so downstream effect doesn't fire every render
    const sessionsArray = useMemo(() => Array.from(sessions.values()), [sessions]);

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

    // UE335: Use ref for callback to avoid resubscription; memoized sessionsArray
    // prevents firing on every render.
    const onSessionsChangeRef = useRef(onSessionsChange);
    onSessionsChangeRef.current = onSessionsChange;

    useEffect(() => {
      const cb = onSessionsChangeRef.current;
      if (!cb) return;

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

      cb(snapshots, activeSessionId);
    }, [activeSessionId, sessionsArray]);

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
                    color: colors.error,
                    backgroundColor: colors.bg,
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
                        backgroundColor: `${colors.bg}b3`,
                        color: colors.accent,
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
                    color: colors.fg,
                    backgroundColor: colors.bg,
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
                color: colors.fg,
                backgroundColor: colors.bg,
                gap: '16px',
              }}
            >
              <p>No terminal sessions</p>
              <button
                onClick={handleNewTab}
                disabled={!canCreateSession}
                style={{
                  padding: '8px 16px',
                  border: `1px solid ${colors.accent}`,
                  borderRadius: '4px',
                  backgroundColor: 'transparent',
                  color: colors.accent,
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
