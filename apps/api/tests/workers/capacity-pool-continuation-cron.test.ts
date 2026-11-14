/** Real scheduled entrypoint -> audited operational setting -> D1 continuation claim. */
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { NotificationService } from '../../src/durable-objects/notification';
import type { Env } from '../../src/env';
import { scheduled } from '../../src/scheduled/handler';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../src/services/admin-settings';
import { CAPACITY_POOL_CONTINUATION_CRON } from '../../src/services/capacity-pool-refresh-defaults';
import { defaultPoolId } from '../../src/services/default-capacity-pool-helpers';
import { ensureUserDefaultPool } from '../../src/services/default-capacity-pools-ensure';
import { seedUser } from './helpers/seed-d1';

const refreshPoolIds: string[] = [];
beforeEach(() => __resetAdminSettingsCacheForTest());
afterEach(async () => {
  vi.restoreAllMocks();
  __resetAdminSettingsCacheForTest();
  await env.DATABASE.prepare(
    "DELETE FROM platform_settings WHERE key='operations.capacityPoolRefreshDeadlineMs'"
  ).run();
  for (const poolId of refreshPoolIds.splice(0)) {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        "UPDATE users SET role = 'user' WHERE id IN (SELECT owner_user_id FROM capacity_pools WHERE id = ?)"
      ).bind(poolId),
      env.DATABASE.prepare('DELETE FROM capacity_pool_refreshes WHERE pool_id = ?').bind(poolId),
      env.DATABASE.prepare('DELETE FROM capacity_pools WHERE id = ?').bind(poolId),
    ]);
  }
});

