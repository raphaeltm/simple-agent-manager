import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionListItem } from '../../src/lib/api';
import {
  applySessionEvent,
  applySessionEvents,
  type SessionEvent,
  useSessionReducer,
} from '../../src/pages/project-chat/useSessionReducer';

function makeSession(overrides: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 'sess-1',
    workspaceId: null,
    taskId: null,
    topic: 'Test session',
    status: 'active',
    messageCount: 5,
    startedAt: 1000,
    endedAt: null,
    createdAt: 1000,
    ...overrides,
  };
}

describe('applySessionEvent', () => {
  describe('session.created', () => {
    it('prepends a new session to the array', () => {
      const existing = [makeSession({ id: 'sess-old' })];
      const result = applySessionEvent(existing, {
        type: 'session.created',
        payload: {
          id: 'sess-new',
          status: 'active',
          messageCount: 0,
          createdAt: 2000,
          topic: 'New session',
        },
      });
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sess-new');
      expect(result[0].topic).toBe('New session');
      expect(result[0].status).toBe('active');
      expect(result[1]).toBe(existing[0]); // unchanged session preserves reference
    });

    it('ignores duplicate session IDs', () => {
      const existing = [makeSession({ id: 'sess-1' })];
      const result = applySessionEvent(existing, {
        type: 'session.created',
        payload: {
          id: 'sess-1',
          status: 'active',
          messageCount: 0,
          createdAt: 2000,
        },
      });
      expect(result).toBe(existing); // same reference — no change
    });
  });

  describe('session.stopped', () => {
    it('updates the matching session status to stopped', () => {
      const existing = [
        makeSession({ id: 'sess-1', status: 'active' }),
        makeSession({ id: 'sess-2', status: 'active' }),
      ];
      const result = applySessionEvent(existing, {
        type: 'session.stopped',
        payload: { sessionId: 'sess-1' },
      });
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('stopped');
      expect(result[0].isTerminated).toBe(true);
      expect(result[1]).toBe(existing[1]); // unchanged session preserves reference
    });

    it('returns same array when session not found', () => {
      const existing = [makeSession({ id: 'sess-1' })];
      const result = applySessionEvent(existing, {
        type: 'session.stopped',
        payload: { sessionId: 'nonexistent' },
      });
      expect(result).toBe(existing);
    });
  });

  describe('session.failed', () => {
    it('updates the matching session status to failed', () => {
      const existing = [makeSession({ id: 'sess-1', status: 'active' })];
      const result = applySessionEvent(existing, {
        type: 'session.failed',
        payload: { sessionId: 'sess-1' },
      });
      expect(result[0].status).toBe('failed');
      expect(result[0].isTerminated).toBe(true);
    });
  });

  describe('session.updated', () => {
    it('merges topic change into the matching session', () => {
      const existing = [makeSession({ id: 'sess-1', topic: 'Old topic' })];
      const result = applySessionEvent(existing, {
        type: 'session.updated',
        payload: { sessionId: 'sess-1', topic: 'New topic' },
      });
      expect(result[0].topic).toBe('New topic');
      expect(result[0].status).toBe('active'); // other fields unchanged
    });

    it('merges taskId into the matching session', () => {
      const existing = [makeSession({ id: 'sess-1', taskId: null })];
      const result = applySessionEvent(existing, {
        type: 'session.updated',
        payload: { sessionId: 'sess-1', taskId: 'task-1' },
      });
      expect(result[0].taskId).toBe('task-1');
    });

    it('merges workspaceId into the matching session', () => {
      const existing = [makeSession({ id: 'sess-1', workspaceId: null })];
      const result = applySessionEvent(existing, {
        type: 'session.updated',
        payload: { sessionId: 'sess-1', workspaceId: 'ws-1' },
      });
      expect(result[0].workspaceId).toBe('ws-1');
    });

    it('does not mutate fields not present in the payload', () => {
      const existing = [makeSession({ id: 'sess-1', topic: 'Keep', taskId: 'task-x' })];
      const result = applySessionEvent(existing, {
        type: 'session.updated',
        payload: { sessionId: 'sess-1', topic: 'Changed' },
      });
      expect(result[0].topic).toBe('Changed');
      expect(result[0].taskId).toBe('task-x'); // preserved
    });
  });

  describe('session.agent_completed', () => {
    it('sets agentCompletedAt and isIdle on the matching session', () => {
      const existing = [makeSession({ id: 'sess-1' })];
      const result = applySessionEvent(existing, {
        type: 'session.agent_completed',
        payload: { sessionId: 'sess-1', agentCompletedAt: 5000 },
      });
      expect(result[0].agentCompletedAt).toBe(5000);
      expect(result[0].isIdle).toBe(true);
    });
  });

  describe('session.activity', () => {
    it('updates lastMessageAt on the matching session', () => {
      const existing = [makeSession({ id: 'sess-1' })];
      const result = applySessionEvent(existing, {
        type: 'session.activity',
        payload: { sessionId: 'sess-1' },
      });
      expect(result[0].lastMessageAt).toBeGreaterThan(0);
    });
  });

  describe('reference stability', () => {
    it('preserves unchanged session references when a different session changes', () => {
      const sessions = [
        makeSession({ id: 'sess-1' }),
        makeSession({ id: 'sess-2' }),
        makeSession({ id: 'sess-3' }),
      ];
      const result = applySessionEvent(sessions, {
        type: 'session.stopped',
        payload: { sessionId: 'sess-2' },
      });
      expect(result[0]).toBe(sessions[0]); // same reference
      expect(result[2]).toBe(sessions[2]); // same reference
      expect(result[1]).not.toBe(sessions[1]); // new object
    });
  });
});

