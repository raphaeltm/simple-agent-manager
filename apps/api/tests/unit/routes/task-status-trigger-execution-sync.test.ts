/**
 * Task-terminal → trigger-execution sync in `setTaskStatus` (state-machine audit D6).
 *
 * `setTaskStatus` used to write the linked execution with `WHERE id = ?` only, so a task
 * reaching a terminal state overwrote executions that were already final for other
 * reasons (`skipped`, `dropped`, `routed`, `completed`). The guard is a SQL predicate,
 * so this runs on a real SQLite engine (rule 28) through the real writer.
 */
import { TRIGGER_EXECUTION_HARD_MAX_FAILURE_PREFIX } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { setTaskStatus } from '../../../src/routes/tasks/_helpers';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const TASK_ID = 'task-1';
const EXECUTION_ID = 'exec-1';

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function seed(executionStatus: string, errorMessage: string | null = null): void {
  sqlite
    .prepare(
      `INSERT INTO trigger_executions (id, trigger_id, project_id, status, error_message)
       VALUES (?, 'trigger-1', 'project-1', ?, ?)`
    )
    .run(EXECUTION_ID, executionStatus, errorMessage);
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, trigger_execution_id)
       VALUES (?, 'project-1', 'user-1', 'Nightly sweep', 'in_progress', ?)`
    )
    .run(TASK_ID, EXECUTION_ID);
}

function execution(): { status: string; completed_at: string | null } {
  return sqlite
    .prepare('SELECT status, completed_at FROM trigger_executions WHERE id = ?')
    .get(EXECUTION_ID) as { status: string; completed_at: string | null };
}

async function terminalize(toStatus: 'completed' | 'failed' | 'cancelled'): Promise<void> {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, TASK_ID));
  if (!task) throw new Error('fixture task missing');
  const updated = await setTaskStatus(db, task, toStatus, 'user', 'user-1');
  // Liveness: the task itself always reaches the requested terminal status.
  expect(updated.status).toBe(toStatus);
}

describe('setTaskStatus trigger-execution sync guard', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    db = drizzle(createSqliteD1(sqlite), { schema });
  });

  it('syncs a running execution to completed (control)', async () => {
    seed('running');
    await terminalize('completed');
    expect(execution().status).toBe('completed');
    expect(execution().completed_at).not.toBeNull();
  });

  it('syncs a running execution to failed when the task is cancelled (control)', async () => {
    seed('running');
    await terminalize('cancelled');
    expect(execution().status).toBe('failed');
  });

  it('syncs a hard-max backstop failure once the task terminalizes (control)', async () => {
    seed('failed', `${TRIGGER_EXECUTION_HARD_MAX_FAILURE_PREFIX} exceeded residence bound`);
    await terminalize('completed');
    expect(execution().status).toBe('completed');
  });

  it.each(['skipped', 'dropped', 'routed', 'completed'])(
    'does not overwrite an execution that is already %s',
    async (finalStatus) => {
      seed(finalStatus);
      await terminalize('failed');
      expect(execution().status).toBe(finalStatus);
      expect(execution().completed_at).toBeNull();
    }
  );

  it('does not overwrite an ordinary failed execution with completed', async () => {
    seed('failed', 'Agent crashed');
    await terminalize('completed');
    expect(execution().status).toBe('failed');
  });
});
