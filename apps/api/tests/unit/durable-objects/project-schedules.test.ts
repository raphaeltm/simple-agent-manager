import type { ProjectScheduledAction } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { submitReservedTaskMock } = vi.hoisted(() => ({ submitReservedTaskMock: vi.fn() }));
vi.mock('../../../src/services/reserved-task-submission', () => ({
  submitReservedTask: submitReservedTaskMock,
}));

import * as schema from '../../../src/db/schema';
import { runMigrations } from '../../../src/durable-objects/migrations';
import type { DurabilityFoundationHooks } from '../../../src/durable-objects/project-data/durability-foundation';
import type { ProjectEventScheduleEnv } from '../../../src/durable-objects/project-data/project-event-schedules-config';
import {
  computeScheduleAlarmTime,
  runScheduleAlarm,
} from '../../../src/durable-objects/project-data/project-event-schedules-runner';
import {
  cancelSchedule,
  createSchedule,
  getSchedule,
  listSchedules,
  rescheduleSchedule,
} from '../../../src/durable-objects/project-data/project-event-schedules-storage';
import { admitProjectEvent } from '../../../src/durable-objects/project-data/project-events';
import {
  computeStandingWatchAlarmTime,
  runStandingWatchAlarm,
} from '../../../src/durable-objects/project-data/project-standing-watches-runner';
import {
  createWatch,
  getWatch,
  listWatches,
  pauseWatch,
  revokeWatch,
  updateWatch,
} from '../../../src/durable-objects/project-data/project-standing-watches-storage';
import { acceptPromptDeliveryInTransaction } from '../../../src/durable-objects/project-data/prompt-delivery';
import type { Env } from '../../../src/durable-objects/project-data/types';
import type { ReservedTaskSubmissionInput } from '../../../src/services/reserved-task-submission';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = 1_780_000_000_000;
const PROJECT = 'schedule-project';
const USER = 'schedule-user';
const CHAT = 'schedule-chat';
const TASK = 'schedule-task';
const creator = { userId: USER, chatSessionId: CHAT };
const startAction: ProjectScheduledAction = {
  kind: 'start_session',
  prompt: 'Run the scheduled check',
  agentProfileId: null,
  skillId: null,
};
const messageAction: ProjectScheduledAction = {
  kind: 'message_session',
  sessionId: CHAT,
  prompt: 'Continue the scheduled check',
};
const databases: Database.Database[] = [];

