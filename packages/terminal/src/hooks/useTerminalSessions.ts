import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  TerminalSession,
  UseTerminalSessionsReturn
} from '../types/multi-terminal';

/** Serializable session metadata for sessionStorage persistence */
interface PersistedSession {
  name: string;
  order: number;
}

interface PersistedState {
  sessions: PersistedSession[];
  counter: number;
}

/**
 * Hook for managing multiple terminal sessions
 * Handles session creation, activation, closing, reordering, and persistence
 */
export function useTerminalSessions(
  maxSessions: number = 10,
  persistenceKey?: string,
): UseTerminalSessionsReturn {
  const [sessions, setSessions] = useState<Map<string, TerminalSession>>(new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionCounter = useRef(1);

  // Refs to avoid stale closures when multiple state updates happen in one render cycle
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // --- Persistence ---

  /** Save current session metadata to sessionStorage */
  const persistSessions = useCallback((sessionsMap: Map<string, TerminalSession>) => {
    if (!persistenceKey) return;
    try {
      const persisted: PersistedState = {
        sessions: Array.from(sessionsMap.values())
          .sort((a, b) => a.order - b.order)
          .map((s) => ({ name: s.name, order: s.order })),
        counter: sessionCounter.current,
      };
      sessionStorage.setItem(persistenceKey, JSON.stringify(persisted));
    } catch {
      // sessionStorage may be unavailable (private browsing, quota exceeded)
    }
  }, [persistenceKey]);

  /** Load persisted session metadata. Returns null if nothing saved. */
  const loadPersistedSessions = useCallback((): PersistedState | null => {
    if (!persistenceKey) return null;
    try {
      const raw = sessionStorage.getItem(persistenceKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedState;
      if (!parsed.sessions || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, [persistenceKey]);

  // Expose persistence loader for use by MultiTerminal on reconnect
  const getPersistedSessions = useCallback((): PersistedSession[] | null => {
    const state = loadPersistedSessions();
    return state?.sessions ?? null;
  }, [loadPersistedSessions]);

  // Restore counter on mount from persisted state
  useEffect(() => {
    const state = loadPersistedSessions();
    if (state) {
      sessionCounter.current = state.counter;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Generate a unique session ID
   */
  const generateSessionId = useCallback(() => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }, []);

  /**
   * Create a new terminal session
   */
  const createSession = useCallback(
    (name?: string): string => {
      // Use ref to check current size — avoids depending on sessions.size
      // which would make this callback unstable (new reference every session change)
      if (sessionsRef.current.size >= maxSessions) {
        throw new Error(`Maximum sessions reached: ${maxSessions}`);
      }

      const sessionId = generateSessionId();
      const sessionNumber = sessionCounter.current++;
      const sessionName = name || `Terminal ${sessionNumber}`;

      setSessions((prev) => {
        const updated = new Map(prev);
        updated.set(sessionId, {
          id: sessionId,
          name: sessionName,
          status: 'connecting',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          isActive: prev.size === 0,
          order: prev.size,
        });
        persistSessions(updated);
        return updated;
      });

      setActiveSessionId(sessionId);

      return sessionId;
    },
    [maxSessions, generateSessionId, persistSessions]
  );

  /**
   * Close a terminal session
   */
  const closeSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => {
        const updated = new Map(prev);
        const sessionToClose = updated.get(sessionId);

        if (!sessionToClose) return prev;

        updated.delete(sessionId);

        // Reorder remaining sessions
        let order = 0;
        updated.forEach((session) => {
          session.order = order++;
        });

        persistSessions(updated);
        return updated;
      });

      // Use refs to access current state, avoiding stale closure
      const currentActiveId = activeSessionIdRef.current;
      const currentSessions = sessionsRef.current;

      if (sessionId === currentActiveId) {
        const remainingSessions = Array.from(currentSessions.values()).filter(
          (s) => s.id !== sessionId
        );

        if (remainingSessions.length > 0) {
          const currentSession = currentSessions.get(sessionId);
          const currentOrder = currentSession?.order ?? 0;

          const nextSession = remainingSessions.find((s) => s.order > currentOrder) ||
                             remainingSessions.find((s) => s.order < currentOrder);

          if (nextSession) {
            setActiveSessionId(nextSession.id);
          } else {
            setActiveSessionId(remainingSessions[0]!.id);
          }
        } else {
          setActiveSessionId(null);
        }
      }
    },
    [persistSessions]
  );

  /**
   * Activate a terminal session
   */
  const activateSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => {
        const updated = new Map(prev);

        // Deactivate all sessions
        updated.forEach((session) => {
          session.isActive = false;
        });

        // Activate the selected session
        const session = updated.get(sessionId);
        if (session) {
          session.isActive = true;
          session.lastActivityAt = new Date();
        }

        return updated;
      });

      setActiveSessionId(sessionId);
    },
    []
  );

  /**
   * Rename a terminal session
   */
  const renameSession = useCallback(
    (sessionId: string, name: string) => {
      setSessions((prev) => {
        const updated = new Map(prev);
        const session = updated.get(sessionId);

        if (session) {
          session.name = name.slice(0, 50);
        }

        persistSessions(updated);
        return updated;
      });
    },
    [persistSessions]
  );

  /**
   * Reorder sessions (for drag and drop)
   */
  const reorderSessions = useCallback(
    (fromIndex: number, toIndex: number) => {
      setSessions((prev) => {
        const updated = new Map(prev);
        const sessionsArray = Array.from(updated.values()).sort((a, b) => a.order - b.order);

        if (fromIndex < 0 || fromIndex >= sessionsArray.length ||
            toIndex < 0 || toIndex >= sessionsArray.length) {
          return prev;
        }

        const [movedSession] = sessionsArray.splice(fromIndex, 1);
        if (movedSession) {
          sessionsArray.splice(toIndex, 0, movedSession);
        }

        sessionsArray.forEach((session, index) => {
          session.order = index;
        });

        persistSessions(updated);
        return updated;
      });
    },
    [persistSessions]
  );

  /**
   * Get session by order index
   */
  const getSessionByOrder = useCallback(
    (order: number): TerminalSession | undefined => {
      return Array.from(sessions.values()).find((s) => s.order === order);
    },
    [sessions]
  );

  /**
   * Update session status
   */
  const updateSessionStatus = useCallback(
    (sessionId: string, status: TerminalSession['status']) => {
      setSessions((prev) => {
        const updated = new Map(prev);
        const session = updated.get(sessionId);

        if (session) {
          session.status = status;
          if (status === 'connected') {
            session.lastActivityAt = new Date();
          }
        }

        return updated;
      });
    },
    []
  );

  /**
   * Update session working directory
   */
  const updateSessionWorkingDirectory = useCallback(
    (sessionId: string, workingDirectory: string) => {
      setSessions((prev) => {
        const updated = new Map(prev);
        const session = updated.get(sessionId);

        if (session) {
          session.workingDirectory = workingDirectory;
        }

        return updated;
      });
    },
    []
  );

  /** Clear persisted state (e.g. when WS URL changes) */
  const clearPersistedSessions = useCallback(() => {
    if (!persistenceKey) return;
    try {
      sessionStorage.removeItem(persistenceKey);
    } catch {
      // ignore
    }
  }, [persistenceKey]);

  return {
    sessions,
    activeSessionId,
    createSession,
    closeSession,
    activateSession,
    renameSession,
    reorderSessions,
    getSessionByOrder,
    canCreateSession: sessions.size < maxSessions,
    updateSessionStatus,
    updateSessionWorkingDirectory,
    getPersistedSessions,
    clearPersistedSessions,
  } as UseTerminalSessionsReturn;
}
