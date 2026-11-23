import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionListItem } from '../../src/lib/api';
import {
  applySessionEvent,
  applySessionEvents,
  rawToSessionEvent,
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
    it('does not change message recency for idle lifecycle updates', () => {
      const existing = [makeSession({ id: 'sess-1', lastMessageAt: 1200 })];
      const result = applySessionEvent(existing, {
        type: 'session.activity',
        payload: { sessionId: 'sess-1', activity: 'idle', promptStartedAt: null },
      });
      expect(result).toBe(existing);
      expect(result[0].lastMessageAt).toBe(1200);
    });

    it('does not update recency from a timestamped prompting lifecycle event', () => {
      const existing = [makeSession({ id: 'sess-1', lastMessageAt: 1200 })];
      const result = applySessionEvent(existing, {
        type: 'session.activity',
        payload: { sessionId: 'sess-1', activity: 'prompting', promptStartedAt: 5000 },
      });
      expect(result).toBe(existing);
      expect(result[0].lastMessageAt).toBe(1200);
    });
  });

  describe('attention deltas', () => {
    it('shows needs_input immediately when an attention marker is created', () => {
      const existing = [makeSession({ id: 'sess-1', attention: null })];
      const result = applySessionEvent(existing, {
        type: 'attention.created',
        payload: {
          sessionId: 'sess-1',
          markerId: 'marker-1',
          kind: 'needs_input',
          createdAt: 1234,
          expiresAt: 5678,
          reason: 'Choose a release strategy',
          options: ['Ship', 'Wait'],
        },
      });

      expect(result[0].attention).toEqual({
        markerId: 'marker-1',
        kind: 'needs_input',
        createdAt: 1234,
        expiresAt: 5678,
        reason: 'Choose a release strategy',
        options: ['Ship', 'Wait'],
      });
    });

    it('clears needs_input immediately when its marker is resolved', () => {
      const existing = [
        makeSession({
          id: 'sess-1',
          attention: {
            markerId: 'marker-1',
            kind: 'needs_input',
            createdAt: 1234,
            expiresAt: 5678,
            reason: null,
            options: [],
          },
        }),
      ];
      const result = applySessionEvent(existing, {
        type: 'attention.resolved',
        payload: { sessionId: 'sess-1', markerId: 'marker-1' },
      });

      expect(result[0].attention).toBeNull();
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
    await act(async () => {
      vi.advanceTimersByTime(20);
    });

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].id).toBe('sess-2');
    expect(result.current.sessions[0].topic).toBe('Batch update');
    expect(result.current.sessions[1].status).toBe('stopped');
  });

  it.each([false, true])(
    'reconciles only post-capture live fields and pending deltas flushed=%s',
    async (flushed) => {
      const { result } = renderHook(() => useSessionReducer());
      act(() => result.current.resetSessions([makeSession(), makeSession({ id: 'removed' })]));
      act(() =>
        result.current.dispatchEvent({
          type: 'session.updated',
          payload: { sessionId: 'sess-1', topic: 'Before request' },
        })
      );
      let before!: ReturnType<typeof result.current.captureSnapshot>;
      act(() => {
        before = result.current.captureSnapshot();
      });
      expect(before.sessions[0]?.topic).toBe('Before request');
      act(() => {
        result.current.dispatchEvent({
          type: 'session.updated',
          payload: { sessionId: 'sess-1', topic: 'Live during request' },
        });
        result.current.dispatchEvent({
          type: 'session.created',
          payload: {
            id: 'live-new',
            topic: 'Live created',
            status: 'active',
            messageCount: 0,
            createdAt: 2000,
          },
        });
      });
      if (flushed)
        await act(async () => {
          vi.advanceTimersByTime(20);
        });
      act(() =>
        result.current.resetSessions(
          [makeSession({ topic: 'Server snapshot', workspaceId: 'fresh-workspace' })],
          before
        )
      );
      expect(result.current.sessions.find((session) => session.id === 'sess-1')).toMatchObject({
        topic: 'Live during request',
        workspaceId: 'fresh-workspace',
      });
      expect(result.current.sessions.some((session) => session.id === 'live-new')).toBe(true);
      expect(result.current.sessions.some((session) => session.id === 'removed')).toBe(false);
    }
  );

  it.each(
    [false, true].flatMap((flushed) => [false, true].map((patched) => ({ flushed, patched })))
  )(
    'sparse live creation preserves rich server fields flushed=$flushed patched=$patched',
    async ({ flushed, patched }) => {
      const { result } = renderHook(() => useSessionReducer());
      const before = result.current.captureSnapshot();
      act(() => {
        result.current.dispatchEvent({
          type: 'session.created',
          payload: { id: 'new', status: 'active', messageCount: 0, createdAt: 1000 },
        });
        if (patched)
          result.current.dispatchEvent({
            type: 'session.updated',
            payload: { sessionId: 'new', topic: 'Later live topic' },
          });
      });
      if (flushed)
        await act(async () => {
          vi.advanceTimersByTime(20);
        });
      act(() =>
        result.current.resetSessions(
          [
            makeSession({
              id: 'new',
              topic: 'Rich server topic',
              workspaceId: 'server-workspace',
              messageCount: 3,
            }),
          ],
          before
        )
      );
      expect(result.current.sessions[0]).toMatchObject({
        topic: patched ? 'Later live topic' : 'Rich server topic',
        workspaceId: 'server-workspace',
        messageCount: 3,
      });
    }
  );

  it('tracks pending events through three overlapping snapshot reads', () => {
    const { result } = renderHook(() => useSessionReducer());
    const first = result.current.captureSnapshot();
    const second = result.current.captureSnapshot();
    const third = result.current.captureSnapshot();
    act(() =>
      result.current.dispatchEvent({
        type: 'session.created',
        payload: { id: 'new', status: 'active', messageCount: 0, createdAt: 1000 },
      })
    );
    act(() => result.current.resetSessions([], first));
    act(() =>
      result.current.dispatchEvent({
        type: 'session.updated',
        payload: { sessionId: 'new', topic: 'Live after first reset' },
      })
    );
    act(() =>
      result.current.resetSessions(
        [
          makeSession({
            id: 'new',
            topic: 'Server topic',
            workspaceId: 'rich-workspace',
            messageCount: 3,
          }),
        ],
        second
      )
    );
    expect(result.current.sessions[0]).toMatchObject({
      topic: 'Live after first reset',
      workspaceId: 'rich-workspace',
      messageCount: 3,
    });
    act(() =>
      result.current.resetSessions(
        [
          makeSession({
            id: 'new',
            topic: 'Stale third topic',
            workspaceId: 'newest-workspace',
            messageCount: 4,
          }),
        ],
        third
      )
    );
    expect(result.current.sessions[0]).toMatchObject({
      topic: 'Live after first reset',
      workspaceId: 'newest-workspace',
      messageCount: 4,
    });
  });

  it.each([false, true])(
    'keeps live fields that return to their pre-read value newRow=%s',
    async (newRow) => {
      const { result } = renderHook(() => useSessionReducer());
      if (!newRow)
        act(() =>
          result.current.resetSessions([makeSession({ id: 'row', topic: 'A', status: 'active' })])
        );
      const before = result.current.captureSnapshot();
      act(() => {
        if (newRow)
          result.current.dispatchEvent({
            type: 'session.created',
            payload: { id: 'row', topic: 'A', status: 'active', messageCount: 0, createdAt: 1000 },
          });
        result.current.dispatchEvent({
          type: 'session.updated',
          payload: { sessionId: 'row', topic: 'B', status: 'sleeping' },
        });
        result.current.dispatchEvent({
          type: 'session.updated',
          payload: { sessionId: 'row', topic: 'A', status: 'active' },
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(20);
      });
      act(() =>
        result.current.resetSessions(
          [
            makeSession({
              id: 'row',
              topic: 'B',
              status: 'sleeping',
              workspaceId: 'fresh-workspace',
            }),
          ],
          before
        )
      );
      expect(result.current.sessions[0]).toMatchObject({
        topic: 'A',
        status: 'active',
        workspaceId: 'fresh-workspace',
      });
    }
  );

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
    await act(async () => {
      vi.advanceTimersByTime(20);
    });

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
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // Sessions reference unchanged
    expect(result.current.sessions).toBe(sessionsBefore);
  });
});

