import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  calculateVcpuHoursForPeriod,
  getUserDetailedUsage,
  resolveComputeVcpuCount,
  startComputeTracking,
} from '../../../src/services/compute-usage';
import {
  calculateNodeUsageTotalsForRows,
  getUserNodeUsageSummary,
  type NodeUsageCalculationRow,
} from '../../../src/services/node-usage';

const start = new Date('2026-09-01T00:00:00.000Z');
const end = new Date('2026-09-01T02:00:00.000Z');
const databases: Database.Database[] = [];

function createDb() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  // Use the current real column definitions, including the NOT NULL booked CPU
  // constraint. Foreign-key and migration behavior have separate coverage.
  const table = getTableConfig(schema.computeUsage);
  sqlite.exec(
    `CREATE TABLE compute_usage (${table.columns
      .map(
        (column) => `"${column.name}" ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}`
      )
      .join(', ')})`
  );
  const nodes = getTableConfig(schema.nodes);
  // Node lifecycle fields outside metering are irrelevant to these read tests.
  sqlite.exec(
    `CREATE TABLE nodes (${nodes.columns
      .map((column) => `"${column.name}" ${column.getSQLType()}`)
      .join(', ')})`
  );
  const db = drizzle(sqlite, { schema }) as unknown as Parameters<typeof startComputeTracking>[0];
  return { sqlite, db };
}

function node(overrides: Partial<NodeUsageCalculationRow> = {}): NodeUsageCalculationRow {
  return {
    vmSize: 'large',
    cloudProvider: 'hetzner',
    credentialSource: 'platform',
    nodeClass: 'managed',
    status: 'running',
    createdAt: start.toISOString(),
    updatedAt: start.toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
  vi.useRealTimers();
});

describe('native compute metering', () => {
  it('books observed CPU instead of a different planned CPU or legacy tier', async () => {
    const { sqlite, db } = createDb();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const id = await startComputeTracking(db, {
      userId: 'user',
      workspaceId: 'workspace',
      nodeId: 'node',
      vmSize: 'large',
      providerInstanceType: 'custom-sku',
      providerInstanceVcpuCount: 12,
      observedProviderInstanceVcpuCount: 6,
      observedHardwareSource: 'observed',
    });
    expect(sqlite.prepare('SELECT vcpu_count FROM compute_usage WHERE id = ?').get(id)).toEqual({
      vcpu_count: 6,
    });
    vi.setSystemTime(end);
    expect(await calculateVcpuHoursForPeriod(db, 'user', start, end)).toBe(12);
  });

  it('books configured native CPU when provider observation is unavailable', async () => {
    const { sqlite, db } = createDb();
    await startComputeTracking(db, {
      userId: 'user',
      workspaceId: 'workspace',
      nodeId: 'node',
      vmSize: 'small',
      providerInstanceType: 'custom-sku',
      providerInstanceVcpuCount: 12,
    });
    expect(sqlite.prepare('SELECT vcpu_count FROM compute_usage').get()).toEqual({
      vcpu_count: 12,
    });
  });

  it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not book unknown or invalid native CPU (%s) using a legacy tier',
    async (count) => {
      const { sqlite, db } = createDb();
      await expect(
        startComputeTracking(db, {
          userId: 'user',
          workspaceId: 'workspace',
          nodeId: 'node',
          vmSize: 'large',
          providerInstanceType: 'custom-sku',
          providerInstanceVcpuCount: count,
        })
      ).rejects.toThrow('requires observed or configured native vCPU');
      expect(sqlite.prepare('SELECT count(*) AS count FROM compute_usage').get()).toEqual({
        count: 0,
      });
    }
  );

  it('keeps the historical booked count even when observed metadata later changes', async () => {
    const { sqlite, db } = createDb();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    await startComputeTracking(db, {
      userId: 'user',
      workspaceId: 'workspace',
      nodeId: 'node',
      vmSize: 'small',
      providerInstanceType: 'custom-sku',
      providerInstanceVcpuCount: 6,
    });
    sqlite.exec('UPDATE compute_usage SET observed_provider_instance_vcpu_count = 12');
    vi.setSystemTime(end);
    expect(await calculateVcpuHoursForPeriod(db, 'user', start, end)).toBe(12);
    const detail = await getUserDetailedUsage(db, 'user');
    expect(detail.recentRecords[0]).toMatchObject({ vcpuCount: 6, vcpuCountSource: 'recorded' });
  });

  it('keeps historical node estimates explicit and excludes native unknown CPU from charges', () => {
    const legacy = node();
    expect(resolveComputeVcpuCount(legacy, { legacyNode: legacy })).toEqual({
      vcpuCount: 8,
      vcpuCountSource: 'compatibility-estimate',
    });
    const native = node({ providerInstanceType: 'custom-sku' });
    expect(resolveComputeVcpuCount(native, { legacyNode: native })).toEqual({
      vcpuCount: null,
      vcpuCountSource: 'unknown',
    });
    expect(calculateNodeUsageTotalsForRows([native], start, end, end)).toMatchObject({
      totalNodeHours: 2,
      totalVcpuHours: 0,
      platformVcpuHours: 0,
      activeNodes: 1,
    });
  });

  it('does not use tier estimates for partial native metadata or unknown legacy labels', () => {
    const partial = node({ providerInstanceMemoryMb: 8192 });
    expect(resolveComputeVcpuCount(partial, { legacyNode: partial }).vcpuCount).toBeNull();
    const unknown = node({ vmSize: 'unrecognized' });
    expect(resolveComputeVcpuCount(unknown, { legacyNode: unknown }).vcpuCount).toBeNull();
  });

  it('preserves BYO exclusion even when concrete native CPU is known', () => {
    expect(
      calculateNodeUsageTotalsForRows(
        [
          node({ nodeClass: 'user-owned', providerInstanceVcpuCount: 64 }),
          node({ credentialSource: 'self-hosted', providerInstanceVcpuCount: 64 }),
        ],
        start,
        end,
        end
      )
    ).toMatchObject({ totalNodeHours: 0, totalVcpuHours: 0, activeNodes: 0 });
  });

  it('returns explicit unknown and estimate provenance through the real node usage query', async () => {
    const { sqlite, db } = createDb();
    vi.useFakeTimers();
    vi.setSystemTime(end);
    const insert = sqlite.prepare(`INSERT INTO nodes
      (id, user_id, name, vm_size, vm_location, cloud_provider, node_class,
       credential_source, status, created_at, updated_at, provider_instance_type)
      VALUES (?, 'user', ?, 'large', 'fsn1', 'hetzner', 'managed', 'platform',
              'running', ?, ?, ?)`);
    insert.run('native', 'native', start.toISOString(), start.toISOString(), 'custom-sku');
    insert.run('legacy', 'legacy', start.toISOString(), start.toISOString(), null);
    const result = await getUserNodeUsageSummary(db, 'user');
    expect(result.activeSessions.find((row) => row.nodeId === 'native')).toMatchObject({
      vcpuCount: null,
      vcpuCountSource: 'unknown',
    });
    expect(result.activeSessions.find((row) => row.nodeId === 'legacy')).toMatchObject({
      vcpuCount: 8,
      vcpuCountSource: 'compatibility-estimate',
    });
    expect(result.period.totalVcpuHours).toBe(16);
    expect(result.period.totalNodeHours).toBe(4);
  });
});
