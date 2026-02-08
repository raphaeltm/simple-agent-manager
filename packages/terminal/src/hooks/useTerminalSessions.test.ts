import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalSessions } from './useTerminalSessions';

describe('useTerminalSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should start with empty sessions', () => {
      const { result } = renderHook(() => useTerminalSessions());

      expect(result.current.sessions).toBeInstanceOf(Map);
      expect(result.current.sessions.size).toBe(0);
      expect(result.current.activeSessionId).toBeNull();
      expect(result.current.canCreateSession).toBe(true);
    });
  });

  describe('createSession', () => {
    it('should create a new session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession();
      });

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
      expect(result.current.sessions.size).toBe(1);

      const session = result.current.sessions.get(sessionId);
      expect(session).toBeDefined();
      expect(session?.name).toBe('Terminal 1');
      expect(session?.status).toBe('connecting');
      expect(result.current.activeSessionId).toBe(sessionId);
    });

    it('should auto-name sessions sequentially', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
        result.current.createSession();
        result.current.createSession();
      });

      const sessions = Array.from(result.current.sessions.values());
      expect(sessions[0]?.name).toBe('Terminal 1');
      expect(sessions[1]?.name).toBe('Terminal 2');
      expect(sessions[2]?.name).toBe('Terminal 3');
    });

    it('should respect max session limit', () => {
      const { result } = renderHook(() => useTerminalSessions(2));

      act(() => {
        result.current.createSession();
        result.current.createSession();
      });

      expect(result.current.canCreateSession).toBe(false);

      // Should throw when trying to create beyond limit
      expect(() => {
        act(() => {
          result.current.createSession();
        });
      }).toThrow();
    });

    it('should accept custom name', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession('Custom Terminal');
      });

      const session = result.current.sessions.get(sessionId);
      expect(session?.name).toBe('Custom Terminal');
    });
  });

  describe('closeSession', () => {
    it('should remove session from list', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession();
      });

      expect(result.current.sessions.size).toBe(1);

      act(() => {
        result.current.closeSession(sessionId);
      });

      expect(result.current.sessions.size).toBe(0);
      expect(result.current.activeSessionId).toBeNull();
    });

    it('should switch to another tab when closing active', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let session1Id = '';
      let session2Id = '';

      act(() => {
        session1Id = result.current.createSession();
        session2Id = result.current.createSession();
        result.current.activateSession(session2Id);
      });

      expect(result.current.activeSessionId).toBe(session2Id);

      act(() => {
        result.current.closeSession(session2Id);
      });

      // Should switch to the remaining session
      expect(result.current.activeSessionId).toBe(session1Id);
    });

    it('should handle closing non-existent session gracefully', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
      });

      const initialCount = result.current.sessions.size;

      // Should not throw when closing non-existent session
      act(() => {
        result.current.closeSession('non-existent-id');
      });

      expect(result.current.sessions.size).toBe(initialCount);
    });
  });

  describe('activateSession', () => {
    it('should change active session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let session1Id = '';
      let session2Id = '';

      act(() => {
        session1Id = result.current.createSession();
        session2Id = result.current.createSession();
      });

      // Second created session should be active
      expect(result.current.activeSessionId).toBe(session2Id);

      act(() => {
        result.current.activateSession(session1Id);
      });

      expect(result.current.activeSessionId).toBe(session1Id);

      const session1 = result.current.sessions.get(session1Id);
      const session2 = result.current.sessions.get(session2Id);
      expect(session1?.isActive).toBe(true);
      expect(session2?.isActive).toBe(false);
    });

    it('should update lastActivityAt when activating', async () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession();
      });

      const initialTime = result.current.sessions.get(sessionId)?.lastActivityAt;

      // Wait a bit to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      act(() => {
        result.current.activateSession(sessionId);
      });

      const newTime = result.current.sessions.get(sessionId)?.lastActivityAt;
      expect(newTime).toBeDefined();
      expect(newTime?.getTime()).toBeGreaterThan(initialTime?.getTime() || 0);
    });
  });

  describe('renameSession', () => {
    it('should update session name', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession();
      });

      act(() => {
        result.current.renameSession(sessionId, 'Custom Name');
      });

      const session = result.current.sessions.get(sessionId);
      expect(session?.name).toBe('Custom Name');
    });

    it('should truncate long names to 50 chars', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession();
      });

      const longName = 'a'.repeat(100);
      act(() => {
        result.current.renameSession(sessionId, longName);
      });

      const session = result.current.sessions.get(sessionId);
      expect(session?.name).toHaveLength(50);
    });
  });

  describe('reorderSessions', () => {
    it('should reorder sessions', () => {
      const { result } = renderHook(() => useTerminalSessions());

      const sessionIds: string[] = [];
      act(() => {
        sessionIds.push(result.current.createSession('Terminal 1'));
        sessionIds.push(result.current.createSession('Terminal 2'));
        sessionIds.push(result.current.createSession('Terminal 3'));
      });

      // Move first to last position
      act(() => {
        result.current.reorderSessions(0, 2);
      });

      const sessions = Array.from(result.current.sessions.values());
      expect(sessions[0]?.order).toBe(0);
      expect(sessions[1]?.order).toBe(1);
      expect(sessions[2]?.order).toBe(2);
    });
  });

  describe('getSessionByOrder', () => {
    it('should retrieve session by order', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession('First');
        result.current.createSession('Second');
        result.current.createSession('Third');
      });

      const secondSession = result.current.getSessionByOrder(1);
      expect(secondSession?.name).toBe('Second');
    });

    it('should return undefined for invalid order', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
      });

      const session = result.current.getSessionByOrder(10);
      expect(session).toBeUndefined();
    });
  });

  describe('canCreateSession', () => {
    it('should indicate when sessions can be created', () => {
      const { result } = renderHook(() => useTerminalSessions(3));

      expect(result.current.canCreateSession).toBe(true);

      act(() => {
        result.current.createSession();
      });
      expect(result.current.canCreateSession).toBe(true);

      act(() => {
        result.current.createSession();
      });
      expect(result.current.canCreateSession).toBe(true);

      act(() => {
        result.current.createSession();
      });
      expect(result.current.canCreateSession).toBe(false);
    });
  });
});