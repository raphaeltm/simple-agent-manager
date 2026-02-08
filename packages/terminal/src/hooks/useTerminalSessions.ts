import { useState, useCallback, useRef } from 'react';
import type {
  TerminalSession,
  UseTerminalSessionsReturn,
  MultiTerminalError
} from '../types/multi-terminal';

/**
 * Hook for managing multiple terminal sessions
 * Handles session creation, activation, closing, and reordering
 */
export function useTerminalSessions(maxSessions: number = 10): UseTerminalSessionsReturn {
  const [sessions, setSessions] = useState<Map<string, TerminalSession>>(new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionCounter = useRef(1);

  /**
   * Generate a unique session ID
   */
  const generateSessionId = useCallback(() => {
    // Generate a UUID-like ID
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
      if (sessions.size >= maxSessions) {
        throw new Error(`Maximum sessions reached: ${maxSessions}`);
      }

      const sessionId = generateSessionId();
      const sessionNumber = sessionCounter.current++;
      const sessionName = name || `Terminal ${sessionNumber}`;

      const newSession: TerminalSession = {
        id: sessionId,
        name: sessionName,
        status: 'connecting',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isActive: sessions.size === 0, // First session is active by default
        order: sessions.size,
      };

      setSessions((prev) => {
        const updated = new Map(prev);
        updated.set(sessionId, newSession);
        return updated;
      });

      // Activate first session or if no active session
      if (sessions.size === 0 || !activeSessionId) {
        setActiveSessionId(sessionId);
      }

      return sessionId;
    },
    [sessions.size, maxSessions, activeSessionId, generateSessionId]
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

        return updated;
      });

      // If closing the active session, activate another
      if (sessionId === activeSessionId) {
        const remainingSessions = Array.from(sessions.values()).filter(
          (s) => s.id !== sessionId
        );

        if (remainingSessions.length > 0) {
          // Activate the next or previous session
          const currentSession = sessions.get(sessionId);
          const currentOrder = currentSession?.order ?? 0;

          const nextSession = remainingSessions.find((s) => s.order > currentOrder) ||
                             remainingSessions.find((s) => s.order < currentOrder);

          if (nextSession) {
            setActiveSessionId(nextSession.id);
          } else {
            setActiveSessionId(null);
          }
        } else {
          setActiveSessionId(null);
        }
      }
    },
    [sessions, activeSessionId]
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
          session.name = name.slice(0, 50); // Enforce max length
        }

        return updated;
      });
    },
    []
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
        sessionsArray.splice(toIndex, 0, movedSession);

        // Update order for all sessions
        sessionsArray.forEach((session, index) => {
          session.order = index;
        });

        return updated;
      });
    },
    []
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
  };
}