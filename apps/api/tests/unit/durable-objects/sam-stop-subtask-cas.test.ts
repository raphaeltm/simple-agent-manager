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
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const cleanup = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: cleanup,
}));
vi.mock('../../../src/services/node-agent', () => ({
  stopAgentSessionOnNode: vi.fn(async () => undefined),
}));

let sqlite: Database.Database;
let afterTaskRead: (() => void) | null;

function racingD1(): D1Database {
  const d1 = createSqliteD1(sqlite) as D1Database & {
    prepare(sql: string): D1PreparedStatement;
  };
  const prepare = d1.prepare.bind(d1);
  const after = <T>(sql: string, promise: Promise<T>): Promise<T> =>
    promise.then((result) => {
      if (afterTaskRead && /^\s*select/i.test(sql) && sql.includes('from "tasks"')) {
        const hook = afterTaskRead;
        afterTaskRead = null;
        hook();
      }
      return result;
    });
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      ...statement,
      bind: (...params: unknown[]) => wrap(sql, statement.bind(...params)),
      all: () => after(sql, statement.all()),
      raw: (...args: unknown[]) =>
        after(sql, (statement.raw as (...a: unknown[]) => Promise<unknown>)(...args)),
      first: (...args: unknown[]) =>
        after(sql, (statement.first as (...a: unknown[]) => Promise<unknown>)(...args)),
      run: () => after(sql, statement.run()),
    }) as D1PreparedStatement;
  return { ...d1, prepare: (sql: string) => wrap(sql, prepare(sql)) } as D1Database;
}

function seedTask(status: string): void {
  sqlite.prepare(`INSERT INTO projects (id, user_id, name) VALUES ('proj-1', 'user-1', 'P')`).run();
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status)
       VALUES ('task-1', 'proj-1', 'user-1', 'Child', ?)`
    )
    .run(status);
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
  });

  it('cancels an in_progress task and records the event (control)', async () => {
    seedTask('in_progress');
    const result = (await stopSubtask({ taskId: 'task-1' }, ctx())) as Record<string, unknown>;
    expect(result.stopped).toBe(true);
    expect(task().status).toBe('cancelled');
    expect(statusEvents()).toEqual([{ to_status: 'cancelled' }]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a completion that lands after the read', async () => {
    seedTask('in_progress');
    afterTaskRead = () => {
      sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 'task-1'`).run();
    };
    const result = (await stopSubtask({ taskId: 'task-1' }, ctx())) as Record<string, unknown>;
    expect(afterTaskRead).toBeNull(); // the race was actually injected
    expect(result.stopped).toBeUndefined();
    expect(result.error).toContain('changed status');
    expect(task().status).toBe('completed');
    expect(statusEvents()).toEqual([]);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
