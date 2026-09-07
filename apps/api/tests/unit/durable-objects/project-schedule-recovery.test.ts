import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  reconcileSchedule,
  withScheduleExecution,
} from '../../../src/durable-objects/project-data/project-event-schedules-recovery';
import {
  createSchedule,
  getSchedule,
} from '../../../src/durable-objects/project-data/project-event-schedules-storage';
import { createWatch } from '../../../src/durable-objects/project-data/project-standing-watches-storage';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(':memory:');
  const d1 = new Database(':memory:');
  databases.push(db, d1);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.reader ? stmt.all(...bindings) : [];
      const changes = stmt.reader ? 0 : stmt.run(...bindings).changes;
      return {
        toArray: () => rows,
        rowsWritten: changes,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  runMigrations(sql);
  createSchemaTables(d1, [
    schema.users,
    schema.projects,
    schema.projectMembers,
    schema.tasks,
    schema.taskSubmissionCheckpoints,
  ]);
  d1.exec(
    "INSERT INTO users (id,status) VALUES ('u','active'); INSERT INTO projects (id,user_id) VALUES ('p','u'); INSERT INTO project_members (project_id,user_id,status,role) VALUES ('p','u','active','owner')"
  );
  const env = { DATABASE: createSqliteD1(d1) } as Env;
  const now = Date.now();
  const schedule = createSchedule(
    sql,
    env,
    'p',
    { userId: 'u', chatSessionId: null },
    {
      action: { kind: 'start_session', prompt: 'Inspect the project' },
      dueAt: now + 1000,
      displayTimezone: 'UTC',
      idempotencyKey: 'recovery',
    },
    now
  ).schedule;
  sql.exec(
    `UPDATE project_schedules SET state='ambiguous', event_id='event', next_attempt_at=NULL,
    reserved_task_id='task', reserved_session_id='session', reserved_message_id='message', reserved_status_id='status',
    attempt_count=8, last_error='Lost receipt' WHERE id=?`,
    schedule.id
  );
  const receipt = (status = 'queued') => {
    d1.prepare(
      "INSERT INTO tasks (id,project_id,user_id,status,chat_session_id) VALUES ('task','p','u',?,'session')"
    ).run(status);
    d1.prepare(
      "INSERT INTO task_submission_checkpoints (task_id,project_id,user_id,source_kind,source_id,source_execution_id,chat_session_id,checkpoint_state) VALUES ('task','p','u','schedule',?,?,'session','start_pending')"
    ).run(schedule.id, schedule.id);
  };
  const reconcile = (retrySubmission = false, expectedVersion = 1) =>
    reconcileSchedule(sql, env, 'p', schedule.id, { expectedVersion, retrySubmission });
  const row = () =>
    db.prepare('SELECT * FROM project_schedules WHERE id=?').get(schedule.id) as Record<
      string,
      unknown
    >;
  return { db, d1, sql, env, now, schedule, receipt, reconcile, row };
}

