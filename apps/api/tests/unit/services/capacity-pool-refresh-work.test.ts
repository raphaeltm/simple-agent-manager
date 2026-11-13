import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { capacityPoolRefreshSettings } from '../../../src/services/capacity-pool-refresh-settings';
import {
  beginCapacityPoolRefresh,
  finishCapacityPoolRefresh,
  queueCapacityPoolRefresh,
} from '../../../src/services/capacity-pool-refresh-work';
import { createSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [schema.capacityPoolRefreshes]);
  return { sqlite, db: drizzle(createSqliteD1WithBindLimit(sqlite, 100), { schema }) };
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
});
