/**
 * Real-SQL tests for the dead wake claim sweep (`.claude/rules/28`, `.claude/rules/62`).
 * Rows are shaped as production left them (task file 2026-11-08-stalled-session-wakes-sweep.md),
 * the sweep runs through its real entry point, and the follow-up wake goes through the real
 * resumer, `claimSessionSnapshotRecovery`.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { notifyWakeSettled } from '../../../src/durable-objects/task-runner/wake-progress-notifier';
import type { Env } from '../../../src/env';
import {
  DEAD_WAKE_CLAIM_ERROR,
  runDeadWakeClaimReconciliation,
} from '../../../src/scheduled/session-wake-claim-reconciliation';
import { claimSessionSnapshotRecovery } from '../../../src/services/session-snapshot-recovery-lifecycle';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/durable-objects/task-runner/wake-progress-notifier', () => ({
  notifyWakeSettled: vi.fn(async () => true),
}));

const NOW = new Date('2026-11-08T06:00:00.000Z');
const CLAIMED = '2026-11-08T03:00:00.000Z';
const ENDED = '2026-11-08T04:00:00.000Z';
// The default claim lease is 10 minutes, so anything after 05:50 is inside it.
const INSIDE_LEASE = '2026-11-08T05:55:00.000Z';

let sqlite: Database.Database;
let env: Env;
let pending: Promise<unknown>[];
const waitUntil = (promise: Promise<unknown>) => {
  pending.push(promise);
};

interface SeedOptions {
  task?: Record<string, unknown> | null;
  snapshot?: Record<string, unknown>;
}

function seed(id: string, options: SeedOptions = {}) {
  const taskId = `task-${id}`;
  if (options.task !== null) {
    insert('tasks', {
      id: taskId,
      project_id: 'project',
      user_id: 'user',
      chat_session_id: `chat-${id}`,
      title: 'Task',
      status: 'sleeping',
      error_message: 'Failed to link reserved ProjectData session',
      created_by: 'user',
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: ENDED,
      ...options.task,
    });
  }
  insert('session_snapshots', {
    id: `snapshot-${id}`,
    project_id: 'project',
    workspace_id: `ws-${id}`,
    node_id: 'node',
    user_id: 'user',
    chat_session_id: `chat-${id}`,
    runtime: 'vm',
    status: 'available',
    degradation: 'none',
    manifest_r2_key: 'manifest',
    sleep_status: 'sleeping',
    sleeping_at: '2026-11-08T01:00:00.000Z',
    expires_at: '2026-11-15T01:00:00.000Z',
    recovery_status: 'waking',
    recovery_task_id: taskId,
    recovery_attempt_id: `attempt-${id}`,
    recovery_claimed_at: CLAIMED,
    recovery_attempts: 1,
    recovery_failed_at: null,
    created_at: '2026-11-08T01:00:00.000Z',
    updated_at: CLAIMED,
    ...options.snapshot,
  });
}

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k] ?? null));
}

function snapshot(id: string) {
  return sqlite
    .prepare(
      `SELECT recovery_status, recovery_task_id, recovery_attempt_id, recovery_claimed_at,
              recovery_failed_at, recovery_attempts, recovery_error
         FROM session_snapshots WHERE id = ?`
    )
    .get(`snapshot-${id}`) as Record<string, unknown>;
}

function setBatchSize(value: number) {
  sqlite
    .prepare(
      `INSERT INTO platform_settings (key,value,updated_at,updated_by) VALUES (?,?,?,'admin')`
    )
    .run('operations.deadWakeReconcileBatchSize', JSON.stringify(value), NOW.toISOString());
}

/** A user prompt to the sleeping chat, through the real resumer. */
function userWake(id: string, at = NOW) {
  return claimSessionSnapshotRecovery(drizzle(env.DATABASE, { schema }), env, {
    chatSessionId: `chat-${id}`,
    userId: 'user',
    taskId: `task-${id}`,
    recoveryAttemptId: `next-${id}`,
    now: at,
  });
}

