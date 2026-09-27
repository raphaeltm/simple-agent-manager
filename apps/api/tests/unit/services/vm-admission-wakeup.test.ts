import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { wakeVmAdmissionWaiters } from '../../../src/services/vm-admission-wakeup';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const SCOPE_KEY = 'user:user-1:workspace-vm:hetzner:platform:hetzner';
const PROVIDER_DOMAIN_KEY = 'hetzner:platform:hetzner';

let sqlite: Database.Database;
let nudges: Array<{ taskId: string; reason?: string }>;
let env: Env;

function insertAdmission(
  taskId: string,
  options: {
    userId?: string;
    state?: 'queued' | 'waiting';
    enqueuedAt?: string;
  } = {}
): void {
  const { userId = 'user-1', state = 'waiting', enqueuedAt = '2026-09-11T15:00:00.000Z' } = options;
  sqlite
    .prepare(
      `INSERT INTO vm_task_admissions (
         task_id, project_id, user_id, provider, credential_domain_key,
         provider_domain_key, scope_key, requested_vm_size, requested_vm_location,
         state, reason, next_retry_at, enqueued_at, updated_at
       ) VALUES (?, 'project-1', ?, 'hetzner', 'platform:hetzner',
         ?, ?, 'small', 'fsn1', ?, 'compatible_node_building_workspace',
         '2026-09-11T15:00:00.000Z', ?, ?)`
    )
    .run(taskId, userId, PROVIDER_DOMAIN_KEY, SCOPE_KEY, state, enqueuedAt, now());
}

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.tasks, schema.vmTaskAdmissions, schema.vmProvisioningLeases]);
  nudges = [];
  env = {
    DATABASE: createSqliteD1(sqlite),
    TASK_RUNNER: {
      idFromName: (taskId: string) => taskId,
      get: (taskId: string) => ({
        nudge: async (reason?: string) => {
          nudges.push({ taskId, reason });
          return true;
        },
      }),
    },
  } as unknown as Env;
});

afterEach(() => sqlite.close());

describe('wakeVmAdmissionWaiters', () => {
  it('nudges live task admissions and cancels orphaned waiters', async () => {
    sqlite.prepare(`INSERT INTO tasks (id) VALUES ('task-live')`).run();
    insertAdmission('task-live');
    insertAdmission('task-deleted');
    sqlite
      .prepare(
        `INSERT INTO vm_provisioning_leases (
           scope_key, owner_task_id, provider, credential_domain_key, provider_domain_key,
           requested_vm_size, acquired_at, heartbeat_at, expires_at, updated_at
         ) VALUES (?, 'task-deleted', 'hetzner', 'platform:hetzner', ?,
           'small', ?, ?, ?, ?)`
      )
      .run(
        `${SCOPE_KEY}:orphan`,
        PROVIDER_DOMAIN_KEY,
        now(),
        now(),
        '2026-09-11T15:20:00.000Z',
        now()
      );

    const nudged = await wakeVmAdmissionWaiters(env, {
      scopeKey: SCOPE_KEY,
      reason: 'test_wake',
    });

    expect(nudged).toBe(1);
    expect(nudges).toEqual([{ taskId: 'task-live', reason: 'test_wake' }]);

    const orphan = sqlite
      .prepare(
        `SELECT state, reason, next_retry_at, completed_at
         FROM vm_task_admissions
         WHERE task_id = 'task-deleted'`
      )
      .get() as Record<string, unknown>;
    expect(orphan.state).toBe('cancelled');
    expect(orphan.reason).toBe('task_deleted_cleanup');
    expect(orphan.next_retry_at).toBeNull();
    expect(orphan.completed_at).toEqual(expect.any(String));

    const orphanLease = sqlite
      .prepare(
        `SELECT owner_task_id FROM vm_provisioning_leases WHERE owner_task_id = 'task-deleted'`
      )
      .get();
    expect(orphanLease).toBeUndefined();
  });

  it('wakes queued tasks for one user without waking another user', async () => {
    sqlite
      .prepare(`INSERT INTO tasks (id, user_id) VALUES (?, ?), (?, ?), (?, ?)`)
      .run('task-user-1-first', 'user-1', 'task-user-1-second', 'user-1', 'task-user-2', 'user-2');
    insertAdmission('task-user-1-second', {
      enqueuedAt: '2026-09-11T15:02:00.000Z',
      state: 'queued',
    });
    insertAdmission('task-user-2', {
      enqueuedAt: '2026-09-11T14:59:00.000Z',
      state: 'queued',
      userId: 'user-2',
    });
    insertAdmission('task-user-1-first', {
      enqueuedAt: '2026-09-11T15:01:00.000Z',
      state: 'queued',
    });

    const nudged = await wakeVmAdmissionWaiters(env, {
      userId: 'user-1',
      reason: 'node_ready',
    });

    expect(nudged).toBe(2);
    expect(nudges).toEqual([
      { taskId: 'task-user-1-first', reason: 'node_ready' },
      { taskId: 'task-user-1-second', reason: 'node_ready' },
    ]);
    expect(nudges).not.toContainEqual({ taskId: 'task-user-2', reason: 'node_ready' });
  });
});
