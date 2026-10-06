import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  boundedScheduleTaskLabel,
  type ProjectEventScheduleEnv,
  scheduleLimits,
} from '../../../src/durable-objects/project-data/project-event-schedules-config';
import {
  cancelSchedule,
  createSchedule,
} from '../../../src/durable-objects/project-data/project-event-schedules-storage';
import { normalizeScheduledAction } from '../../../src/durable-objects/project-data/project-event-schedules-validation';
import { resolveProjectEventLimits } from '../../../src/durable-objects/project-data/project-events-limits';
import {
  createWatch,
  revokeWatch,
  updateWatch,
} from '../../../src/durable-objects/project-data/project-standing-watches-storage';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { validateReservedTaskSubmissionInput } from '../../../src/services/reserved-task-submission-intent';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(overrides: ProjectEventScheduleEnv = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const rows = statement.reader ? statement.all(...bindings) : [];
      const changes = statement.reader ? 0 : statement.run(...bindings).changes;
      return {
        toArray: () => rows,
        rowsWritten: changes,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  runMigrations(sql);
  const env = {
    PROJECT_EVENT_SCHEDULE_MAX_RETAINED_SCHEDULES: '2',
    PROJECT_EVENT_SCHEDULE_MAX_RETAINED_WATCHES: '2',
    ...overrides,
  } as Env;
  const now = Date.now();
  const action = {
    kind: 'start_session',
    prompt: 'Inspect the project',
    agentProfileId: null,
    skillId: null,
  };
  const scheduleRequest = (key: string) => ({
    action,
    dueAt: now + 60_000,
    displayTimezone: 'UTC',
    idempotencyKey: key,
  });
  const watchRequest = (key: string) => ({
    action,
    filter: { version: 1, source: 'github' },
    idempotencyKey: key,
  });
  const create = (key: string) =>
    db.transaction(() =>
      createSchedule(
        sql,
        env,
        'project',
        { userId: 'user', chatSessionId: null },
        scheduleRequest(key),
        now
      )
    )();
  const watch = (key: string) =>
    db.transaction(() => createWatch(sql, env, 'project', 'user', watchRequest(key), now))();
  return { db, sql, env, now, create, watch };
}

describe('schedule retained capacity and executable input', () => {
  it('cancelled schedules consume retained capacity while replays and other projects remain available', () => {
    const f = fixture();
    for (const key of ['first', 'second']) {
      const created = f.create(key);
      f.db.transaction(() =>
        cancelSchedule(f.sql, f.env, 'project', created.schedule.id, { expectedVersion: 1 }, f.now)
      )();
    }
    expect(() => f.create('third')).toThrow('Retained schedule capacity reached');
    expect(f.create('first')).toMatchObject({ idempotent: true, schedule: { state: 'cancelled' } });
    expect(() =>
      createSchedule(
        f.sql,
        f.env,
        'other',
        { userId: 'user', chatSessionId: null },
        {
          action: { kind: 'start_session', prompt: 'Check' },
          dueAt: f.now + 1000,
          displayTimezone: 'UTC',
          idempotencyKey: 'third',
        },
        f.now
      )
    ).not.toThrow();
  });

  it('revoked watches consume retained capacity without breaking idempotency', () => {
    const f = fixture();
    for (const key of ['first', 'second']) {
      const created = f.watch(key);
      f.db.transaction(() =>
        revokeWatch(f.sql, f.env, 'project', created.watch.id, { expectedVersion: 1 }, f.now)
      )();
    }
    expect(() => f.watch('third')).toThrow('Retained standing watch capacity reached');
    expect(f.watch('first')).toMatchObject({ idempotent: true, watch: { state: 'revoked' } });
  });

  it('preserves the independent active capacity limit', () => {
    const f = fixture({
      PROJECT_EVENT_SCHEDULE_MAX_SCHEDULES: '1',
      PROJECT_EVENT_SCHEDULE_MAX_WATCHES: '1',
    });
    f.create('first');
    expect(() => f.create('second')).toThrow('Active schedule capacity reached');
    f.watch('first');
    expect(() => f.watch('second')).toThrow('Standing watch capacity reached');
  });

  it('rejects an otherwise byte-valid new-session prompt before persistence and on watch updates', () => {
    const f = fixture({ MAX_TASK_MESSAGE_LENGTH: '8' });
    expect(() => f.create('long')).toThrow('8 characters or fewer');
    expect(() => f.watch('long')).toThrow('8 characters or fewer');
    const other = fixture();
    const watch = other.watch('existing');
    expect(() =>
      updateWatch(
        other.sql,
        { ...other.env, MAX_TASK_MESSAGE_LENGTH: '8' },
        'project',
        watch.watch.id,
        {
          expectedVersion: 1,
          action: { kind: 'start_session', prompt: 'a'.repeat(9) },
        },
        other.now
      )
    ).toThrow('8 characters or fewer');
    expect(f.db.prepare('SELECT id FROM project_schedules').all()).toHaveLength(0);
  });

  it('accepts task-boundary prompts and bounded labels through the actual reserved input validator', () => {
    expect(() =>
      normalizeScheduledAction(
        { kind: 'start_session', prompt: 'a'.repeat(20_000) },
        scheduleLimits({}),
        resolveProjectEventLimits({})
      )
    ).toThrow('16000 characters or fewer');
    const env = {
      MAX_TASK_MESSAGE_LENGTH: '24',
      RESERVED_TASK_BRANCH_NAME_SEED_MAX_LENGTH: '12',
      RESERVED_TASK_SOURCE_DISPLAY_NAME_MAX_LENGTH: '10',
    };
    const limits = scheduleLimits(env);
    const action = normalizeScheduledAction(
      { kind: 'start_session', prompt: 'a'.repeat(24) },
      limits,
      resolveProjectEventLimits({})
    );
    const reason = 'A complete detailed schedule reason';
    const label = boundedScheduleTaskLabel(env, reason);
    expect(label).toBe(reason.slice(0, 10));
    expect(
      validateReservedTaskSubmissionInput(
        {
          identities: {
            taskId: 'task',
            chatSessionId: 'chat',
            initialMessageId: 'message',
            initialStatusEventId: 'status',
          },
          projectId: 'project',
          userId: 'user',
          prompt: action.prompt,
          branchNameSeed: label,
          agentProfileId: null,
          skillId: null,
          taskMode: 'conversation',
          vmSizeOverride: null,
          source: {
            kind: 'schedule',
            sourceId: 'schedule',
            sourceExecutionId: 'schedule',
            triggeredBy: 'cron',
            displayName: label,
            repositoryAccessFlow: 'scheduled-action',
            initialStatusReason: 'Scheduled action admitted',
            initialStatusActorType: 'system',
            initialStatusActorId: 'user',
          },
        },
        env
      )
    ).toBeNull();
    expect(() =>
      normalizeScheduledAction(
        { kind: 'start_session', prompt: 'a'.repeat(25) },
        limits,
        resolveProjectEventLimits({})
      )
    ).toThrow('24 characters or fewer');
    expect(() =>
      normalizeScheduledAction(
        { kind: 'message_session', sessionId: 'chat', prompt: 'a'.repeat(25) },
        limits,
        resolveProjectEventLimits({})
      )
    ).not.toThrow();
  });
});