/** Real SQLite cursor semantics, including UPDATE/INSERT ... RETURNING. */
function sqliteStorage(db: Database.Database, beforeExec: (query: string) => void): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]) {
      beforeExec(query);
      const statement = db.prepare(query);
      const rows = statement.reader ? statement.all(...bindings) : [];
      const write = statement.reader ? null : statement.run(...bindings);
      const rowsWritten = statement.readonly
        ? 0
        : (write?.changes ??
          (db.prepare('SELECT changes() AS count').get() as { count: number }).count);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one SQL row, got ${rows.length}`);
          return rows[0];
        },
        rowsWritten,
        rowsRead: rows.length,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides: ProjectEventScheduleEnv = {}) {
  const db = new Database(':memory:');
  const d1 = new Database(':memory:');
  databases.push(db, d1);
  const faults = { beforeExec: (_query: string) => {}, beforeAuthority: async () => {} };
  const sql = sqliteStorage(db, (query) => faults.beforeExec(query));
  runMigrations(sql);
  createSchemaTables(d1, [schema.users, schema.projects, schema.projectMembers, schema.tasks]);
  d1.prepare('INSERT INTO users (id,status) VALUES (?,?)').run(USER, 'active');
  d1.prepare('INSERT INTO projects (id,user_id) VALUES (?,?)').run(PROJECT, USER);
  d1.prepare('INSERT INTO project_members (project_id,user_id,status,role) VALUES (?,?,?,?)').run(
    PROJECT,
    USER,
    'active',
    'maintainer'
  );
  d1.prepare(
    'INSERT INTO tasks (id,project_id,user_id,status,chat_session_id) VALUES (?,?,?,?,?)'
  ).run(TASK, PROJECT, USER, 'in_progress', CHAT);
  sql.exec(
    `INSERT INTO chat_sessions
    (id,workspace_id,task_id,topic,status,message_count,started_at,created_at,updated_at)
    VALUES (?,NULL,?,'Scheduled conversation','active',0,?,?,?)`,
    CHAT,
    TASK,
    NOW,
    NOW,
    NOW
  );
  const database = createSqliteD1(d1);
  const wrappedDatabase = {
    ...database,
    prepare(query: string) {
      const statement = database.prepare(query);
      return {
        ...statement,
        bind(...bindings: unknown[]) {
          const bound = statement.bind(...bindings);
          return {
            ...bound,
            async first(column?: string) {
              if (query.includes('project_members')) await faults.beforeAuthority();
              return bound.first(column);
            },
          };
        },
      };
    },
  } as D1Database;
  const env = {
    DATABASE: wrappedDatabase,
    PROJECT_EVENT_SCHEDULE_MAX_SCHEDULES: '10',
    PROJECT_EVENT_SCHEDULE_MAX_WATCHES: '10',
    PROJECT_EVENT_SCHEDULE_MAX_HORIZON_MS: '10000',
    PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS: '1000',
    PROJECT_EVENT_SCHEDULE_DELIVERY_TTL_MS: '500',
    PROJECT_EVENT_SCHEDULE_CLAIM_LEASE_MS: '100',
    PROJECT_EVENT_SCHEDULE_RETRY_BASE_MS: '10',
    PROJECT_EVENT_SCHEDULE_MAX_ATTEMPTS: '3',
    PROJECT_EVENT_SCHEDULE_MAX_DEFERRAL_MS: '1000',
    PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS: '20',
    PROJECT_EVENT_WATCH_MAX_EXECUTIONS: '3',
    PROJECT_EVENT_WATCH_MAX_CONCURRENT: '2',
    ...overrides,
  } as Env & ProjectEventScheduleEnv;
  const hooks: DurabilityFoundationHooks = {
    getProjectId: () => PROJECT,
    transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
    waitUntil: () => {},
    recalculateAlarm: vi.fn(async () => undefined),
    scheduleSummarySync: vi.fn(),
    broadcastEvent: vi.fn(),
  };
  const create = (key: string, action = messageAction, extra: Record<string, unknown> = {}) =>
    hooks.transactionSync(() =>
      createSchedule(
        sql,
        env,
        PROJECT,
        creator,
        {
          action,
          dueAt: Date.now(),
          displayTimezone: 'UTC',
          idempotencyKey: key,
          ...extra,
        },
        Date.now()
      )
    );
  const watch = (key: string, extra: Record<string, unknown> = {}) =>
    hooks.transactionSync(() =>
      createWatch(
        sql,
        env,
        PROJECT,
        USER,
        {
          action: messageAction,
          filter: { version: 1, source: 'github' },
          idempotencyKey: key,
          maxConcurrent: 1,
          maxExecutions: 2,
          cooldownMs: 20,
          ...extra,
        },
        Date.now()
      )
    );
  const emit = (key: string) =>
    hooks.transactionSync(() =>
      admitProjectEvent(sql, env, PROJECT, {
        projectId: PROJECT,
        source: 'github',
        eventType: 'check.completed',
        subject: { type: 'check', id: key },
        deliveryKey: key,
        payloadFingerprint: key,
        metadata: { result: 'ready' },
      })
    );
  const effects = () => ({
    events: db.prepare("SELECT id FROM project_events WHERE source = 'sam.schedule'").all(),
    mailbox: db
      .prepare("SELECT id FROM session_inbox WHERE source_kind = 'scheduled_action'")
      .all(),
    transcript: db.prepare('SELECT id FROM chat_messages').all(),
  });
  return { db, d1, sql, env, hooks, faults, create, watch, emit, effects };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  submitReservedTaskMock.mockReset();
});
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

describe('project schedules — real migrations, CRUD and canonical admission', () => {
  it('replays the original normalized key after expiry and rejects a changed payload', async () => {
    const f = fixture();
    const request = {
      action: startAction,
      dueAt: NOW,
      displayTimezone: 'UTC',
      idempotencyKey: ' replay ',
    };
    const first = f.hooks.transactionSync(() =>
      createSchedule(f.sql, f.env, PROJECT, creator, request, NOW)
    );
    vi.setSystemTime(NOW + 1001);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    const replay = f.hooks.transactionSync(() =>
      createSchedule(f.sql, f.env, PROJECT, creator, request, Date.now())
    );
    expect(replay).toMatchObject({
      changed: false,
      idempotent: true,
      schedule: { id: first.schedule.id, state: 'expired', idempotencyKey: 'replay' },
    });
    expect(() =>
      createSchedule(
        f.sql,
        f.env,
        PROJECT,
        creator,
        {
          ...request,
          action: { ...startAction, prompt: 'different' },
        },
        Date.now()
      )
    ).toThrow(/idempotency conflict/i);
    expect(computeScheduleAlarmTime(f.sql, PROJECT)).toBeNull();
    expect(f.effects()).toEqual({ events: [], mailbox: [], transcript: [] });
    expect(submitReservedTaskMock).not.toHaveBeenCalled();
  });

  it('does not retry an admitted-but-unconfirmed task after its finite schedule deadline', async () => {
    const f = fixture({ PROJECT_EVENT_SCHEDULE_MAX_ATTEMPTS: '8' });
    submitReservedTaskMock.mockRejectedValue(new Error('lost start acknowledgement'));
    const id = f.create('deadline', startAction).schedule.id;
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(submitReservedTaskMock).toHaveBeenCalledOnce();
    vi.setSystemTime(NOW + 1001);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(submitReservedTaskMock).toHaveBeenCalledOnce();
    expect(getSchedule(f.sql, PROJECT, id)).toMatchObject({
      state: 'ambiguous',
      nextAttemptAt: null,
    });
  });

  it('uses versioned RETURNING mutations for reschedule, cancel and cancellation replay', () => {
    const f = fixture();
    const first = f.create('versions').schedule;
    const updated = f.hooks.transactionSync(() =>
      rescheduleSchedule(
        f.sql,
        f.env,
        PROJECT,
        first.id,
        { expectedVersion: 1, dueAt: NOW + 100, displayTimezone: 'Europe/Paris' },
        NOW
      )
    );
    expect(updated.schedule).toMatchObject({
      version: 2,
      dueAt: NOW + 100,
      displayTimezone: 'Europe/Paris',
    });
    expect(computeScheduleAlarmTime(f.sql, PROJECT)).toBe(NOW + 100);
    expect(() =>
      rescheduleSchedule(
        f.sql,
        f.env,
        PROJECT,
        first.id,
        { expectedVersion: 1, dueAt: NOW + 200 },
        NOW
      )
    ).toThrow(/version conflict/i);
    const cancelled = f.hooks.transactionSync(() =>
      cancelSchedule(
        f.sql,
        f.env,
        PROJECT,
        first.id,
        { expectedVersion: 2, reason: 'No longer needed' },
        NOW
      )
    );
    expect(cancelled.schedule).toMatchObject({ state: 'cancelled', version: 3 });
    expect(
      cancelSchedule(
        f.sql,
        f.env,
        PROJECT,
        first.id,
        { expectedVersion: 2, reason: 'No longer needed' },
        NOW
      )
    ).toMatchObject({ idempotent: true, changed: false });
    expect(computeScheduleAlarmTime(f.sql, PROJECT)).toBeNull();
    expect(getSchedule(f.sql, 'another-project', first.id)).toBeNull();
  });

  it.each([
    'cancel schedule',
    'cancel start schedule',
    'archive chat',
    'cancel task',
    'suspend member',
  ] as const)(
    '%s while the final authority read is held admits no event, message or task',
    async (change) => {
      const f = fixture();
      const schedule = f.create(
        'held-read',
        change === 'cancel start schedule' ? startAction : messageAction
      ).schedule;
      const entered = deferred(),
        released = deferred();
      f.faults.beforeAuthority = async () => {
        entered.resolve();
        await released.promise;
      };
      const alarm = runScheduleAlarm(f.sql, f.env, f.hooks);
      await entered.promise;
      if (change === 'cancel schedule' || change === 'cancel start schedule')
        f.hooks.transactionSync(() =>
          cancelSchedule(f.sql, f.env, PROJECT, schedule.id, { expectedVersion: 1 }, Date.now())
        );
      if (change === 'archive chat')
        f.sql.exec("UPDATE chat_sessions SET status = 'archived' WHERE id = ?", CHAT);
      if (change === 'cancel task')
        f.d1.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(TASK);
      if (change === 'suspend member')
        f.d1.prepare("UPDATE project_members SET status = 'suspended'").run();
      released.resolve();
      await alarm;
      expect(f.effects()).toEqual({ events: [], mailbox: [], transcript: [] });
      expect(submitReservedTaskMock).not.toHaveBeenCalled();
      expect(getSchedule(f.sql, PROJECT, schedule.id)?.state).toBe(
        change === 'cancel schedule' || change === 'cancel start schedule' ? 'cancelled' : 'failed'
      );
    }
  );

  it.each(['busy', 'sleeping'] as const)(
    'queues atomically into the same %s conversation',
    async (status) => {
      const f = fixture();
      if (status === 'sleeping')
        f.sql.exec("UPDATE chat_sessions SET status = 'sleeping' WHERE id = ?", CHAT);
      if (status === 'busy') {
        const prior = f.hooks.transactionSync(() =>
          acceptPromptDeliveryInTransaction(
            f.sql,
            f.env,
            {
              targetSessionId: CHAT,
              displayContent: 'Existing work',
              senderType: 'system',
              sourceKind: 'agent_mailbox',
            },
            NOW
          )
        );
        f.sql.exec(
          "UPDATE session_inbox SET delivery_state = 'delivering' WHERE id = ?",
          prior.message.id
        );
      }
      const before = f.effects();
      const schedule = f.create('same-chat').schedule;
      await runScheduleAlarm(f.sql, f.env, f.hooks);
      const stored = getSchedule(f.sql, PROJECT, schedule.id)!;
      expect(stored).toMatchObject({
        state: 'admitted',
        resultSessionId: CHAT,
        resultTaskId: null,
      });
      expect(stored.eventId).toEqual(expect.any(String));
      expect(stored.deliveryId).toEqual(expect.any(String));
      expect(f.effects().events).toHaveLength(1);
      expect(f.effects().mailbox).toHaveLength(1);
      expect(f.effects().transcript).toHaveLength(before.transcript.length + 1);
      expect(
        f.db
          .prepare(
            'SELECT target_session_id, source_task_id, delivery_state, expires_at FROM session_inbox WHERE id = ?'
          )
          .get(stored.deliveryId)
      ).toEqual({
        target_session_id: CHAT,
        source_task_id: TASK,
        delivery_state: 'queued',
        expires_at: NOW + 500,
      });
      expect(f.db.prepare('SELECT id, task_id, status FROM chat_sessions').all()).toEqual([
        { id: CHAT, task_id: TASK, status: status === 'sleeping' ? 'sleeping' : 'active' },
      ]);
      expect(submitReservedTaskMock).not.toHaveBeenCalled();
      const cancelled = cancelSchedule(
        f.sql,
        f.env,
        PROJECT,
        schedule.id,
        { expectedVersion: 1 },
        NOW
      );
      expect(cancelled).toMatchObject({ changed: false, actionAlreadyAdmitted: true });
      await runScheduleAlarm(f.sql, f.env, f.hooks);
      expect(f.effects().events).toHaveLength(1);
      expect(f.effects().mailbox).toHaveLength(1);
    }
  );

  it('rolls event and transcript admission back if the mailbox storage write fails', async () => {
    const f = fixture();
    const schedule = f.create('storage-failure').schedule;
    f.faults.beforeExec = (query) => {
      if (query.includes('INSERT INTO session_inbox'))
        throw new Error('SQLite mailbox write unavailable');
    };
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(getSchedule(f.sql, PROJECT, schedule.id)).toMatchObject({
      state: 'pending',
      eventId: null,
      deliveryId: null,
    });
    expect(f.effects()).toEqual({ events: [], mailbox: [], transcript: [] });
    f.faults.beforeExec = () => {};
    vi.setSystemTime(NOW + 10);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(getSchedule(f.sql, PROJECT, schedule.id)?.state).toBe('admitted');
    expect(f.effects().events).toHaveLength(1);
    expect(f.effects().mailbox).toHaveLength(1);
  });

  it('keeps a message execution live until its canonical mailbox receipt becomes terminal', async () => {
    const f = fixture();
    const id = f.create('receipt').schedule.id;
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    vi.setSystemTime(NOW + 10);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(
      f.db.prepare('SELECT execution_finished_at FROM project_schedules WHERE id = ?').get(id)
    ).toEqual({ execution_finished_at: null });
    f.sql.exec(
      "UPDATE session_inbox SET delivery_state = 'acked' WHERE id = ?",
      getSchedule(f.sql, PROJECT, id)!.deliveryId
    );
    vi.setSystemTime(NOW + 20);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(
      f.db
        .prepare('SELECT execution_finished_at,next_attempt_at FROM project_schedules WHERE id = ?')
        .get(id)
    ).toEqual({ execution_finished_at: NOW + 20, next_attempt_at: null });
  });

  it.each(['viewer', 'suspended'] as const)(
    'refuses start actions for a %s creator without side effects',
    async (denial) => {
      const f = fixture();
      const id = f.create('creator-denied', startAction).schedule.id;
      if (denial === 'viewer') f.d1.exec("UPDATE project_members SET role = 'viewer'");
      else f.d1.exec("UPDATE project_members SET status = 'suspended'");
      await runScheduleAlarm(f.sql, f.env, f.hooks);
      expect(getSchedule(f.sql, PROJECT, id)?.state).toBe('failed');
      expect(f.effects()).toEqual({ events: [], mailbox: [], transcript: [] });
      expect(submitReservedTaskMock).not.toHaveBeenCalled();
    }
  );

  it('reuses all reserved identities across thrown/lost replies and stops resubmitting after acknowledgement', async () => {
    const f = fixture();
    submitReservedTaskMock
      .mockRejectedValueOnce(new Error('lost transport reply'))
      .mockImplementationOnce(async (_env: unknown, input: ReservedTaskSubmissionInput) => ({
        outcome: 'pending',
        reason: 'start acknowledgement unavailable',
        taskId: input.identities.taskId,
        sessionId: input.identities.chatSessionId,
      }))
      .mockImplementationOnce(async (_env: unknown, input: ReservedTaskSubmissionInput) => ({
        outcome: 'admitted',
        taskId: input.identities.taskId,
        sessionId: input.identities.chatSessionId,
        startState: 'confirmed_after_lost_ack',
        reused: true,
      }));
    const id = f.create('stable-reservation', startAction).schedule.id;
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    const first = submitReservedTaskMock.mock.calls[0]![1] as ReservedTaskSubmissionInput;
    expect(
      Object.values(first.identities).every(
        (value) => typeof value === 'string' && value.length > 0
      )
    ).toBe(true);
    expect(new Set(Object.values(first.identities)).size).toBe(4);
    expect(cancelSchedule(f.sql, f.env, PROJECT, id, { expectedVersion: 1 }, NOW)).toMatchObject({
      actionAlreadyAdmitted: true,
      changed: false,
    });
    vi.setSystemTime(NOW + 10);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    vi.setSystemTime(NOW + 20);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(submitReservedTaskMock).toHaveBeenCalledTimes(3);
    for (const call of submitReservedTaskMock.mock.calls) {
      expect((call[1] as ReservedTaskSubmissionInput).identities).toEqual(first.identities);
      expect((call[1] as ReservedTaskSubmissionInput).source).toMatchObject({
        kind: 'schedule',
        sourceExecutionId: id,
        expiresAt: NOW + 1000,
      });
    }
    vi.setSystemTime(NOW + 30);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(submitReservedTaskMock).toHaveBeenCalledTimes(3);
    expect(f.effects().events).toHaveLength(1);
    expect(f.effects().mailbox).toHaveLength(0);
    expect(getSchedule(f.sql, PROJECT, id)).toMatchObject({
      state: 'admitted',
      resultTaskId: first.identities.taskId,
      resultSessionId: first.identities.chatSessionId,
    });
  });

  it('stops unknown submissions at the attempt cap without issuing new identities', async () => {
    const f = fixture({ PROJECT_EVENT_SCHEDULE_MAX_ATTEMPTS: '2' });
    submitReservedTaskMock.mockRejectedValue(new Error('acknowledgement unavailable'));
    const id = f.create('bounded-retry', startAction).schedule.id;
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    vi.setSystemTime(NOW + 10);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(getSchedule(f.sql, PROJECT, id)).toMatchObject({
      state: 'ambiguous',
      nextAttemptAt: null,
    });
    vi.setSystemTime(NOW + 500);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    expect(submitReservedTaskMock).toHaveBeenCalledTimes(2);
  });

  it('uses stable tuple cursors and rejects cross-project or cross-session continuation', () => {
    const f = fixture();
    const ids = ['a', 'b', 'c'].map((key) => f.create(key).schedule.id);
    const first = listSchedules(f.sql, f.env, PROJECT, { sessionId: CHAT, limit: 1 });
    const second = listSchedules(f.sql, f.env, PROJECT, {
      sessionId: CHAT,
      limit: 1,
      cursor: first.nextCursor,
    });
    const third = listSchedules(f.sql, f.env, PROJECT, {
      sessionId: CHAT,
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(
      new Set([...first.schedules, ...second.schedules, ...third.schedules].map((row) => row.id))
    ).toEqual(new Set(ids));
    expect(third.nextCursor).toBeNull();
    expect(() =>
      listSchedules(f.sql, f.env, 'other-project', { sessionId: CHAT, cursor: first.nextCursor })
    ).toThrow(/cursor/i);
    expect(() =>
      listSchedules(f.sql, f.env, PROJECT, { sessionId: 'other-chat', cursor: first.nextCursor })
    ).toThrow(/cursor/i);
    expect(listSchedules(f.sql, f.env, 'other-project').schedules).toEqual([]);
  });

  it('enforces caps, UTF-8 prompt size, finite TTL/horizon and excludes saved bearer tokens', () => {
    const f = fixture({
      PROJECT_EVENT_SCHEDULE_MAX_SCHEDULES: '1',
      PROJECT_EVENT_SCHEDULE_PROMPT_MAX_BYTES: '4',
    });
    expect(() => f.create('large', { ...messageAction, prompt: '€€' })).toThrow(/bytes|prompt/i);
    expect(() =>
      f.create('horizon', { ...messageAction, prompt: 'ok' }, { dueAt: NOW + 10001 })
    ).toThrow(/horizon/i);
    expect(() =>
      f.create('ttl', { ...messageAction, prompt: 'ok' }, { expiresAt: NOW + 1001 })
    ).toThrow(/grace/i);
    expect(() =>
      f.create(
        'token',
        { ...messageAction, prompt: 'ok' },
        { bearerToken: 'never-store-this-token' }
      )
    ).toThrow(/not allowed/i);
    const kept = f.create('within-cap', { ...messageAction, prompt: 'ok' });
    expect(() => f.create('over-cap', { ...messageAction, prompt: 'ok' })).toThrow(/capacity/i);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM project_schedules').all())).not.toContain(
      'never-store-this-token'
    );
    expect(
      (f.db.prepare('PRAGMA table_info(project_schedules)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    ).not.toContain('bearer_token');
    expect(kept.schedule.creatorUserId).toBe(USER);
  });
});

describe('standing watches — canonical matches, execution limits and revocation', () => {
  it('enforces cooldown, live concurrency and the lifetime execution budget', async () => {
    const f = fixture();
    const watch = f.watch('bounded').watch;
    f.emit('one');
    f.emit('two');
    f.emit('three');
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    expect(getWatch(f.sql, PROJECT, watch.id)?.executionCount).toBe(1);
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    expect(getWatch(f.sql, PROJECT, watch.id)?.executionCount).toBe(1);
    vi.setSystemTime(NOW + 20);
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    expect(getWatch(f.sql, PROJECT, watch.id)?.executionCount).toBe(1);
    const pending = listSchedules(f.sql, f.env, PROJECT).schedules[0]!;
    f.hooks.transactionSync(() =>
      cancelSchedule(f.sql, f.env, PROJECT, pending.id, { expectedVersion: 1 }, Date.now())
    );
    vi.setSystemTime(NOW + 30);
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    expect(getWatch(f.sql, PROJECT, watch.id)?.executionCount).toBe(2);
    vi.setSystemTime(NOW + 100);
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    expect(getWatch(f.sql, PROJECT, watch.id)?.executionCount).toBe(2);
    expect(listSchedules(f.sql, f.env, PROJECT).schedules).toHaveLength(2);
    expect(computeStandingWatchAlarmTime(f.sql, f.env, PROJECT)).toBeNull();
  });

  it('pause cancels unadmitted actions and matching while preserving the admitted mailbox action', async () => {
    const f = fixture();
    const watch = f.watch('pause', { maxConcurrent: 2, maxExecutions: 3 }).watch;
    f.emit('first');
    f.emit('second');
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    await runScheduleAlarm(f.sql, f.env, f.hooks);
    const admitted = listSchedules(f.sql, f.env, PROJECT).schedules[0]!;
    expect(admitted.state).toBe('admitted');
    vi.setSystemTime(NOW + 20);
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    const paused = f.hooks.transactionSync(() =>
      pauseWatch(
        f.sql,
        f.env,
        PROJECT,
        watch.id,
        { expectedVersion: 1, paused: true, reason: 'Pause future work' },
        Date.now()
      )
    );
    expect(paused.watch).toMatchObject({ state: 'paused', version: 2 });
    expect(
      listSchedules(f.sql, f.env, PROJECT)
        .schedules.map((row) => row.state)
        .sort()
    ).toEqual(['admitted', 'cancelled']);
    expect(getSchedule(f.sql, PROJECT, admitted.id)?.deliveryId).toBe(admitted.deliveryId);
    expect(
      f.db
        .prepare('SELECT lifecycle_state FROM project_event_subscriptions WHERE id = ?')
        .get(watch.subscriptionId)
    ).toEqual({ lifecycle_state: 'cancelled' });
    f.emit('while-paused');
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    expect(listSchedules(f.sql, f.env, PROJECT).schedules).toHaveLength(2);
    const resumed = f.hooks.transactionSync(() =>
      pauseWatch(f.sql, f.env, PROJECT, watch.id, { expectedVersion: 2, paused: false }, Date.now())
    );
    expect(resumed.watch.subscriptionId).not.toBe(watch.subscriptionId);
    const revoked = f.hooks.transactionSync(() =>
      revokeWatch(f.sql, f.env, PROJECT, watch.id, { expectedVersion: 3 }, Date.now())
    );
    expect(revoked.watch).toMatchObject({ state: 'revoked', version: 4 });
    expect(getSchedule(f.sql, PROJECT, admitted.id)?.state).toBe('admitted');
    expect(() =>
      pauseWatch(f.sql, f.env, PROJECT, watch.id, { expectedVersion: 4, paused: false }, Date.now())
    ).toThrow(/revoked/i);
  });

  it('rechecks pause and suspended membership after a held authority read', async () => {
    const f = fixture();
    const watch = f.watch('held-watch').watch;
    f.emit('held');
    const entered = deferred(),
      released = deferred();
    f.faults.beforeAuthority = async () => {
      entered.resolve();
      await released.promise;
    };
    const alarm = runStandingWatchAlarm(f.sql, f.env, f.hooks);
    await entered.promise;
    f.hooks.transactionSync(() =>
      pauseWatch(f.sql, f.env, PROJECT, watch.id, { expectedVersion: 1, paused: true }, Date.now())
    );
    released.resolve();
    await alarm;
    expect(listSchedules(f.sql, f.env, PROJECT).schedules).toEqual([]);
    f.faults.beforeAuthority = async () => {};
    const resumed = f.hooks.transactionSync(() =>
      pauseWatch(f.sql, f.env, PROJECT, watch.id, { expectedVersion: 2, paused: false }, Date.now())
    );
    f.emit('suspended');
    f.d1.exec("UPDATE project_members SET status = 'suspended'");
    await runStandingWatchAlarm(f.sql, f.env, f.hooks);
    expect(getWatch(f.sql, PROJECT, resumed.watch.id)?.executionCount).toBe(0);
    expect(listSchedules(f.sql, f.env, PROJECT).schedules).toEqual([]);
    expect(submitReservedTaskMock).not.toHaveBeenCalled();
  });

  it('has idempotent creates, versioned edits, scoped tuple cursors and finite watch caps', () => {
    const f = fixture({ PROJECT_EVENT_SCHEDULE_MAX_WATCHES: '2' });
    const first = f.watch('one').watch;
    expect(f.watch('one')).toMatchObject({ idempotent: true, changed: false });
    expect(() => f.watch('one', { reason: 'different' })).toThrow(/idempotency conflict/i);
    const changed = f.hooks.transactionSync(() =>
      updateWatch(
        f.sql,
        f.env,
        PROJECT,
        first.id,
        { expectedVersion: 1, reason: 'New purpose' },
        NOW
      )
    );
    expect(changed.watch.version).toBe(2);
    expect(changed.watch.subscriptionId).not.toBe(first.subscriptionId);
    expect(() =>
      updateWatch(f.sql, f.env, PROJECT, first.id, { expectedVersion: 1, cooldownMs: 40 }, NOW)
    ).toThrow(/version conflict/i);
    f.watch('two');
    expect(() => f.watch('three')).toThrow(/capacity/i);
    const page = listWatches(f.sql, f.env, PROJECT, { sessionId: CHAT, limit: 1 });
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = listWatches(f.sql, f.env, PROJECT, {
      sessionId: CHAT,
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(new Set([...page.watches, ...next.watches].map((row) => row.id)).size).toBe(2);
    expect(() =>
      listWatches(f.sql, f.env, 'other-project', { sessionId: CHAT, cursor: page.nextCursor })
    ).toThrow(/cursor/i);
    expect(() =>
      listWatches(f.sql, f.env, PROJECT, { sessionId: 'other-chat', cursor: page.nextCursor })
    ).toThrow(/cursor/i);
    expect(getWatch(f.sql, 'other-project', first.id)).toBeNull();
    expect(() => f.watch('too-many', { maxExecutions: 4 })).toThrow(/controls/i);
    expect(() => f.watch('too-fast', { cooldownMs: 19 })).toThrow(/controls/i);
  });
});