async function pendingRefresh(nextAttemptAt = Date.now() - 1) {
  const userId = `continuation-cron-${crypto.randomUUID()}`;
  await seedUser(userId);
  const poolId = defaultPoolId({ scope: 'user', ownerUserId: userId, ownerProjectId: null });
  refreshPoolIds.push(poolId);
  const startedAt = Date.now() - 1000;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO capacity_pools
         (id, scope, owner_user_id, name, is_default, status, configuration_state, migration_state)
       VALUES (?, 'user', ?, 'Pending account refresh', 1, 'active', 'migration-pending', 'pending')`
    ).bind(poolId, userId),
    env.DATABASE.prepare(
      `INSERT INTO capacity_pool_refreshes
         (pool_id, scope, owner_user_id, state, generation, attempts, started_at, deadline_at, next_attempt_at)
       VALUES (?, 'user', ?, 'pending', 10, 1, ?, ?, ?)`
    ).bind(poolId, userId, startedAt, startedAt + 60_000, nextAttemptAt),
  ]);
  return { userId, poolId };
}

async function readRefresh(poolId: string) {
  return env.DATABASE.prepare(
    `SELECT state, generation, attempts, started_at, deadline_at, next_attempt_at, last_success_at
       FROM capacity_pool_refreshes WHERE pool_id = ?`
  )
    .bind(poolId)
    .first();
}

async function setCronEnabled(userId: string, enabled: boolean) {
  await updateAdminSettings(env as unknown as Env, {
    actorUserId: userId,
    changes: [{ name: 'operations.cronSweepsEnabled', value: enabled }],
  });
}

async function tick(database = env.DATABASE) {
  const context = createExecutionContext();
  await scheduled(
    createScheduledController({ cron: CAPACITY_POOL_CONTINUATION_CRON }),
    { ...env, DATABASE: database } as unknown as Env,
    context
  );
  await waitOnExecutionContext(context);
}

function events(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.flatMap(([line]) => {
    try {
      return [JSON.parse(String(line))];
    } catch {
      return [];
    }
  });
}

/** Fail the real scope-generation read before ensure reaches its refresh begin writer. */
function preRefreshReadFailure(userId: string, fail: () => Promise<never>) {
  return new Proxy(env.DATABASE, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(prepared, method) {
              if (method === 'bind') {
                return (...parameters: unknown[]) => {
                  const bound = prepared.bind(...parameters);
                  if (!parameters.includes(`capacityPools.sourceGeneration.v1:user:${userId}`))
                    return bound;
                  return new Proxy(bound, {
                    get(selected, operation) {
                      if (['raw', 'all', 'first'].includes(String(operation))) return fail;
                      const value: unknown = Reflect.get(selected, operation, selected);
                      return typeof value === 'function' ? value.bind(selected) : value;
                    },
                  });
                };
              }
              const value: unknown = Reflect.get(prepared, method, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function refreshErrors(poolId: string) {
  const rows = await env.OBSERVABILITY_DATABASE.prepare(
    "SELECT level, context FROM platform_errors WHERE message LIKE 'Compute catalog refresh stopped%'"
  ).all<{ level: string; context: string }>();
  return rows.results.filter((row) => JSON.parse(row.context).poolId === poolId);
}

describe('one-minute catalog continuation on migrated D1', () => {
  it('leaves due work unchanged while disabled and resumes that same work after re-enable', async () => {
    const f = await pendingRefresh();
    await setCronEnabled(f.userId, false);
    const pending = await readRefresh(f.poolId);
    const external = vi.spyOn(globalThis, 'fetch');
    const logged = vi.spyOn(console, 'log');

    await tick();

    expect(await readRefresh(f.poolId)).toEqual(pending);
    expect(external).not.toHaveBeenCalled();
    expect(events(logged)).toContainEqual(
      expect.objectContaining({
        event: 'cron.skipped_disabled',
        type: 'capacity-pool-continuation',
        switch: 'cron',
      })
    );

    await setCronEnabled(f.userId, true);
    await tick();

    // The account has no remaining credential. Its continuation must complete by disabling
    // availability rather than attempting any paid allocation or reviving its old source.
    expect(await readRefresh(f.poolId)).toMatchObject({
      state: 'complete',
      generation: 11,
      attempts: 2,
      last_success_at: expect.any(Number),
    });
    expect(
      await env.DATABASE.prepare(
        'SELECT status, configuration_state FROM capacity_pools WHERE id = ?'
      )
        .bind(f.poolId)
        .first()
    ).toEqual({ status: 'active', configuration_state: 'configured-empty' });
    expect(external).not.toHaveBeenCalled();
    expect(events(logged)).toContainEqual(
      expect.objectContaining({
        event: 'cron.completed',
        type: 'capacity-pool-continuation',
        resumed: 1,
        failed: 0,
        skipped: false,
      })
    );
  });

  it('drains due continuation only, preserving future retries and the daily full-refresh gate', async () => {
    const due = await pendingRefresh();
    const future = await pendingRefresh(Date.now() + 60_000);
    const futureBefore = await readRefresh(future.poolId);
    await setCronEnabled(due.userId, true);
    const oldSuccess = '2026-01-01T00:00:00.000Z';
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('capacityPools.scheduledReconciliation.lastRun.v1', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(oldSuccess, oldSuccess)
      .run();

    await tick();

    expect(await readRefresh(due.poolId)).toMatchObject({ state: 'complete' });
    expect(await readRefresh(future.poolId)).toEqual(futureBefore);
    const fullRefresh = await env.DATABASE.prepare(
      `SELECT key, value FROM platform_settings
       WHERE key IN ('capacityPools.scheduledReconciliation.lastRun.v1',
                     'capacityPools.scheduledReconciliation.claim.v1')`
    ).all();
    expect(fullRefresh.results).toEqual([
      { key: 'capacityPools.scheduledReconciliation.lastRun.v1', value: oldSuccess },
    ]);
  });

  it('persists a failed continuation sweep without losing due work or falling through to full refresh', async () => {
    const f = await pendingRefresh();
    await setCronEnabled(f.userId, true);
    const pending = await readRefresh(f.poolId);
    const logged = vi.spyOn(console, 'log');
    let rejectedContinuationWrites = 0;
    const unavailable = new Proxy(env.DATABASE, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            if (query.includes('INSERT INTO capacity_pool_refreshes')) {
              rejectedContinuationWrites += 1;
              throw new Error('D1 continuation write unavailable');
            }
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(tick(unavailable)).resolves.toBeUndefined();

    expect(rejectedContinuationWrites).toBe(1);
    expect(await readRefresh(f.poolId)).toEqual(pending);
    const failures = await env.OBSERVABILITY_DATABASE.prepare(
      `SELECT message, context FROM platform_errors
       WHERE message LIKE '%capacity_pool_continuation%'`
    ).all<{ message: string; context: string }>();
    expect(failures.results).toHaveLength(1);
    expect(failures.results[0]?.message).toContain(
      'Scheduled sweep "capacity_pool_continuation" failed:'
    );
    expect(JSON.parse(failures.results[0]!.context)).toMatchObject({
      recoveryType: 'cron_sweep_failure',
      sweep: 'capacity_pool_continuation',
    });
    expect(events(logged)).toContainEqual(
      expect.objectContaining({
        event: 'cron.completed',
        type: 'capacity-pool-continuation',
        resumed: null,
        failed: 1,
        failedSweeps: ['capacity_pool_continuation'],
      })
    );
  });

  it('counts an exhausted owned refresh as failed and persists its operator-visible error', async () => {
    const f = await pendingRefresh();
    await setCronEnabled(f.userId, true);
    await env.DATABASE.prepare(
      'UPDATE capacity_pool_refreshes SET deadline_at = ? WHERE pool_id = ?'
    )
      .bind(Date.now() - 1, f.poolId)
      .run();
    const logged = vi.spyOn(console, 'log');
    await tick();
    expect(await readRefresh(f.poolId)).toMatchObject({ state: 'failed' });
    expect(events(logged)).toContainEqual(
      expect.objectContaining({
        event: 'cron.completed',
        type: 'capacity-pool-continuation',
        resumed: 0,
        failed: 1,
      })
    );
    expect(
      (
        await env.OBSERVABILITY_DATABASE.prepare(
          "SELECT level FROM platform_errors WHERE message LIKE 'Compute catalog refresh stopped%'"
        ).all()
      ).results
    ).toEqual([{ level: 'error' }]);
  });

  it('bounds repeated pre-refresh read failures across cron restarts and alerts once', async () => {
    const f = await pendingRefresh();
    await env.DATABASE.prepare("UPDATE users SET role='superadmin', status='active' WHERE id=?")
      .bind(f.userId)
      .run();
    await updateAdminSettings(env as unknown as Env, {
      actorUserId: f.userId,
      changes: [
        { name: 'operations.cronSweepsEnabled', value: true },
        { name: 'operations.capacityPoolRefreshDeadlineMs', value: 120_000 },
      ],
    });
    await env.DATABASE.prepare(
      'UPDATE capacity_pool_refreshes SET attempts=0, started_at=0, deadline_at=0 WHERE pool_id=?'
    )
      .bind(f.poolId)
      .run();
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const fail = vi.fn(async () => {
      throw new Error('Pre-refresh scope read unavailable');
    });
    const external = vi.spyOn(globalThis, 'fetch');
    await tick(preRefreshReadFailure(f.userId, fail));
    expect(await readRefresh(f.poolId)).toMatchObject({
      state: 'pending',
      generation: 11,
      attempts: 1,
      started_at: startedAt,
      deadline_at: startedAt + 120_000,
      next_attempt_at: startedAt + 15_000,
    });
    expect(await refreshErrors(f.poolId)).toEqual([]);
    // New bindings model replacement invocations without carrying continuation state.
    clock.mockReturnValue(startedAt + 60_000);
    await tick(preRefreshReadFailure(f.userId, fail));
    expect(await readRefresh(f.poolId)).toMatchObject({
      state: 'pending',
      generation: 12,
      attempts: 2,
      started_at: startedAt,
      deadline_at: startedAt + 120_000,
      next_attempt_at: startedAt + 90_000,
    });
    clock.mockReturnValue(startedAt + 120_000);
    await Promise.all([
      tick(preRefreshReadFailure(f.userId, fail)),
      tick(preRefreshReadFailure(f.userId, fail)),
    ]);
    const failed = await readRefresh(f.poolId);
    expect(failed).toMatchObject({
      state: 'failed',
      attempts: 2,
      started_at: startedAt,
      deadline_at: startedAt + 120_000,
    });
    await tick(preRefreshReadFailure(f.userId, fail));
    expect(await readRefresh(f.poolId)).toEqual(failed);
    expect(fail).toHaveBeenCalledTimes(2);
    expect(external).not.toHaveBeenCalled();
    expect(await refreshErrors(f.poolId)).toHaveLength(1);
    const notifications = env.NOTIFICATION.get(
      env.NOTIFICATION.idFromName(f.userId)
    ) as DurableObjectStub<NotificationService>;
    expect(
      (
        await notifications.listNotifications(f.userId, { type: 'cron_failure' })
      ).notifications.filter(
        (notification) => notification.title === 'Compute catalog refresh stopped'
      )
    ).toHaveLength(1);
  });

  it('makes a stale pre-refresh failure harmless after a manual publisher takes ownership', async () => {
    const f = await pendingRefresh();
    await setCronEnabled(f.userId, true);
    let rejectRead!: (reason: Error) => void;
    let markRead!: () => void;
    const reached = new Promise<void>((resolve) => {
      markRead = resolve;
    });
    const blocked = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    const fail = vi.fn(() => {
      markRead();
      return blocked;
    });
    const older = tick(preRefreshReadFailure(f.userId, fail));
    let newer: Awaited<ReturnType<typeof readRefresh>> = null;
    try {
      await reached;
      await tick(preRefreshReadFailure(f.userId, fail));
      expect(fail).toHaveBeenCalledTimes(1);
      await ensureUserDefaultPool(drizzle(env.DATABASE, { schema }), f.userId, {
        env: env as unknown as Env,
      });
      newer = await readRefresh(f.poolId);
      expect(newer).toMatchObject({ state: 'complete', attempts: 2, generation: 11 });
    } finally {
      rejectRead(new Error('Old pre-refresh read failed after another publisher completed'));
      await older;
    }
    expect(await readRefresh(f.poolId)).toEqual(newer);
    expect(await refreshErrors(f.poolId)).toEqual([]);
  });
});
