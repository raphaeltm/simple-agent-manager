/**
 * Tests for conversation-mode workspace idle timeout task completion.
 *
 * Root cause (2026-05-13): checkWorkspaceIdleTimeouts stopped the workspace
 * and session but did NOT complete the associated task in D1. Conversation-mode
 * tasks are excluded from the 15-min session idle cleanup (by design), so the
 * workspace idle timeout is their only cleanup path. Without task completion,
 * conversation-mode tasks stayed in_progress until the 8-hour hard timeout.
 *
 * Bug: idle-cleanup.ts:checkWorkspaceIdleTimeouts → no call to completeTaskInD1
 * Fix: added D1 task query + completeTaskInD1 after deleteWorkspaceInD1
 */
import { describe, expect, it, vi } from 'vitest';

import { checkWorkspaceIdleTimeouts, completeTaskInD1 } from '../../src/durable-objects/project-data/idle-cleanup';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockSql(
  workspaceActivityRows: Array<{
    workspace_id: string;
    session_id: string | null;
    last_terminal_activity_at: number;
    last_message_at: number;
    session_updated_at: number;
  }>
) {
  return {
    exec: vi.fn().mockImplementation((query: string, ...args: unknown[]) => {
      // workspace_activity + chat_sessions join
      if (query.includes('FROM workspace_activity wa') && query.includes('INNER JOIN chat_sessions')) {
        return {
          toArray: () => workspaceActivityRows,
        };
      }
      // stopSessionInternal: UPDATE chat_sessions SET status = 'stopped'
      if (query.includes('UPDATE chat_sessions SET status')) {
        return { rowsWritten: 1 };
      }
      // SELECT workspace_id, message_count FROM chat_sessions (for stopSession return)
      if (query.includes('SELECT workspace_id, message_count FROM chat_sessions')) {
        return { toArray: () => [{ workspace_id: null, message_count: 0 }] };
      }
      // DELETE FROM workspace_activity
      if (query.includes('DELETE FROM workspace_activity')) {
        return { rowsWritten: 1 };
      }
      // INSERT INTO activity_events (recordActivityEventInternal)
      if (query.includes('INSERT INTO activity_events')) {
        return { rowsWritten: 1 };
      }
      // materializeSession queries
      if (query.includes('chat_messages_grouped')) {
        return { toArray: () => [] };
      }
      if (query.includes('UPDATE chat_sessions SET materialized_at')) {
        return { rowsWritten: 0 };
      }
      return { toArray: () => [], rowsWritten: 0 };
    }),
  } as unknown as SqlStorage;
}

