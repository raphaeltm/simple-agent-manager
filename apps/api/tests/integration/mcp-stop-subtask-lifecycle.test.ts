import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  sendPromptToAgentOnNode: vi.fn(),
  stopAgentSessionOnNode: vi.fn(),
  stopSession: vi.fn(),
  cleanupTaskRun: vi.fn(),
}));

vi.mock('../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: (...args: unknown[]) => mocks.sendPromptToAgentOnNode(...args),
  stopAgentSessionOnNode: (...args: unknown[]) => mocks.stopAgentSessionOnNode(...args),
}));

vi.mock('../../src/services/project-data', () => ({
  enqueueMailboxMessage: vi.fn(),
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
}));

vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

describe('MCP parent-stop lifecycle boundary', () => {
  let sqlite: Database.Database;
  let env: Env;

  const tokenData = {
    taskId: 'parent-task',
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: 'parent-workspace',
    createdAt: '2026-08-09T09:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.tasks,
      schema.taskStatusEvents,
      schema.workspaces,
      schema.nodes,
      schema.agentSessions,
      schema.triggerExecutions,
    ]);
    sqlite.prepare(`INSERT INTO nodes (id, status) VALUES ('node-1', 'running')`).run();
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('workspace-1', 'project-1', 'node-1', 'chat-1')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, status, created_at)
         VALUES ('agent-session-1', 'workspace-1', 'running', '2026-08-09T08:00:00.000Z')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO trigger_executions (id, status)
         VALUES ('trigger-execution-1', 'running')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, workspace_id, parent_task_id, status, error_message,
            created_at, updated_at, trigger_execution_id)
         VALUES
           ('child-task', 'project-1', 'workspace-1', 'parent-task', 'in_progress', NULL,
            '2026-08-09T08:00:00.000Z', '2026-08-09T08:00:00.000Z', 'trigger-execution-1')`
      )
      .run();
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    mocks.stopAgentSessionOnNode.mockImplementation(async () => {
      const row = sqlite.prepare(`SELECT status FROM tasks WHERE id = 'child-task'`).get() as {
        status: string;
      };
      expect(row.status).toBe('in_progress');
    });
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('hard-stops first, then persists cancellation, event, trigger sync, and cleanup', async () => {
    const { handleStopSubtask } = await import('../../src/routes/mcp/orchestration-comms');
    env.ORCHESTRATOR_STOP_GRACE_MS = '1';

    const result = await handleStopSubtask(
      1,
      { taskId: 'child-task', reason: 'No longer needed' },
      tokenData,
      env
    );

    expect(result.error).toBeUndefined();
    expect(
      sqlite
        .prepare(`SELECT status, error_message, completed_at FROM tasks WHERE id = 'child-task'`)
        .get()
    ).toMatchObject({
      status: 'cancelled',
      error_message: 'Stopped by parent: No longer needed',
    });
    expect(
      sqlite
        .prepare(
          `SELECT from_status, to_status, actor_type, reason
             FROM task_status_events WHERE task_id = 'child-task'`
        )
        .all()
    ).toEqual([
      {
        from_status: 'in_progress',
        to_status: 'cancelled',
        actor_type: 'agent',
        reason: 'Stopped by parent: No longer needed',
      },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT status, error_message, completed_at
             FROM trigger_executions WHERE id = 'trigger-execution-1'`
        )
        .get()
    ).toMatchObject({ status: 'failed', error_message: null });
    expect(mocks.stopSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('child-task', env, undefined, 'user-1');
  });

  it('preserves a fatal callback that wins while the runtime is being stopped', async () => {
    mocks.stopAgentSessionOnNode.mockImplementationOnce(async () => {
      sqlite
        .prepare(
          `UPDATE tasks
              SET status = 'failed', error_message = 'Prompt timed out after 6h0m0s',
                  completed_at = '2026-08-09T09:34:00.000Z'
            WHERE id = 'child-task'`
        )
        .run();
      sqlite
        .prepare(
          `UPDATE trigger_executions
              SET status = 'failed', error_message = 'Prompt timed out after 6h0m0s'
            WHERE id = 'trigger-execution-1'`
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO task_status_events
             (id, task_id, from_status, to_status, actor_type, reason, created_at)
           VALUES
             ('fatal-event', 'child-task', 'in_progress', 'failed', 'workspace',
              'Prompt timed out after 6h0m0s', '2026-08-09T09:34:00.000Z')`
        )
        .run();
    });
    const { handleStopSubtask } = await import('../../src/routes/mcp/orchestration-comms');

    const result = await handleStopSubtask(1, { taskId: 'child-task' }, tokenData, env);

    const content = JSON.parse(
      (result.result as { content: Array<{ text: string }> }).content[0].text
    );
    expect(content).toMatchObject({ stopped: true, terminalStatePreserved: true });
    expect(
      sqlite.prepare(`SELECT status, error_message FROM tasks WHERE id = 'child-task'`).get()
    ).toEqual({ status: 'failed', error_message: 'Prompt timed out after 6h0m0s' });
    expect(
      sqlite
        .prepare(`SELECT to_status, reason FROM task_status_events WHERE task_id = 'child-task'`)
        .all()
    ).toEqual([{ to_status: 'failed', reason: 'Prompt timed out after 6h0m0s' }]);
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
  });
});