describe('applySessionEvents (batch)', () => {
  it('applies multiple events in sequence', () => {
    const sessions = [makeSession({ id: 'sess-1', status: 'active', topic: 'Original' })];
    const events: SessionEvent[] = [
      {
        type: 'session.created',
        payload: { id: 'sess-2', status: 'active', messageCount: 0, createdAt: 2000 },
      },
      {
        type: 'session.updated',
        payload: { sessionId: 'sess-1', topic: 'Updated' },
      },
      {
        type: 'session.stopped',
        payload: { sessionId: 'sess-2' },
      },
    ];
    const result = applySessionEvents(sessions, events);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('sess-2');
    expect(result[0].status).toBe('stopped'); // created then stopped
    expect(result[1].topic).toBe('Updated');
  });

  it('returns same reference when events array is empty', () => {
    const sessions = [makeSession()];
    const result = applySessionEvents(sessions, []);
    expect(result).toBe(sessions);
  });
});

describe('useSessionReducer hook (batching)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('batches multiple rapid events into a single state update', async () => {
    const { result } = renderHook(() => useSessionReducer());

    // Seed initial sessions
    act(() => {
      result.current.resetSessions([makeSession({ id: 'sess-1', status: 'active' })]);
    });

    // Dispatch 3 events synchronously — no await between them
    act(() => {
      result.current.dispatchEvent({
        type: 'session.created',
        payload: { id: 'sess-2', status: 'active', messageCount: 0, createdAt: 2000 },
      });
      result.current.dispatchEvent({
        type: 'session.stopped',
        payload: { sessionId: 'sess-1' },
      });
      result.current.dispatchEvent({
        type: 'session.updated',
        payload: { sessionId: 'sess-2', topic: 'Batch update' },
      });
    });

    // Before timer fires, sessions are still at old state
    expect(result.current.sessions).toHaveLength(1);

    // Advance past batch delay — all 3 events applied in one update
    await act(async () => { vi.advanceTimersByTime(20); });

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].id).toBe('sess-2');
    expect(result.current.sessions[0].topic).toBe('Batch update');
    expect(result.current.sessions[1].status).toBe('stopped');
  });

  it('resetSessions discards a pending batch', async () => {
    const { result } = renderHook(() => useSessionReducer());

    act(() => {
      result.current.resetSessions([makeSession({ id: 'sess-1' })]);
    });

    // Dispatch an event (starts a batch timer)
    act(() => {
      result.current.dispatchEvent({
        type: 'session.stopped',
        payload: { sessionId: 'sess-1' },
      });
    });

    // Before the batch fires, do a full reset with fresh data
    act(() => {
      result.current.resetSessions([
        makeSession({ id: 'sess-1', status: 'active' }),
        makeSession({ id: 'sess-new', status: 'active' }),
      ]);
    });

    // Advance past batch delay — stale batch should NOT apply
    await act(async () => { vi.advanceTimersByTime(20); });

    // Should have the reset data, not the stale batched event
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].status).toBe('active'); // NOT stopped
  });

  it('flushBatch is a no-op when batch is empty', async () => {
    const { result } = renderHook(() => useSessionReducer());

    act(() => {
      result.current.resetSessions([makeSession({ id: 'sess-1' })]);
    });
    const sessionsBefore = result.current.sessions;

    // Advance past many batch windows with no events
    await act(async () => { vi.advanceTimersByTime(100); });

    // Sessions reference unchanged
    expect(result.current.sessions).toBe(sessionsBefore);
  });
});
