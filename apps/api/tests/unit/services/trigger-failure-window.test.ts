import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { tasks, triggerExecutions, triggers } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { consecutiveFailureCount } from '../../../src/services/trigger-failure-window';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function setup() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [tasks, triggerExecutions, triggers]);
  sqlite
    .prepare(
      `INSERT INTO triggers(id,project_id,user_id,name,status,source_type)
    VALUES('tr','p','u','GitHub','active','github')`
    )
    .run();
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;
  let sequence = 0;
  const execution = (status: string, error: string | null = null, taskId: string | null = null) => {
    const id = `execution-${++sequence}`;
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
      (id,trigger_id,project_id,status,error_message,task_id,sequence_number)
      VALUES(?,'tr','p',?,?,?,?)`
      )
      .run(id, status, error, taskId, sequence);
    return id;
  };
  return { sqlite, env, execution };
}

describe('trigger failure window', () => {
  it('counts distinct failed submissions before and after queue expiry, ignoring neutral events', async () => {
    const { env, execution } = setup();
    execution('failed');
    execution('dropped', 'Submission failed');
    execution('queued', 'Submission unavailable');
    for (const status of ['waiting', 'routing', 'routed', 'skipped', 'dropped']) execution(status);
    expect(await consecutiveFailureCount(env, 'tr', 3)).toEqual({ count: 3, resetSequence: null });
    expect(await consecutiveFailureCount(env, 'tr', 3)).toEqual({ count: 3, resetSequence: null });
  });

  it('does not count the execution being retried or pre-resume failures', async () => {
    const { sqlite, env, execution } = setup();
    execution('dropped', 'Old failed submission');
    const retry = execution('queued', 'Repeated failed submission');
    expect((await consecutiveFailureCount(env, 'tr', 3, retry)).count).toBe(1);
    sqlite.prepare('UPDATE triggers SET auto_pause_reset_sequence=2').run();
    expect(await consecutiveFailureCount(env, 'tr', 3, retry)).toEqual({
      count: 0,
      resetSequence: null,
    });
    expect(await consecutiveFailureCount(env, 'tr', 3)).toEqual({ count: 1, resetSequence: 2 });
  });

  it.each(['completed', 'running', 'queued'])(
    'a %s execution without a submission failure breaks the window',
    async (status) => {
      const { env, execution } = setup();
      execution('dropped', 'Failed submission');
      execution(status, status === 'queued' ? null : 'Old transient failure');
      expect((await consecutiveFailureCount(env, 'tr', 3)).count).toBe(0);
    }
  );

  it('does not count linked tasks or verified live recovery owners as failed submissions', async () => {
    const { sqlite, env, execution } = setup();
    sqlite
      .prepare(
        `INSERT INTO tasks(id,project_id,status,superseded_by_task_id)
      VALUES('source','p','cancelled','recovery')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO tasks(id,project_id,status,recovery_source_task_id,triggered_by)
      VALUES('recovery','p','in_progress','source','session-recovery')`
      )
      .run();
    execution('failed', 'Old failure', 'source');
    expect((await consecutiveFailureCount(env, 'tr', 3)).count).toBe(0);
    execution('queued', 'Old failure', 'source');
    expect((await consecutiveFailureCount(env, 'tr', 3)).count).toBe(0);
    execution('dropped', 'Old failure', 'source');
    expect((await consecutiveFailureCount(env, 'tr', 3)).count).toBe(0);
  });
});