describe('versioned schedule recovery', () => {
  it('holds missing receipts and rejects explicit retry without evidence of a matching task', async () => {
    const f = fixture();
    const before = f.row();
    expect(await f.reconcile()).toMatchObject({
      changed: false,
      recovery: { outcome: 'unresolved' },
      schedule: { execution: { status: 'unavailable', retrySubmissionAllowed: false } },
    });
    await expect(f.reconcile(true)).rejects.toThrow('retry is unavailable');
    expect(f.row()).toEqual(before);
  });

  it('reopens a queued checkpoint using the original reserved identities, fingerprint and deadline', async () => {
    const f = fixture();
    f.receipt();
    const before = f.row();
    const observed = await f.reconcile();
    expect(observed).toMatchObject({
      changed: false,
      schedule: {
        state: 'ambiguous',
        execution: { status: 'queued', retrySubmissionAllowed: true },
      },
    });
    const result = await f.reconcile(true);
    expect(result).toMatchObject({
      changed: true,
      recovery: { outcome: 'retry_scheduled' },
      schedule: { state: 'admitted', version: 2, attemptCount: 0 },
    });
    const after = f.row();
    for (const key of [
      'id',
      'fingerprint',
      'action_json',
      'due_at',
      'expires_at',
      'event_id',
      'reserved_task_id',
      'reserved_session_id',
      'reserved_message_id',
      'reserved_status_id',
    ])
      expect(after[key]).toBe(before[key]);
    expect(after.execution_finished_at).toBeNull();
    expect(after.next_attempt_at).toEqual(expect.any(Number));
    await expect(f.reconcile(true)).rejects.toThrow('version conflict');
  });

  it.each(['delegated', 'in_progress', 'awaiting_followup', 'completed', 'failed', 'cancelled'])(
    'observes %s without replaying task admission',
    async (status) => {
      const f = fixture();
      f.receipt(status);
      const result = await f.reconcile();
      expect(result.schedule.execution).toMatchObject({ status, retrySubmissionAllowed: false });
      expect(result.recovery?.outcome).toBe('observed');
      expect(f.row().submission_completed_at).toEqual(expect.any(Number));
      if (['completed', 'failed', 'cancelled'].includes(status))
        expect(f.row().execution_finished_at).toEqual(expect.any(Number));
      else
        expect(f.row()).toMatchObject({
          state: 'admitted',
          execution_finished_at: null,
          next_attempt_at: expect.any(Number),
        });
    }
  );

  it('refuses expired deadlines, revoked creators and colliding checkpoints', async () => {
    const f = fixture();
    f.receipt();
    f.d1.exec("UPDATE project_members SET role='viewer'");
    await expect(f.reconcile(true)).rejects.toThrow('no longer has project access');
    f.d1.exec(
      "UPDATE project_members SET role='owner'; UPDATE task_submission_checkpoints SET source_execution_id='foreign'"
    );
    await expect(f.reconcile(true)).rejects.toThrow('retry is unavailable');
    f.d1.prepare('UPDATE task_submission_checkpoints SET source_execution_id=?').run(f.schedule.id);
    f.sql.exec(
      'UPDATE project_schedules SET expires_at=? WHERE id=?',
      Date.now() - 1,
      f.schedule.id
    );
    await expect(f.reconcile(true)).rejects.toThrow('retry is unavailable');
    expect(f.row()).toMatchObject({
      state: 'ambiguous',
      execution_finished_at: null,
      next_attempt_at: null,
    });
  });

  it('does not interrupt an active submission when refreshing a queued receipt', async () => {
    const f = fixture();
    f.receipt();
    f.sql.exec(
      "UPDATE project_schedules SET state='admitted', next_attempt_at=?, claim_token='in-flight' WHERE id=?",
      f.now,
      f.schedule.id
    );
    const before = f.row();
    expect(await f.reconcile()).toMatchObject({ changed: false });
    expect(f.row()).toEqual(before);
  });

  it('reports read failures as unavailable without permitting an unsafe retry', async () => {
    const f = fixture();
    f.receipt();
    f.d1.exec('DROP TABLE task_submission_checkpoints');
    const result = await withScheduleExecution(f.sql, f.env, [
      getSchedule(f.sql, 'p', f.schedule.id)!,
    ]);
    expect(result[0]?.execution).toMatchObject({
      status: 'unavailable',
      retrySubmissionAllowed: false,
    });
  });

  it('does not reopen an exhausted schedule when the project active capacity is full', async () => {
    const f = fixture();
    f.receipt();
    f.env.PROJECT_EVENT_SCHEDULE_MAX_SCHEDULES = '1';
    createSchedule(
      f.sql,
      f.env,
      'p',
      { userId: 'u', chatSessionId: null },
      {
        action: { kind: 'start_session', prompt: 'Other work' },
        dueAt: Date.now() + 1000,
        displayTimezone: 'UTC',
        idempotencyKey: 'occupies-capacity',
      },
      Date.now()
    );
    await expect(f.reconcile(true)).rejects.toThrow('retry is unavailable');
    expect(f.row()).toMatchObject({ state: 'ambiguous', next_attempt_at: null });
  });

  it('does not reopen a failed watch action after another execution takes its concurrency slot', async () => {
    const f = fixture();
    f.receipt();
    const watch = createWatch(
      f.sql,
      f.env,
      'p',
      'u',
      {
        action: f.schedule.action,
        filter: { version: 1, source: 'github' },
        idempotencyKey: 'watch',
        maxConcurrent: 1,
      },
      Date.now()
    ).watch;
    const other = createSchedule(
      f.sql,
      f.env,
      'p',
      { userId: 'u', chatSessionId: null },
      {
        action: f.schedule.action,
        dueAt: Date.now() + 1000,
        displayTimezone: 'UTC',
        idempotencyKey: 'other-watch-action',
      },
      Date.now()
    ).schedule;
    f.sql.exec(
      "UPDATE project_schedules SET watch_id=?, state='failed' WHERE id=?",
      watch.id,
      f.schedule.id
    );
    f.d1
      .prepare("UPDATE task_submission_checkpoints SET source_kind='standing_watch', source_id=?")
      .run(watch.id);
    f.sql.exec(
      "UPDATE project_schedules SET watch_id=?, state='admitted' WHERE id=?",
      watch.id,
      other.id
    );
    await expect(f.reconcile(true)).rejects.toThrow('retry is unavailable');
    f.sql.exec(
      'UPDATE project_schedules SET execution_finished_at=? WHERE id=?',
      Date.now(),
      other.id
    );
    expect(await f.reconcile(true)).toMatchObject({ recovery: { outcome: 'retry_scheduled' } });
  });

  it.each(['project_id', 'user_id', 'source_kind', 'source_id'])(
    'does not accept a terminal receipt with mismatched checkpoint %s',
    async (column) => {
      const f = fixture();
      f.receipt('completed');
      f.d1.prepare(`UPDATE task_submission_checkpoints SET ${column}='foreign'`).run();
      expect(await f.reconcile()).toMatchObject({
        changed: false,
        recovery: { outcome: 'unresolved' },
      });
      expect(f.row().execution_finished_at).toBeNull();
    }
  );

  it('does not accept a terminal task with a different creator', async () => {
    const f = fixture();
    f.receipt('completed');
    f.d1.exec("UPDATE tasks SET user_id='foreign'");
    expect(await f.reconcile()).toMatchObject({
      changed: false,
      recovery: { outcome: 'unresolved' },
    });
    expect(f.row().execution_finished_at).toBeNull();
  });
});
