/**
 * SAM stop_subtask cancellation compare-and-set (state-machine audit D2).
 *
 * The tool reads the task, stops its agent, then cancels it. The cancel used to write
 * `WHERE id = ?` with an unconditional status event, so a task that completed in between
 * was overwritten with `cancelled`. The guard is a SQL predicate, so this runs on a real
 * SQLite engine (rule 28) with the completion injected right after the tool's read of the
 * task (rule 62, controlled ordering).
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { stopSubtask } from '../../../src/durable-objects/sam-session/tools/stop-subtask';
import type { ToolContext } from '../../../src/durable-objects/sam-session/types';
import { createRacingD1 } from '../../helpers/racing-d1';
import { createAllSchemaTables } from '../../helpers/sqlite-d1';

const cleanup = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: cleanup,
}));
const stopAgent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/services/node-agent', () => ({
  stopAgentSessionOnNode: stopAgent,
}));

let sqlite: Database.Database;
let afterTaskRead: (() => void) | null;

function racingD1(): D1Database {
  const race = createRacingD1(sqlite, 'tasks');
  const hook = afterTaskRead;
  if (hook) {
    race.afterNextRead(() => {
      afterTaskRead = null;
      hook();
    });
  }
  return race.d1;
}

function seedTask(status: string, triggerExecutionStatus?: string): void {
  sqlite.prepare(`INSERT INTO projects (id, user_id, name) VALUES ('proj-1', 'user-1', 'P')`).run();
  // A live workspace, node and agent session, so the agent-stop path is reachable.
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, runtime) VALUES ('node-1', 'user-1', 'n', 'running', 'vm')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, node_id, project_id, status) VALUES ('ws-1', 'user-1', 'node-1', 'proj-1', 'running')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO agent_sessions (id, workspace_id, user_id, status, created_at, updated_at)
       VALUES ('agent-1', 'ws-1', 'user-1', 'running', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')`
    )
    .run();
  if (triggerExecutionStatus) {
    sqlite
      .prepare(
        `INSERT INTO trigger_executions (id, trigger_id, project_id, status) VALUES ('exec-1', 'trig-1', 'proj-1', ?)`
      )
      .run(triggerExecutionStatus);
  }
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, workspace_id, trigger_execution_id)
       VALUES ('task-1', 'proj-1', 'user-1', 'Child', ?, 'ws-1', ?)`
    )
    .run(status, triggerExecutionStatus ? 'exec-1' : null);
}

function executionStatus(): string | undefined {
  return (
    sqlite.prepare(`SELECT status FROM trigger_executions WHERE id = 'exec-1'`).get() as
      { status: string } | undefined
  )?.status;
}

function task(): { status: string } {
  return sqlite.prepare(`SELECT status FROM tasks WHERE id = 'task-1'`).get() as {
    status: string;
  };
}

function statusEvents(): Array<{ to_status: string }> {
  return sqlite
    .prepare(`SELECT to_status FROM task_status_events WHERE task_id = 'task-1'`)
    .all() as Array<{ to_status: string }>;
}

function ctx(): ToolContext {
  return { env: { DATABASE: racingD1() } as Record<string, unknown>, userId: 'user-1' };
}

describe('SAM stop_subtask cancellation CAS', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    afterTaskRead = null;
    cleanup.mockClear();
    stopAgent.mockClear();
  });

  it.each(['in_progress', 'delegated', 'queued'])(
    'cancels a %s task, stops its agent and records the event (control)',
    async (status) => {
      seedTask(status, 'running');
      const result = (await stopSubtask({ taskId: 'task-1' }, ctx())) as Record<string, unknown>;
      expect(result.stopped).toBe(true);
      expect(task().status).toBe('cancelled');
      expect(statusEvents()).toEqual([{ to_status: 'cancelled' }]);
      expect(stopAgent).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      // A trigger-linked task's execution follows it, as the MCP stop_subtask does.
      expect(executionStatus()).toBe('failed');
    }
  );

  it('cancels a sleeping task without stopping (and so waking) its agent', async () => {
    seedTask('sleeping');
    const result = (await stopSubtask({ taskId: 'task-1' }, ctx())) as Record<string, unknown>;
    expect(result.stopped).toBe(true);
    expect(task().status).toBe('cancelled');
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'])(
    'does not overwrite a task that became %s after the read, nor stop its agent',
    async (concurrentStatus) => {
      seedTask('in_progress', 'running');
      afterTaskRead = () => {
        sqlite.prepare(`UPDATE tasks SET status = ? WHERE id = 'task-1'`).run(concurrentStatus);
      };
      const result = (await stopSubtask({ taskId: 'task-1' }, ctx())) as Record<string, unknown>;
      expect(afterTaskRead).toBeNull(); // the race was actually injected
      expect(result.stopped).toBeUndefined();
      expect(result.error).toContain('changed status');
      expect(task().status).toBe(concurrentStatus);
      expect(statusEvents()).toEqual([]);
      expect(stopAgent).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(executionStatus()).toBe('running');
    }
  );
});
