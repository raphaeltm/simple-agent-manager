import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as observabilitySchema from '../../../src/db/observability-schema';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { capacityPoolRefreshSettings } from '../../../src/services/capacity-pool-refresh-settings';
import {
  beginCapacityPoolRefresh,
  finishCapacityPoolRefresh,
  queueCapacityPoolRefresh,
} from '../../../src/services/capacity-pool-refresh-work';
import { createSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
const notify = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('../../../src/services/notification', () => ({ sendNotificationOnce: notify }));
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  vi.useRealTimers();
  vi.restoreAllMocks();
  notify.mockClear();
});
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [schema.capacityPoolRefreshes, schema.users]);
  const database = createSqliteD1WithBindLimit(sqlite, 100);
  return { sqlite, database, db: drizzle(database, { schema }) };
}
const scope = { scope: 'user', ownerUserId: 'owner', ownerProjectId: null } as const;

describe('catalog refresh ownership and finite retry', () => {
  it('makes stale acquisition and completion no-ops after a newer manual attempt owns the work', async () => {
    const { sqlite, db } = fixture();
    const settings = await capacityPoolRefreshSettings();
    const older = (await beginCapacityPoolRefresh(db, scope, settings))!;
    const newer = (await beginCapacityPoolRefresh(db, scope, settings))!;
    expect(newer.generation).toBe(older.generation + 1);
    expect(await beginCapacityPoolRefresh(db, scope, settings, true, older)).toBeNull();
    await finishCapacityPoolRefresh(db, older, settings, true);
    expect(
      sqlite.prepare('SELECT generation, state, last_success_at FROM capacity_pool_refreshes').get()
    ).toEqual({ generation: newer.generation, state: 'pending', last_success_at: null });
    await finishCapacityPoolRefresh(db, newer, settings, true);
    // A delayed old continuation cannot reopen a now-complete operation by queuing it again.
    expect(await beginCapacityPoolRefresh(db, scope, settings, true, older)).toBeNull();
    expect(sqlite.prepare('SELECT state FROM capacity_pool_refreshes').get()).toEqual({
      state: 'complete',
    });
  });

  it('does not let discovery or background retries restart an exhausted operation', async () => {
    const { sqlite, db } = fixture();
    const settings = await capacityPoolRefreshSettings();
    const work = (await beginCapacityPoolRefresh(db, scope, settings))!;
    vi.setSystemTime(new Date(work.deadlineAt));
    await finishCapacityPoolRefresh(db, work, settings, false);
    await queueCapacityPoolRefresh(db, scope, settings);
    expect(await beginCapacityPoolRefresh(db, scope, settings, true)).toBeNull();
    expect(
      sqlite.prepare('SELECT state, deadline_at, attempts FROM capacity_pool_refreshes').get()
    ).toEqual({ state: 'failed', deadline_at: work.deadlineAt, attempts: 1 });
    const manualRetry = (await beginCapacityPoolRefresh(db, scope, settings))!;
    expect(manualRetry.state).toBe('pending');
    expect(manualRetry.attempts).toBe(1);
    expect(manualRetry.deadlineAt).toBe(work.deadlineAt + settings.deadlineMs);
  });

  it('persists bounded backoff and prevents background retry before eligibility', async () => {
    const { db } = fixture();
    const settings = await capacityPoolRefreshSettings();
    const first = (await beginCapacityPoolRefresh(db, scope, settings))!;
    await finishCapacityPoolRefresh(db, first, settings, false);
    expect(await beginCapacityPoolRefresh(db, scope, settings, true)).toBeNull();
    vi.setSystemTime(new Date(Date.now() + settings.retryBaseMs));
    const second = (await beginCapacityPoolRefresh(db, scope, settings, true))!;
    expect(second.attempts).toBe(2);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.deadlineAt).toBe(first.deadlineAt);
  });

  it('starts the recovery budget on the first attempt after a long discovery queue wait', async () => {
    const { db } = fixture();
    const settings = await capacityPoolRefreshSettings();
    await queueCapacityPoolRefresh(db, scope, settings);
    vi.setSystemTime(new Date(Date.now() + 2 * settings.deadlineMs));
    const first = (await beginCapacityPoolRefresh(db, scope, settings, true))!;
    expect(first.attempts).toBe(1);
    expect(first.startedAt).toBe(Date.now());
    expect(first.deadlineAt).toBe(Date.now() + settings.deadlineMs);
  });

  it('daily discovery revives failed work only after cooldown without letting old callbacks own it', async () => {
    const { sqlite, db } = fixture();
    const settings = { ...(await capacityPoolRefreshSettings()), failureCooldownMs: 60_000 };
    const old = (await beginCapacityPoolRefresh(db, scope, settings))!;
    vi.setSystemTime(new Date(old.deadlineAt));
    await finishCapacityPoolRefresh(db, old, settings, false);
    await queueCapacityPoolRefresh(db, scope, settings);
    expect(await beginCapacityPoolRefresh(db, scope, settings, true)).toBeNull();
    vi.setSystemTime(new Date(Date.now() + settings.failureCooldownMs - 1));
    await queueCapacityPoolRefresh(db, scope, settings);
    expect(sqlite.prepare('SELECT state FROM capacity_pool_refreshes').get()).toEqual({
      state: 'failed',
    });
    vi.setSystemTime(new Date(Date.now() + 1));
    await queueCapacityPoolRefresh(db, scope, settings);
    await finishCapacityPoolRefresh(db, old, settings, true);
    const revived = (await beginCapacityPoolRefresh(db, scope, settings, true))!;
    expect(revived).not.toBeNull();
    expect(revived.attempts).toBe(1);
    expect(revived.generation).toBeGreaterThan(old.generation);
    expect(revived.startedAt).toBe(Date.now());
    expect(revived.deadlineAt).toBe(Date.now() + settings.deadlineMs);
  });

  it('alerts operators once for the owned failed transition and preserves the failure if notification fails', async () => {
    const { sqlite, db, database } = fixture();
    sqlite.exec(
      "INSERT INTO users (id, email, role, status) VALUES ('operator', 'operator@example.test', 'superadmin', 'active')"
    );
    const observation = new Database(':memory:');
    databases.push(observation);
    createSchemaTables(observation, [observabilitySchema.platformErrors]);
    const env = {
      DATABASE: database,
      OBSERVABILITY_DATABASE: createSqliteD1WithBindLimit(observation, 100),
    } as Env;
    const settings = await capacityPoolRefreshSettings();
    const old = (await beginCapacityPoolRefresh(db, scope, settings))!;
    const current = (await beginCapacityPoolRefresh(db, scope, settings))!;
    vi.setSystemTime(new Date(current.deadlineAt));
    notify.mockRejectedValueOnce(new Error('Notification transport unavailable'));
    await finishCapacityPoolRefresh(db, old, settings, false, undefined, false, env);
    expect(notify).not.toHaveBeenCalled();
    await expect(
      finishCapacityPoolRefresh(db, current, settings, false, undefined, false, env)
    ).resolves.toBe(true);
    await finishCapacityPoolRefresh(db, current, settings, false, undefined, false, env);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[4]).toMatchObject({
      type: 'cron_failure',
      urgency: 'high',
      actionUrl: '/admin/errors',
    });
    expect(sqlite.prepare('SELECT state FROM capacity_pool_refreshes').get()).toEqual({
      state: 'failed',
    });
    expect(observation.prepare('SELECT level FROM platform_errors').all()).toEqual([
      { level: 'error' },
    ]);
  });
});