const sweep = (at = NOW) => runDeadWakeClaimReconciliation(env, waitUntil, at);

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`INSERT INTO users(id) VALUES ('user');
    INSERT INTO projects(id,user_id,name,normalized_name,installation_id,repository,created_by)
      VALUES ('project','user','Project','project','installation','acme/repo','user');`);
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  pending = [];
});
afterEach(() => sqlite.close());

describe('dead wake claim sweep', () => {
  it('ends a claim whose failed wake returned its task to sleep, and the chat can wake again', async () => {
    // Class A as production left it: budget spent, no failure anchor, so it never decays.
    seed('a', { snapshot: { recovery_attempts: 3 } });
    expect(await userWake('a')).toEqual({
      status: 'unavailable',
      reason: 'recovery_attempts_exhausted',
    });

    expect(await sweep()).toEqual({ selected: 1, released: 1 });
    await Promise.all(pending);

    expect(snapshot('a')).toEqual({
      recovery_status: 'failed',
      recovery_task_id: 'task-a',
      recovery_attempt_id: 'attempt-a',
      recovery_claimed_at: null,
      recovery_failed_at: ENDED,
      recovery_attempts: 3,
      recovery_error: DEAD_WAKE_CLAIM_ERROR,
    });
    expect(notifyWakeSettled).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project', chatSessionId: 'chat-a', status: 'failed' })
    );
    // The reported end anchors the budget decay, so the user's next prompt wakes the chat.
    expect(await userWake('a')).toEqual({ status: 'claimed', taskId: 'task-a' });
    expect(snapshot('a')).toMatchObject({ recovery_status: 'waking', recovery_attempts: 1 });
  });

  it('ends a claim whose task another actor cancelled mid-wake', async () => {
    seed('b', {
      task: { status: 'cancelled', admission_state: 'provider_limit_blocked', updated_at: ENDED },
    });
    expect(await sweep()).toEqual({ selected: 1, released: 1 });
    expect(snapshot('b')).toMatchObject({ recovery_status: 'failed', recovery_failed_at: ENDED });
  });

  it.each(['failed', 'completed'])('ends a claim whose task is %s', async (status) => {
    seed('t', { task: { status } });
    expect(await sweep()).toEqual({ selected: 1, released: 1 });
  });

  it('ends a claim whose recovery task no longer exists, anchoring the failure now', async () => {
    seed('gone', { task: null });
    expect(await sweep()).toEqual({ selected: 1, released: 1 });
    expect(snapshot('gone')).toMatchObject({
      recovery_status: 'failed',
      recovery_failed_at: NOW.toISOString(),
    });
  });

  it('ends a claim on an expired snapshot, so its chat stops showing a wake banner', async () => {
    seed('old', {
      snapshot: {
        expires_at: '2026-10-20T00:00:00.000Z',
        recovery_claimed_at: '2026-10-11T15:07:40.957Z',
      },
    });
    expect(await sweep()).toEqual({ selected: 1, released: 1 });
    expect(snapshot('old')).toMatchObject({ recovery_status: 'failed' });
  });

  it.each(['queued', 'delegated', 'in_progress', 'awaiting_followup'])(
    'never touches a live wake whose task is %s, however old its claim',
    async (status) => {
      seed('live', { task: { status, updated_at: ENDED } });
      seed('dead');

      expect(await sweep()).toEqual({ selected: 1, released: 1 });

      // Liveness: the same tick ended the dead neighbour.
      expect(snapshot('dead')).toMatchObject({ recovery_status: 'failed' });
      expect(snapshot('live')).toMatchObject({
        recovery_status: 'waking',
        recovery_claimed_at: CLAIMED,
        recovery_failed_at: null,
      });
      // The resumer agrees the wake is still live: it renews instead of re-claiming.
      expect(await userWake('live')).toEqual({ status: 'waking', taskId: 'task-live' });
    }
  );

  it('leaves a claim inside its lease alone', async () => {
    seed('fresh', { snapshot: { recovery_claimed_at: INSIDE_LEASE } });
    expect(await sweep()).toEqual({ selected: 0, released: 0 });
    expect(snapshot('fresh')).toMatchObject({ recovery_status: 'waking' });
  });

  it('leaves a claim alone while its task ended less than a lease ago (cleanup may be running)', async () => {
    seed('ending', { task: { updated_at: INSIDE_LEASE } });
    expect(await sweep()).toEqual({ selected: 0, released: 0 });
    expect(snapshot('ending')).toMatchObject({ recovery_status: 'waking' });
  });

  it('fails closed on an unreadable task timestamp', async () => {
    seed('bad', { task: { updated_at: 'not a time' } });
    expect(await sweep()).toEqual({ selected: 0, released: 0 });
  });

  it('leaves Instant (cf-container) rows and settled rows alone', async () => {
    seed('instant', { snapshot: { runtime: 'cf-container' } });
    seed('failed', { snapshot: { recovery_status: 'failed' } });
    seed('restored', { snapshot: { recovery_status: 'restored' } });
    expect(await sweep()).toEqual({ selected: 0, released: 0 });
    expect(notifyWakeSettled).not.toHaveBeenCalled();
  });

  describe('compare-and-set against a wake that moves after selection', () => {
    function moveBeforeWrite(mutation: string) {
      const database = env.DATABASE;
      env = {
        DATABASE: {
          prepare: database.prepare.bind(database),
          batch: async (statements: D1PreparedStatement[]) => {
            sqlite.exec(mutation);
            return database.batch(statements);
          },
        } as unknown as D1Database,
      } as Env;
    }

    it.each([
      [
        'the resumer renews the claim',
        `UPDATE session_snapshots SET recovery_claimed_at = '${NOW.toISOString()}'`,
      ],
      [
        'a new wake claims the snapshot',
        `UPDATE session_snapshots SET recovery_attempt_id = 'newer', recovery_claimed_at = '${NOW.toISOString()}';
         UPDATE tasks SET status = 'queued', updated_at = '${NOW.toISOString()}'`,
      ],
      ['the attempt changes', `UPDATE session_snapshots SET recovery_attempt_id = 'newer'`],
      ['the task changes owner', `UPDATE session_snapshots SET recovery_task_id = 'other-task'`],
      ['the task is reactivated', `UPDATE tasks SET status = 'queued'`],
      ['the task just changed', `UPDATE tasks SET updated_at = '${INSIDE_LEASE}'`],
      ['the wake finished', `UPDATE session_snapshots SET recovery_status = 'restored'`],
    ])('loses when %s', async (_name, mutation) => {
      seed('race');
      moveBeforeWrite(mutation);
      expect(await sweep()).toEqual({ selected: 1, released: 0 });
      expect(snapshot('race').recovery_status).not.toBe('failed');
      expect(notifyWakeSettled).not.toHaveBeenCalled();
    });

    it('still wins when nothing moved (control)', async () => {
      seed('race');
      moveBeforeWrite('SELECT 1');
      expect(await sweep()).toEqual({ selected: 1, released: 1 });
    });
  });

  it('is bounded per tick, drains oldest first, and a later tick is a no-op', async () => {
    setBatchSize(2);
    seed('one', { snapshot: { recovery_claimed_at: '2026-11-08T01:00:00.000Z' } });
    seed('two', { snapshot: { recovery_claimed_at: '2026-11-08T02:00:00.000Z' } });
    seed('three', { snapshot: { recovery_claimed_at: '2026-11-08T03:00:00.000Z' } });

    expect(await sweep()).toEqual({ selected: 2, released: 2 });
    expect(snapshot('three')).toMatchObject({ recovery_status: 'waking' });
    expect(await sweep()).toEqual({ selected: 1, released: 1 });
    expect(await sweep()).toEqual({ selected: 0, released: 0 });
    expect(notifyWakeSettled).toHaveBeenCalledTimes(3);
  });
});
