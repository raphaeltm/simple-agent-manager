import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalSessions } from './useTerminalSessions';
import type { TerminalSession, SessionStatus } from '../types/multi-terminal';

describe('useTerminalSessions', () => {
  const mockGenerateId = () => `test-${Date.now()}`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_MAX_TERMINAL_SESSIONS', '10');
  });

  describe('initialization', () => {
    it('should start with empty sessions', () => {
      const { result } = renderHook(() => useTerminalSessions());

      expect(result.current.sessions).toEqual([]);
      expect(result.current.activeSessionId).toBeNull();
    });
  });

  describe('createSession', () => {
    it('should create a new session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        const session = result.current.createSession();
        expect(session).toBeDefined();
        expect(session.id).toMatch(/^test-/);
        expect(session.name).toBe('Terminal 1');
        expect(session.status).toBe('connecting');
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.activeSessionId).toBe(result.current.sessions[0].id);
    });

    it('should auto-name sessions sequentially', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
        result.current.createSession();
        result.current.createSession();
      });

      expect(result.current.sessions[0].name).toBe('Terminal 1');
      expect(result.current.sessions[1].name).toBe('Terminal 2');
      expect(result.current.sessions[2].name).toBe('Terminal 3');
    });

    it('should respect max session limit', () => {
      vi.stubEnv('VITE_MAX_TERMINAL_SESSIONS', '2');
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
        result.current.createSession();
        const third = result.current.createSession();
        expect(third).toBeNull();
      });

      expect(result.current.sessions).toHaveLength(2);
    });

    it('should reuse numbers from closed sessions', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        const session1 = result.current.createSession();
        const session2 = result.current.createSession();
        result.current.createSession();

        // Close Terminal 2
        result.current.closeSession(session2.id);

        // Next session should reuse "Terminal 2"
        const newSession = result.current.createSession();
        expect(newSession?.name).toBe('Terminal 2');
      });
    });
  });

  describe('closeSession', () => {
    it('should remove session from list', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId: string;
      act(() => {
        const session = result.current.createSession();
        sessionId = session.id;
      });

      act(() => {
        result.current.closeSession(sessionId);
      });

      expect(result.current.sessions).toHaveLength(0);
      expect(result.current.activeSessionId).toBeNull();
    });

    it('should switch to adjacent tab when closing active', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let session1Id: string;
      let session2Id: string;
      let session3Id: string;

      act(() => {
        session1Id = result.current.createSession().id;
        session2Id = result.current.createSession().id;
        session3Id = result.current.createSession().id;
        result.current.setActiveSession(session2Id);
      });

      // Close middle tab
      act(() => {
        result.current.closeSession(session2Id);
      });

      // Should switch to next tab (session3)
      expect(result.current.activeSessionId).toBe(session3Id);
      expect(result.current.sessions).toHaveLength(2);
    });

    it('should switch to previous tab when closing last', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let session1Id: string;
      let session2Id: string;

      act(() => {
        session1Id = result.current.createSession().id;
        session2Id = result.current.createSession().id;
        result.current.setActiveSession(session2Id);
      });

      // Close last tab
      act(() => {
        result.current.closeSession(session2Id);
      });

      // Should switch to previous tab
      expect(result.current.activeSessionId).toBe(session1Id);
    });

    it('should handle closing non-existent session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
      });

      const initialCount = result.current.sessions.length;

      act(() => {
        result.current.closeSession('non-existent');
      });

      expect(result.current.sessions).toHaveLength(initialCount);
    });
  });

  describe('renameSession', () => {
    it('should update session name', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId: string;
      act(() => {
        sessionId = result.current.createSession().id;
      });

      act(() => {
        result.current.renameSession(sessionId, 'Custom Name');
      });

      const session = result.current.getSession(sessionId);
      expect(session?.name).toBe('Custom Name');
    });

    it('should truncate long names', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId: string;
      act(() => {
        sessionId = result.current.createSession().id;
      });

      const longName = 'a'.repeat(100);
      act(() => {
        result.current.renameSession(sessionId, longName);
      });

      const session = result.current.getSession(sessionId);
      expect(session?.name).toHaveLength(50);
    });

    it('should handle empty name', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId: string;
      act(() => {
        sessionId = result.current.createSession().id;
      });

      const originalName = result.current.getSession(sessionId)?.name;

      act(() => {
        result.current.renameSession(sessionId, '');
      });

      // Should keep original name
      expect(result.current.getSession(sessionId)?.name).toBe(originalName);
    });
  });

  describe('updateSessionStatus', () => {
    it('should update session connection status', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId: string;
      act(() => {
        sessionId = result.current.createSession().id;
      });

      act(() => {
        result.current.updateSessionStatus(sessionId, 'connected');
      });

      expect(result.current.getSession(sessionId)?.status).toBe('connected');
    });

    it('should handle status for non-existent session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
      });

      // Should not throw
      expect(() => {
        act(() => {
          result.current.updateSessionStatus('non-existent', 'error');
        });
      }).not.toThrow();
    });

    it('should track all status transitions', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId: string;
      act(() => {
        sessionId = result.current.createSession().id;
      });

      const statuses: SessionStatus[] = ['connecting', 'connected', 'error', 'closed'];

      statuses.forEach(status => {
        act(() => {
          result.current.updateSessionStatus(sessionId, status);
        });
        expect(result.current.getSession(sessionId)?.status).toBe(status);
      });
    });
  });

  describe('setActiveSession', () => {
    it('should change active session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let session1Id: string;
      let session2Id: string;

      act(() => {
        session1Id = result.current.createSession().id;
        session2Id = result.current.createSession().id;
      });

      expect(result.current.activeSessionId).toBe(session2Id); // Last created

      act(() => {
        result.current.setActiveSession(session1Id);
      });

      expect(result.current.activeSessionId).toBe(session1Id);
    });

    it('should handle setting non-existent session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
      });

      const currentActive = result.current.activeSessionId;

      act(() => {
        result.current.setActiveSession('non-existent');
      });

      // Should not change
      expect(result.current.activeSessionId).toBe(currentActive);
    });

    it('should track lastActiveTime', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let session1Id: string;
      let session2Id: string;

      act(() => {
        session1Id = result.current.createSession().id;
        session2Id = result.current.createSession().id;
      });

      const time1 = result.current.getSession(session1Id)?.lastActiveTime;

      // Wait a bit
      setTimeout(() => {
        act(() => {
          result.current.setActiveSession(session1Id);
        });

        const time2 = result.current.getSession(session1Id)?.lastActiveTime;
        expect(time2).toBeGreaterThan(time1!);
      }, 10);
    });
  });

  describe('navigation methods', () => {
    it('should navigate to next session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let ids: string[] = [];
      act(() => {
        ids.push(result.current.createSession().id);
        ids.push(result.current.createSession().id);
        ids.push(result.current.createSession().id);
        result.current.setActiveSession(ids[0]);
      });

      act(() => {
        result.current.nextSession();
      });
      expect(result.current.activeSessionId).toBe(ids[1]);

      act(() => {
        result.current.nextSession();
      });
      expect(result.current.activeSessionId).toBe(ids[2]);

      // Should wrap around
      act(() => {
        result.current.nextSession();
      });
      expect(result.current.activeSessionId).toBe(ids[0]);
    });

    it('should navigate to previous session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let ids: string[] = [];
      act(() => {
        ids.push(result.current.createSession().id);
        ids.push(result.current.createSession().id);
        ids.push(result.current.createSession().id);
        result.current.setActiveSession(ids[0]);
      });

      // Should wrap around to last
      act(() => {
        result.current.previousSession();
      });
      expect(result.current.activeSessionId).toBe(ids[2]);

      act(() => {
        result.current.previousSession();
      });
      expect(result.current.activeSessionId).toBe(ids[1]);
    });

    it('should jump to session by index', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let ids: string[] = [];
      act(() => {
        ids.push(result.current.createSession().id);
        ids.push(result.current.createSession().id);
        ids.push(result.current.createSession().id);
      });

      act(() => {
        result.current.jumpToSession(1);
      });
      expect(result.current.activeSessionId).toBe(ids[1]);

      act(() => {
        result.current.jumpToSession(0);
      });
      expect(result.current.activeSessionId).toBe(ids[0]);

      // Out of bounds should not change
      act(() => {
        result.current.jumpToSession(10);
      });
      expect(result.current.activeSessionId).toBe(ids[0]);
    });
  });

  describe('getSession', () => {
    it('should return session by id', () => {
      const { result } = renderHook(() => useTerminalSessions());

      let sessionId: string;
      act(() => {
        const session = result.current.createSession();
        sessionId = session.id;
      });

      const retrieved = result.current.getSession(sessionId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(sessionId);
    });

    it('should return null for non-existent session', () => {
      const { result } = renderHook(() => useTerminalSessions());

      const retrieved = result.current.getSession('non-existent');
      expect(retrieved).toBeNull();
    });
  });

  describe('canCreateSession', () => {
    it('should allow creation under limit', () => {
      const { result } = renderHook(() => useTerminalSessions());

      expect(result.current.canCreateSession()).toBe(true);

      act(() => {
        result.current.createSession();
      });

      expect(result.current.canCreateSession()).toBe(true);
    });

    it('should prevent creation at limit', () => {
      vi.stubEnv('VITE_MAX_TERMINAL_SESSIONS', '2');
      const { result } = renderHook(() => useTerminalSessions());

      act(() => {
        result.current.createSession();
        result.current.createSession();
      });

      expect(result.current.canCreateSession()).toBe(false);
    });
  });
});