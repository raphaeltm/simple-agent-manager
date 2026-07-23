/**
 * User-owned (BYO) nodes cost SAM $0 and must be excluded from vCPU-hour metering and admin cost
 * (architecture-critique #9). The exclusion lives in node-usage's addNodeToTotals chokepoint so
 * every summary/detailed/admin-cost path inherits it. Discriminating: a self-hosted node with real
 * uptime must contribute ZERO to every total.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { getCurrentPeriodBounds } from '../../../src/services/compute-usage';
import {
  getAllUsersNodeUsageSummary,
  getUserNodeUsageSummary,
} from '../../../src/services/node-usage';

const MS_PER_HOUR = 60 * 60 * 1000;
let sqlite: Database.Database | null = null;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function createDb() {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, avatar_url TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      vm_size TEXT NOT NULL, vm_location TEXT NOT NULL, cloud_provider TEXT, credential_source TEXT,
      node_class TEXT NOT NULL DEFAULT 'managed',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, node_id TEXT REFERENCES nodes(id));
  `);
  return drizzle(sqlite, { schema });
}

function seedUser(userId: string): void {
  const now = Date.now();
  sqlite
    ?.prepare('INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(userId, `${userId}@example.test`, now, now);
}

function seedNode(input: {
  id: string;
  userId: string;
  credentialSource: string;
  vmSize: string;
  cloudProvider: string | null;
  createdAt: string;
  nodeClass?: 'managed' | 'user-owned';
}): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location, cloud_provider, credential_source, node_class, created_at, updated_at)
      VALUES (?, ?, ?, 'running', ?, 'fsn1', ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.id,
      input.userId,
      `node-${input.id}`,
      input.vmSize,
      input.cloudProvider,
      input.credentialSource,
      input.nodeClass ?? 'managed',
      input.createdAt,
      input.createdAt
    );
}

afterEach(() => {
  vi.useRealTimers();
  sqlite?.close();
  sqlite = null;
});

describe('node-usage excludes self-hosted (BYO) nodes from all totals', () => {
  it('a running self-hosted node contributes ZERO vCPU-hours; platform node still counts', async () => {
    const db = createDb();
    const { start } = getCurrentPeriodBounds();
    const nowMs = new Date(start).getTime() + 8 * MS_PER_HOUR;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const userId = `byo-user-${Date.now()}`;
    seedUser(userId);

    // Platform node running for 4h → counts. Self-hosted node running for 8h → must NOT count.
    seedNode({
      id: `${userId}-platform`,
      userId,
      credentialSource: 'platform',
      vmSize: 'small',
      cloudProvider: 'hetzner',
      createdAt: isoAt(nowMs - 4 * MS_PER_HOUR),
    });
    seedNode({
      id: `${userId}-byo`,
      userId,
      credentialSource: 'self-hosted',
      vmSize: 'large',
      cloudProvider: null,
      createdAt: isoAt(nowMs - 8 * MS_PER_HOUR),
    });

    const summary = await getUserNodeUsageSummary(db as never, userId);

    // Self-hosted uptime is excluded everywhere: it never lands in user OR total vCPU-hours.
    expect(summary.period.userVcpuHours).toBe(0);
    expect(summary.period.platformVcpuHours).toBeGreaterThan(0);
    expect(summary.period.totalVcpuHours).toBe(summary.period.platformVcpuHours);
    // Only the platform node counts toward active node accounting.
    expect(summary.period.activeNodes).toBe(1);
  });

  it('excludes a user-owned node even if credentialSource is NOT the self-hosted sentinel (decoupling guard)', async () => {
    // Defense-in-depth: billing must exclude BYO nodes keyed on nodeClass too, so a future
    // enrollment path that sets nodeClass='user-owned' but forgets credentialSource='self-hosted'
    // still accrues $0. See cloudflare/security review (billing/lifecycle two-discriminator gap).
    const db = createDb();
    const { start } = getCurrentPeriodBounds();
    const nowMs = new Date(start).getTime() + 8 * MS_PER_HOUR;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const userId = `byo-nodeclass-${Date.now()}`;
    seedUser(userId);

    seedNode({
      id: `${userId}-byo`,
      userId,
      credentialSource: 'user', // NOT 'self-hosted' — the "forgot the sentinel" case
      nodeClass: 'user-owned',
      vmSize: 'large',
      cloudProvider: 'hetzner',
      createdAt: isoAt(nowMs - 8 * MS_PER_HOUR),
    });

    const summary = await getUserNodeUsageSummary(db as never, userId);

    expect(summary.period.totalVcpuHours).toBe(0);
    expect(summary.period.userVcpuHours).toBe(0);
    expect(summary.period.activeNodes).toBe(0);
  });

  it('admin all-users summary also excludes self-hosted uptime', async () => {
    const db = createDb();
    const { start } = getCurrentPeriodBounds();
    const nowMs = new Date(start).getTime() + 8 * MS_PER_HOUR;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const userId = `byo-admin-${Date.now()}`;
    seedUser(userId);
    seedNode({
      id: `${userId}-byo-only`,
      userId,
      credentialSource: 'self-hosted',
      vmSize: 'large',
      cloudProvider: null,
      createdAt: isoAt(nowMs - 8 * MS_PER_HOUR),
    });

    const summaries = await getAllUsersNodeUsageSummary(db as never);
    const mine = summaries.users.find((s) => s.userId === userId);

    // A user whose ONLY node is self-hosted accrues $0 compute — zero total vCPU-hours.
    expect(mine?.totalVcpuHours ?? 0).toBe(0);
  });
});