describe('session.updated status (sleep/wake broadcasts)', () => {
  // ProjectData broadcasts `{ sessionId, status: 'sleeping' }` from sleepSession()
  // and `{ sessionId, workspaceId, taskId, status: 'active' }` from wakeSession().
  // The reducer used to drop `status`, so a slept session stayed `active` in the
  // sidebar until the slow reconcile, and `useProvisioningTracker`'s
  // sleeping-session gate read a stale value.
  it('applies a sleep broadcast to the matching session', () => {
    const existing = [makeSession({ id: 'sess-1', status: 'active', topic: 'Keep' })];
    const result = applySessionEvent(existing, {
      type: 'session.updated',
      payload: { sessionId: 'sess-1', status: 'sleeping' },
    });
    expect(result[0].status).toBe('sleeping');
    expect(result[0].topic).toBe('Keep');
  });

  it('applies a wake broadcast, including the new workspace and task', () => {
    const existing = [makeSession({ id: 'sess-1', status: 'sleeping', workspaceId: null })];
    const result = applySessionEvent(existing, {
      type: 'session.updated',
      payload: { sessionId: 'sess-1', status: 'active', workspaceId: 'ws-2', taskId: 'task-1' },
    });
    expect(result[0]).toMatchObject({ status: 'active', workspaceId: 'ws-2', taskId: 'task-1' });
  });

  it('leaves status alone when the payload has none', () => {
    const existing = [makeSession({ id: 'sess-1', status: 'sleeping' })];
    const result = applySessionEvent(existing, {
      type: 'session.updated',
      payload: { sessionId: 'sess-1', topic: 'Renamed' },
    });
    expect(result[0].status).toBe('sleeping');
  });

  it('maps status through from the raw WebSocket frame', () => {
    const event = rawToSessionEvent({
      type: 'session.updated',
      payload: { sessionId: 'sess-1', status: 'sleeping' },
    } as unknown as Parameters<typeof rawToSessionEvent>[0]);
    expect(event).toEqual({
      type: 'session.updated',
      payload: { sessionId: 'sess-1', status: 'sleeping' },
    });
  });
});
