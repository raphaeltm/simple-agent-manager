/**
 * `TRIGGER_RUN_TASK_ID_SQL` resolves a trigger execution's live task through verified
 * session-recovery handoffs. On 2026-11-04 production D1 planned its recursive step by
 * looking `successor` up through `idx_tasks_project_user`, reading every task in the project
 * for each execution row: 1.37M rows and ~7 s per admission check, every five minutes, which
 * exhausted the database's 10-second resource window (D1 7429) for every other caller.
 *
 * These tests use real SQLite with the indexes the schema declares, without ANALYZE stats,
 * which is the condition production was in, and enter through `consecutiveFailureCount`.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { tasks, triggerExecutions, triggers } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { consecutiveFailureCount } from '../../../src/services/trigger-failure-window';
import { TRIGGER_RUN_TASK_ID_SQL } from '../../../src/services/trigger-run-slots';
import { createDeclaredIndexes, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-a';
const TRIGGER_ID = 'trigger-a';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  const tables = [tasks, triggers, triggerExecutions];
  createSchemaTables(sqlite, tables);
  createDeclaredIndexes(sqlite, tables);
  sqlite
    .prepare(
      `INSERT INTO triggers (id, project_id, user_id, name, status, source_type, created_at, updated_at)
       VALUES (?, ?, 'user-1', 'n', 'active', 'cron', 'x', 'x')`
    )
    .run(TRIGGER_ID, PROJECT_ID);
  return { sqlite, env: { DATABASE: createSqliteD1(sqlite) } as Env };
}

function insertTask(
  sqlite: Database.Database,
  task: {
    id: string;
    status: string;
    projectId?: string;
    supersededBy?: string;
    recoverySource?: string;
    triggeredBy?: string;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, superseded_by_task_id,
         recovery_source_task_id, triggered_by, created_at, updated_at)
       VALUES (?, ?, 'user-1', 't', ?, ?, ?, ?, 'x', 'x')`
    )
    .run(
      task.id,
      task.projectId ?? PROJECT_ID,
      task.status,
      task.supersededBy ?? null,
      task.recoverySource ?? null,
      task.triggeredBy ?? null
    );
}

function insertExecution(sqlite: Database.Database, id: string, sequence: number, taskId: string) {
  sqlite
    .prepare(
      `INSERT INTO trigger_executions (id, trigger_id, project_id, status, task_id, sequence_number, created_at)
       VALUES (?, ?, ?, 'failed', ?, ?, 'x')`
    )
    .run(id, TRIGGER_ID, PROJECT_ID, taskId, sequence);
}

/** A recent failed run whose cancelled task was handed off to a session-recovery successor. */
function seedRecoveredFailure(sqlite: Database.Database, successorProjectId: string) {
  insertTask(sqlite, { id: 'old-1', status: 'failed' });
  insertTask(sqlite, { id: 'old-2', status: 'failed' });
  insertTask(sqlite, { id: 'source', status: 'cancelled', supersededBy: 'successor' });
  insertTask(sqlite, {
    id: 'successor',
    status: 'in_progress',
    projectId: successorProjectId,
    recoverySource: 'source',
    triggeredBy: 'session-recovery',
  });
  insertExecution(sqlite, 'exec-1', 1, 'old-1');
  insertExecution(sqlite, 'exec-2', 2, 'old-2');
  insertExecution(sqlite, 'exec-3', 3, 'source');
}

describe('TRIGGER_RUN_TASK_ID_SQL query plan', () => {
  it('looks recovery successors up by primary key, not by the project index', () => {
    const { sqlite } = setup();
    // Production-shaped volume: thousands of tasks in the trigger's own project.
    const insert = sqlite.prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'user-1', 't', 'completed', 'x', 'x')`
    );
    for (let i = 0; i < 2000; i += 1) insert.run(`bulk-${i}`, PROJECT_ID);
    for (let i = 0; i < 50; i += 1) insertExecution(sqlite, `bulk-exec-${i}`, i, `bulk-${i}`);

    const plan = (
      sqlite
        .prepare(
          `EXPLAIN QUERY PLAN SELECT t.status FROM trigger_executions e
             LEFT JOIN tasks t ON t.id = ${TRIGGER_RUN_TASK_ID_SQL}
            WHERE e.trigger_id = ?`
        )
        .all(TRIGGER_ID) as { detail: string }[]
    ).map((row) => row.detail);

    const successorSteps = plan.filter((detail) => detail.includes('successor'));
    expect(successorSteps.length).toBeGreaterThan(0);
    expect(
      successorSteps.every((detail) => detail.includes('sqlite_autoindex_tasks_1 (id=?)'))
    ).toBe(true);
    expect(plan.some((detail) => detail.includes('idx_tasks_project_user'))).toBe(false);
  });
});

describe('consecutiveFailureCount through recovery lineage', () => {
  it('stops counting at a failure whose same-project recovery successor is still running', async () => {
    const { sqlite, env } = setup();
    seedRecoveredFailure(sqlite, PROJECT_ID);

    await expect(consecutiveFailureCount(env, TRIGGER_ID, 5)).resolves.toEqual({
      count: 0,
      resetSequence: null,
    });
  });

  it('does not follow a successor from another project', async () => {
    const { sqlite, env } = setup();
    seedRecoveredFailure(sqlite, 'project-b');

    await expect(consecutiveFailureCount(env, TRIGGER_ID, 5)).resolves.toEqual({
      count: 3,
      resetSequence: null,
    });
  });
});
