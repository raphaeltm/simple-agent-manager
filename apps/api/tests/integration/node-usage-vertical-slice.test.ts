/**
 * Vertical-slice coverage for node uptime compute billing.
 *
 * Uses a real in-memory SQLite database and the production services. Production
 * providers, VM agents, and live usage are not required.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { checkQuotaForUser } from '../../src/services/compute-quotas';
import { getCurrentPeriodBounds } from '../../src/services/compute-usage';
import { getUserNodeDetailedUsage, getUserNodeUsageSummary } from '../../src/services/node-usage';

const MS_PER_HOUR = 60 * 60 * 1000;

let sqlite: Database.Database | null = null;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function createDb() {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      vm_size TEXT NOT NULL,
      vm_location TEXT NOT NULL,
      cloud_provider TEXT,
      credential_source TEXT,
      node_class TEXT NOT NULL DEFAULT 'managed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      node_id TEXT REFERENCES nodes(id)
    );

    CREATE TABLE user_quotas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      monthly_vcpu_hours_limit REAL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL REFERENCES users(id)
    );

    CREATE TABLE default_quotas (
      id TEXT PRIMARY KEY,
      monthly_vcpu_hours_limit REAL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL REFERENCES users(id)
    );
  `);
  return drizzle(sqlite, { schema });
}

function seedUser(userId: string): void {
  const now = Date.now();
  sqlite
    ?.prepare('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, `${userId}@example.test`, `Test ${userId}`, now, now);
}

function seedNode(input: {
  id: string;
  userId: string;
  name: string;
  status: string;
  vmSize: string;
  cloudProvider: string;
  credentialSource: 'platform' | 'user';
  createdAt: string;
  updatedAt: string;
}): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO nodes
        (id, user_id, name, status, vm_size, vm_location, cloud_provider, credential_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'fsn1', ?, ?, ?, ?)
    `
    )
    .run(
      input.id,
      input.userId,
      input.name,
      input.status,
      input.vmSize,
      input.cloudProvider,
      input.credentialSource,
      input.createdAt,
      input.updatedAt
    );
}

function seedQuotaOverride(userId: string, limit: number): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO user_quotas
        (id, user_id, monthly_vcpu_hours_limit, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
    `
    )
    .run(`${userId}-quota`, userId, limit, new Date().toISOString(), userId);
}

afterEach(() => {
  vi.useRealTimers();
  sqlite?.close();
  sqlite = null;
});

describe('node uptime compute billing vertical slice', () => {
  it('summarizes current-user usage from node rows with node fields and legacy aliases', async () => {
    const db = createDb();
    const { start } = getCurrentPeriodBounds();
    const periodStartMs = new Date(start).getTime();
    const nowMs = periodStartMs + 8 * MS_PER_HOUR;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const userId = `node-usage-user-${Date.now()}`;
    seedUser(userId);

    seedNode({
      id: `${userId}-platform-active`,
      userId,
      name: 'platform-active-node',
      status: 'running',
      vmSize: 'small',
      cloudProvider: 'hetzner',
      credentialSource: 'platform',
      createdAt: isoAt(nowMs - 2 * MS_PER_HOUR),
      updatedAt: isoAt(nowMs - 2 * MS_PER_HOUR),
    });
    seedNode({
      id: `${userId}-byoc-ended`,
      userId,
      name: 'byoc-ended-node',
      status: 'destroyed',
      vmSize: 'medium',
      cloudProvider: 'hetzner',
      credentialSource: 'user',
      createdAt: isoAt(nowMs - 5 * MS_PER_HOUR),
      updatedAt: isoAt(nowMs - 3 * MS_PER_HOUR),
    });
    seedNode({
      id: `${userId}-outside-period`,
      userId,
      name: 'old-destroyed-node',
      status: 'destroyed',
      vmSize: 'large',
      cloudProvider: 'hetzner',
      credentialSource: 'platform',
      createdAt: isoAt(periodStartMs - 4 * MS_PER_HOUR),
      updatedAt: isoAt(periodStartMs - 2 * MS_PER_HOUR),
    });

    const summary = await getUserNodeUsageSummary(db as never, userId);

    expect(summary.period.activeNodes).toBe(1);
    expect(summary.period.activeWorkspaces).toBe(1);
    expect(summary.period.platformVcpuHours).toBeGreaterThanOrEqual(4);
    expect(summary.period.userVcpuHours).toBe(8);
    expect(summary.period.totalVcpuHours).toBeGreaterThanOrEqual(12);
    expect(summary.activeSessions).toEqual([
      expect.objectContaining({
        nodeId: `${userId}-platform-active`,
        workspaceId: `${userId}-platform-active`,
        name: 'platform-active-node',
        vmSize: 'small',
        serverType: 'small',
        credentialSource: 'platform',
        status: 'running',
      }),
    ]);
  });

  it('enforces quotas from platform node uptime while excluding BYOC uptime', async () => {
    const db = createDb();
    const { start } = getCurrentPeriodBounds();
    const nowMs = new Date(start).getTime() + 8 * MS_PER_HOUR;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const userId = `node-quota-user-${Date.now()}`;
    seedUser(userId);
    seedQuotaOverride(userId, 3.5);

    seedNode({
      id: `${userId}-platform-ended`,
      userId,
      name: 'platform-ended-node',
      status: 'destroyed',
      vmSize: 'small',
      cloudProvider: 'hetzner',
      credentialSource: 'platform',
      createdAt: isoAt(nowMs - 4 * MS_PER_HOUR),
      updatedAt: isoAt(nowMs - 2 * MS_PER_HOUR),
    });
    seedNode({
      id: `${userId}-byoc-active`,
      userId,
      name: 'byoc-active-node',
      status: 'running',
      vmSize: 'large',
      cloudProvider: 'hetzner',
      credentialSource: 'user',
      createdAt: isoAt(nowMs - 6 * MS_PER_HOUR),
      updatedAt: isoAt(nowMs - 6 * MS_PER_HOUR),
    });

    const quota = await checkQuotaForUser(db as never, userId);
    const detail = await getUserNodeDetailedUsage(db as never, userId, 1);

    expect(quota).toEqual({
      allowed: false,
      used: 4,
      limit: 3.5,
      remaining: -0.5,
      source: 'user_override',
    });
    expect(detail.nodes).toHaveLength(1);
    expect(detail.totalVcpuHours).toBeGreaterThan(4);
    expect(detail.platformNodeHours).toBe(2);
  });
});
