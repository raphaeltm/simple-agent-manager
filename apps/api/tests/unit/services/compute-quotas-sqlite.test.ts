import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../../../src/lib/d1-limits';
import { listUserQuotasWithUsage } from '../../../src/services/compute-quotas';
import {
  calculateNodeVcpuHoursForPeriod,
  getAllUsersNodeUsageSummary,
} from '../../../src/services/node-usage';
import { calculatePlatformNodeUsageByUser } from '../../../src/services/node-usage-grouped';
import { createSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
const now = new Date('2026-10-15T12:00:00.000Z');
const start = new Date('2026-10-01T00:00:00.000Z');
const end = new Date('2026-11-01T00:00:00.000Z');
function seedUser(id: string) {
  sqlite.prepare('INSERT INTO users(id,email) VALUES(?,?)').run(id, `${id}@example.test`);
}
function seedNode(id: string, userId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id,
    user_id: userId,
    name: id,
    vm_size: 'small',
    vm_location: 'fsn1',
    cloud_provider: 'hetzner',
    credential_source: 'platform',
    node_class: 'managed',
    status: 'running',
    created_at: '2026-10-15T08:00:00.000Z',
    updated_at: now.toISOString(),
    ...overrides,
  };
  sqlite
    .prepare(
      `INSERT INTO nodes(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
        .map(() => '?')
        .join(',')})`
    )
    .run(...Object.values(row));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.nodes,
    schema.workspaces,
    schema.userQuotas,
    schema.defaultQuotas,
    schema.computeUsage,
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});
function database() {
  return drizzle(createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS), { schema });
}

describe('quota and usage queries against real SQLite with the D1 bind ceiling', () => {
  it('lists more than 100 users for quotas and node usage without an oversized statement', async () => {
    const db = database();
    for (let index = 0; index < 105; index++) {
      const id = `user-${index}`;
      seedUser(id);
      seedNode(`node-${index}`, id, { provider_instance_vcpu_count: 3 });
      sqlite
        .prepare('INSERT INTO user_quotas(id,user_id,monthly_vcpu_hours_limit) VALUES(?,?,?)')
        .run(`quota-${index}`, id, 100);
    }
    // Control: the adapter really rejects the unchunked statement that used to ship.
    expect(() =>
      createSqliteD1WithBindLimit(sqlite, 100)
        .prepare('SELECT 1')
        .bind(...Array(105).fill('id'))
    ).toThrow('D1 bind parameter limit exceeded');
    const quotas = await listUserQuotasWithUsage(db);
    expect(quotas).toHaveLength(105);
    expect(quotas.every((quota) => quota.currentUsage === 12 && quota.percentUsed === 12)).toBe(
      true
    );
    expect((await getAllUsersNodeUsageSummary(db)).users).toHaveLength(105);
  });

  it('groups node lifetime usage with parity for observed, planned, legacy, unknown and BYO hardware', async () => {
    const db = database();
    seedUser('owner');
    seedNode('legacy', 'owner');
    seedNode('planned', 'owner', { provider_instance_vcpu_count: 4 });
    seedNode('observed', 'owner', {
      provider_instance_vcpu_count: 4,
      observed_provider_instance_vcpu_count: 6,
    });
    seedNode('unknown', 'owner', { provider_instance_type: 'native-unknown' });
    seedNode('byo', 'owner', { node_class: 'user-owned', provider_instance_vcpu_count: 64 });
    seedNode('ended', 'owner', {
      status: 'destroyed',
      created_at: '2026-09-30T20:00:00.000Z',
      updated_at: '2026-10-01T02:00:00.000Z',
      provider_instance_vcpu_count: 2,
    });
    const expected = await calculateNodeVcpuHoursForPeriod(db, 'owner', start, end, 'platform');
    const actual = await calculatePlatformNodeUsageByUser(db, start, end);
    expect(expected).toBeGreaterThan(0);
    expect(actual.get('owner')).toBeCloseTo(expected, 8);
  });

  it('does not list users whose only compute record ended before this period', async () => {
    seedUser('historical');
    seedUser('current');
    const insert = sqlite.prepare(
      'INSERT INTO compute_usage(id,user_id,started_at,ended_at) VALUES(?,?,?,?)'
    );
    insert.run('old', 'historical', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    insert.run('new', 'current', '2026-09-30T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    expect((await listUserQuotasWithUsage(database())).map((quota) => quota.userId)).toEqual([
      'current',
    ]);
  });
});
