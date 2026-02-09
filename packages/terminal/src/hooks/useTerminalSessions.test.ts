import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalSessions } from './useTerminalSessions';

describe('useTerminalSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
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

      // Sort by order to verify reordering (Map iteration order is insertion order)
      const sessions = Array.from(result.current.sessions.values()).sort((a, b) => a.order - b.order);
      expect(sessions[0]?.order).toBe(0);
      expect(sessions[1]?.order).toBe(1);
      expect(sessions[2]?.order).toBe(2);
      // After moving first to last: Terminal 2, Terminal 3, Terminal 1
      expect(sessions[0]?.name).toBe('Terminal 2');
      expect(sessions[2]?.name).toBe('Terminal 1');
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

  describe('serverSessionId persistence', () => {
    const PERSISTENCE_KEY = 'test-terminal-sessions';

    it('should persist serverSessionId to sessionStorage', () => {
      const { result } = renderHook(() => useTerminalSessions(10, PERSISTENCE_KEY));

      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession('Tab 1');
      });

      // Simulate receiving a server-assigned session ID
      act(() => {
        result.current.updateServerSessionId(sessionId, 'server-abc-123');
      });

      // Check sessionStorage contains the serverSessionId
      const raw = sessionStorage.getItem(PERSISTENCE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.sessions[0].serverSessionId).toBe('server-abc-123');
      expect(parsed.sessions[0].name).toBe('Tab 1');
    });

    it('should load persisted serverSessionId via getPersistedSessions', () => {
      // Pre-populate sessionStorage
      const persisted = {
        sessions: [
          { name: 'Tab 1', order: 0, serverSessionId: 'server-111' },
          { name: 'Tab 2', order: 1, serverSessionId: 'server-222' },
        ],
        counter: 3,
      };
      sessionStorage.setItem(PERSISTENCE_KEY, JSON.stringify(persisted));

      const { result } = renderHook(() => useTerminalSessions(10, PERSISTENCE_KEY));

      const loaded = result.current.getPersistedSessions();
      expect(loaded).not.toBeNull();
      expect(loaded).toHaveLength(2);
      expect(loaded![0]!.serverSessionId).toBe('server-111');
      expect(loaded![0]!.name).toBe('Tab 1');
      expect(loaded![1]!.serverSessionId).toBe('server-222');
      expect(loaded![1]!.name).toBe('Tab 2');
    });

    it('should restore counter from persisted state', () => {
      // Pre-populate with counter=5
      const persisted = {
        sessions: [{ name: 'Tab 5', order: 0, serverSessionId: 'srv-1' }],
        counter: 5,
      };
      sessionStorage.setItem(PERSISTENCE_KEY, JSON.stringify(persisted));

      const { result } = renderHook(() => useTerminalSessions(10, PERSISTENCE_KEY));

      // Creating a new session should use counter=5 (i.e., "Terminal 5")
      let sessionId = '';
      act(() => {
        sessionId = result.current.createSession();
      });

      const session = result.current.sessions.get(sessionId);
      expect(session?.name).toBe('Terminal 5');
    });

    it('should return null when no persisted sessions exist', () => {
      const { result } = renderHook(() => useTerminalSessions(10, PERSISTENCE_KEY));
      const loaded = result.current.getPersistedSessions();
      expect(loaded).toBeNull();
    });

    it('should return null when persistenceKey is not provided', () => {
      const { result } = renderHook(() => useTerminalSessions());
      const loaded = result.current.getPersistedSessions();
      expect(loaded).toBeNull();
    });

    it('should clear persisted sessions', () => {
      const persisted = {
        sessions: [{ name: 'Tab 1', order: 0, serverSessionId: 'srv-1' }],
        counter: 2,
      };
      sessionStorage.setItem(PERSISTENCE_KEY, JSON.stringify(persisted));

      const { result } = renderHook(() => useTerminalSessions(10, PERSISTENCE_KEY));

      act(() => {
        result.current.clearPersistedSessions();
      });

      expect(sessionStorage.getItem(PERSISTENCE_KEY)).toBeNull();
    });

    it('should persist multiple sessions with serverSessionIds', () => {
      const { result } = renderHook(() => useTerminalSessions(10, PERSISTENCE_KEY));

      let id1 = '';
      let id2 = '';
      act(() => {
        id1 = result.current.createSession('First');
        id2 = result.current.createSession('Second');
      });

      act(() => {
        result.current.updateServerSessionId(id1, 'server-aaa');
        result.current.updateServerSessionId(id2, 'server-bbb');
      });

      const raw = sessionStorage.getItem(PERSISTENCE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.sessions).toHaveLength(2);

      // Sessions should be persisted in order
      const sorted = [...parsed.sessions].sort(
        (a: { order: number }, b: { order: number }) => a.order - b.order,
      );
      expect(sorted[0].name).toBe('First');
      expect(sorted[0].serverSessionId).toBe('server-aaa');
      expect(sorted[1].name).toBe('Second');
      expect(sorted[1].serverSessionId).toBe('server-bbb');
    });

    it('should support VM restart scenario: create fresh sessions with persisted names and update serverSessionIds', () => {
      // Simulate: user had 2 tabs persisted before VM restart
      const persisted = {
        sessions: [
          { name: 'Dev Server', order: 0, serverSessionId: 'old-srv-1' },
          { name: 'Build', order: 1, serverSessionId: 'old-srv-2' },
        ],
        counter: 3,
      };
      sessionStorage.setItem(PERSISTENCE_KEY, JSON.stringify(persisted));

      const { result } = renderHook(() => useTerminalSessions(10, PERSISTENCE_KEY));

      // Load persisted sessions (as MultiTerminal.tsx would on reconnect)
      const loaded = result.current.getPersistedSessions();
      expect(loaded).toHaveLength(2);
      expect(loaded![0]!.name).toBe('Dev Server');
      expect(loaded![1]!.name).toBe('Build');

      // Simulate what MultiTerminal does when server returns empty session_list:
      // create fresh sessions with the persisted names
      let freshId1 = '';
      let freshId2 = '';
      act(() => {
        freshId1 = result.current.createSession(loaded![0]!.name);
        freshId2 = result.current.createSession(loaded![1]!.name);
      });

      // Verify sessions were created with the original names
      expect(result.current.sessions.get(freshId1)?.name).toBe('Dev Server');
      expect(result.current.sessions.get(freshId2)?.name).toBe('Build');

      // Simulate receiving new server session IDs (from session_created messages)
      act(() => {
        result.current.updateServerSessionId(freshId1, 'new-srv-AAA');
        result.current.updateServerSessionId(freshId2, 'new-srv-BBB');
      });

      // Verify the new serverSessionIds are persisted
      const raw = sessionStorage.getItem(PERSISTENCE_KEY);
      const parsed = JSON.parse(raw!);
      const sorted = [...parsed.sessions].sort(
        (a: { order: number }, b: { order: number }) => a.order - b.order,
      );
      expect(sorted[0].serverSessionId).toBe('new-srv-AAA');
      expect(sorted[1].serverSessionId).toBe('new-srv-BBB');
    });
  });
});