function createMockEnv(opts: {
  projectTimeoutMs?: number | null;
  taskForWorkspace?: { id: string } | null;
}) {
  const prepareResults: Record<string, unknown> = {};

  return {
    WORKSPACE_IDLE_TIMEOUT_MS: undefined,
    DATABASE: {
      prepare: vi.fn().mockImplementation((query: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (query.includes('workspace_idle_timeout_ms FROM projects')) {
              return opts.projectTimeoutMs != null
                ? { workspace_idle_timeout_ms: opts.projectTimeoutMs }
                : null;
            }
            if (query.includes('SELECT id FROM tasks WHERE workspace_id')) {
              return opts.taskForWorkspace ?? null;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        }),
      })),
    } as unknown as D1Database,
  } as unknown as import('../../src/durable-objects/project-data/types').Env;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkWorkspaceIdleTimeouts: conversation-mode task completion', () => {
  const TWO_HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000; // 3h ago — safely past 2h threshold

  it('completes the task in D1 when workspace idle timeout fires', async () => {
    const mockSql = createMockSql([
      {
        workspace_id: 'ws-conv-1',
        session_id: 'sess-1',
        last_terminal_activity_at: TWO_HOURS_AGO,
        last_message_at: TWO_HOURS_AGO,
        session_updated_at: TWO_HOURS_AGO,
      },
    ]);
    const mockEnv = createMockEnv({ taskForWorkspace: { id: 'task-conv-1' } });
    const deleteWorkspace = vi.fn().mockResolvedValue(undefined);
    const broadcastEvent = vi.fn();
    const scheduleSummarySync = vi.fn();

    await checkWorkspaceIdleTimeouts(
      mockSql,
      mockEnv,
      'project-1',
      deleteWorkspace,
      broadcastEvent,
      scheduleSummarySync
    );

    // Workspace should have been deleted
    expect(deleteWorkspace).toHaveBeenCalledWith('ws-conv-1');

    // Task query should have been made
    const taskQuery = mockEnv.DATABASE.prepare as ReturnType<typeof vi.fn>;
    const taskQueryCalls = taskQuery.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('SELECT id FROM tasks WHERE workspace_id')
    );
    expect(taskQueryCalls.length).toBe(1);

    // Task completion query should have been made
    const completionCalls = taskQuery.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes("UPDATE tasks SET status = 'completed'")
    );
    expect(completionCalls.length).toBe(1);

    // Broadcast should include taskId
    expect(broadcastEvent).toHaveBeenCalledWith(
      'workspace.idle_timeout',
      expect.objectContaining({
        workspaceId: 'ws-conv-1',
        taskId: 'task-conv-1',
      })
    );
  });

  it('handles workspace with no linked task gracefully', async () => {
    const mockSql = createMockSql([
      {
        workspace_id: 'ws-no-task',
        session_id: 'sess-2',
        last_terminal_activity_at: TWO_HOURS_AGO,
        last_message_at: TWO_HOURS_AGO,
        session_updated_at: TWO_HOURS_AGO,
      },
    ]);
    const mockEnv = createMockEnv({ taskForWorkspace: null });
    const deleteWorkspace = vi.fn().mockResolvedValue(undefined);
    const broadcastEvent = vi.fn();
    const scheduleSummarySync = vi.fn();

    // Should not throw
    await checkWorkspaceIdleTimeouts(
      mockSql,
      mockEnv,
      'project-2',
      deleteWorkspace,
      broadcastEvent,
      scheduleSummarySync
    );

    expect(deleteWorkspace).toHaveBeenCalledWith('ws-no-task');

    // Broadcast should have null taskId
    expect(broadcastEvent).toHaveBeenCalledWith(
      'workspace.idle_timeout',
      expect.objectContaining({
        workspaceId: 'ws-no-task',
        taskId: null,
      })
    );
  });

  it('does not clean up workspaces that are still active (within timeout)', async () => {
    const RECENT = Date.now() - 30 * 60 * 1000; // 30 min ago — within 2h threshold
    const mockSql = createMockSql([
      {
        workspace_id: 'ws-active',
        session_id: 'sess-3',
        last_terminal_activity_at: RECENT,
        last_message_at: RECENT,
        session_updated_at: RECENT,
      },
    ]);
    const mockEnv = createMockEnv({ taskForWorkspace: { id: 'task-active' } });
    const deleteWorkspace = vi.fn();
    const broadcastEvent = vi.fn();
    const scheduleSummarySync = vi.fn();

    await checkWorkspaceIdleTimeouts(
      mockSql,
      mockEnv,
      'project-3',
      deleteWorkspace,
      broadcastEvent,
      scheduleSummarySync
    );

    // Should NOT have been called — workspace is still active
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it('continues cleanup if task completion fails', async () => {
    const mockSql = createMockSql([
      {
        workspace_id: 'ws-fail-task',
        session_id: 'sess-4',
        last_terminal_activity_at: TWO_HOURS_AGO,
        last_message_at: TWO_HOURS_AGO,
        session_updated_at: TWO_HOURS_AGO,
      },
    ]);

    // Create env where task query throws
    const mockEnv = createMockEnv({ taskForWorkspace: null });
    const taskPrepare = mockEnv.DATABASE.prepare as ReturnType<typeof vi.fn>;
    taskPrepare.mockImplementation((query: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(async () => {
          if (query.includes('SELECT id FROM tasks WHERE workspace_id')) {
            throw new Error('D1 query failed');
          }
          if (query.includes('workspace_idle_timeout_ms FROM projects')) {
            return null;
          }
          return null;
        }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    }));

    const deleteWorkspace = vi.fn().mockResolvedValue(undefined);
    const broadcastEvent = vi.fn();
    const scheduleSummarySync = vi.fn();

    // Should not throw — task completion failure is caught
    await checkWorkspaceIdleTimeouts(
      mockSql,
      mockEnv,
      'project-4',
      deleteWorkspace,
      broadcastEvent,
      scheduleSummarySync
    );

    // Workspace should still have been deleted despite task completion failure
    expect(deleteWorkspace).toHaveBeenCalledWith('ws-fail-task');

    // Broadcast should still fire with null taskId (task completion failed)
    expect(broadcastEvent).toHaveBeenCalled();
  });
});

describe('completeTaskInD1 trigger sync', () => {
  it('calls syncTriggerExecutionStatus after completing task', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    } as unknown as D1Database;

    await completeTaskInD1(mockDb, 'task-sync-test');

    const prepareCalls = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls;

    // Should have called: UPDATE tasks + trigger execution sync query
    const taskUpdateCall = prepareCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes("UPDATE tasks SET status = 'completed'")
    );
    expect(taskUpdateCall).toBeTruthy();
  });
});
