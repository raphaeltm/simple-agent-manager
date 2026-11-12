/** Real scheduled entrypoint -> audited operational setting -> D1 continuation claim. */
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { scheduled } from '../../src/scheduled/handler';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../src/services/admin-settings';
import { CAPACITY_POOL_CONTINUATION_CRON } from '../../src/services/capacity-pool-refresh-defaults';
import { defaultPoolId } from '../../src/services/default-capacity-pool-helpers';
import { seedUser } from './helpers/seed-d1';

beforeEach(() => __resetAdminSettingsCacheForTest());
afterEach(() => {
  vi.restoreAllMocks();
  __resetAdminSettingsCacheForTest();
});

async function pendingRefresh(nextAttemptAt = Date.now() - 1) {
  const userId = `continuation-cron-${crypto.randomUUID()}`;
  await seedUser(userId);
  const poolId = defaultPoolId({ scope: 'user', ownerUserId: userId, ownerProjectId: null });
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

describe('one-minute catalog continuation on migrated D1', () => {
  it('leaves due work unchanged while disabled and resumes that same work after re-enable', async () => {
    const f = await pendingRefresh();
    await setCronEnabled(f.userId, false);
    const pending = await readRefresh(f.poolId);
    const external = vi.spyOn(globalThis, 'fetch');

    await tick();

    expect(await readRefresh(f.poolId)).toEqual(pending);
    expect(external).not.toHaveBeenCalled();

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
  });
});
