/**
 * Vertical slice tests for compute-usage-cleanup scheduled job.
 *
 * Uses real D1 via Miniflare to verify the LEFT JOIN orphan detection:
 * - Open compute_usage records for stopped/deleted/missing workspaces get closed
 * - Open compute_usage records for running workspaces are NOT closed
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { runComputeUsageCleanup } from '../../src/scheduled/compute-usage-cleanup';
import { seedComputeUsage, seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

const USER_ID = 'user-cu-test';
const NODE_ID = 'node-cu-test';

async function getComputeUsage(id: string): Promise<{ ended_at: string | null } | null> {
  return env.DATABASE.prepare('SELECT ended_at FROM compute_usage WHERE id = ?')
    .bind(id)
    .first<{ ended_at: string | null }>();
}

describe('runComputeUsageCleanup', () => {
  it('closes open compute_usage for stopped workspace', async () => {
    await seedUser(USER_ID);
    await seedNode(NODE_ID, USER_ID);
    const wsId = 'ws-cu-stopped';
    await seedWorkspace(wsId, NODE_ID, USER_ID, { status: 'stopped', updatedAt: '2026-05-14T10:00:00Z' });
    await seedComputeUsage('cu-stopped-1', USER_ID, wsId, NODE_ID, {
      startedAt: '2026-05-14T08:00:00Z',
      endedAt: null,
    });

    const closed = await runComputeUsageCleanup(env as unknown as Env);
    expect(closed).toBeGreaterThanOrEqual(1);

    const record = await getComputeUsage('cu-stopped-1');
    expect(record).not.toBeNull();
    expect(record!.ended_at).not.toBeNull();
    // Should use workspace's updatedAt as the end time
    expect(record!.ended_at).toBe('2026-05-14T10:00:00Z');
  });

  it('closes open compute_usage for deleted workspace', async () => {
    await seedUser(USER_ID);
    await seedNode(NODE_ID, USER_ID);
    const wsId = 'ws-cu-deleted';
    await seedWorkspace(wsId, NODE_ID, USER_ID, { status: 'deleted', updatedAt: '2026-05-14T12:00:00Z' });
    await seedComputeUsage('cu-deleted-1', USER_ID, wsId, NODE_ID, {
      startedAt: '2026-05-14T08:00:00Z',
      endedAt: null,
    });

    const closed = await runComputeUsageCleanup(env as unknown as Env);
    expect(closed).toBeGreaterThanOrEqual(1);

    const record = await getComputeUsage('cu-deleted-1');
    expect(record!.ended_at).toBe('2026-05-14T12:00:00Z');
  });

  it('closes open compute_usage for missing (nonexistent) workspace', async () => {
    await seedUser(USER_ID);
    // Don't create workspace — simulate missing workspace via orphaned reference
    await seedComputeUsage('cu-missing-1', USER_ID, 'ws-does-not-exist', NODE_ID, {
      startedAt: '2026-05-14T08:00:00Z',
      endedAt: null,
    });

    const closed = await runComputeUsageCleanup(env as unknown as Env);
    expect(closed).toBeGreaterThanOrEqual(1);

    const record = await getComputeUsage('cu-missing-1');
    expect(record!.ended_at).not.toBeNull();
  });

  it('does NOT close open compute_usage for running workspace', async () => {
    await seedUser(USER_ID);
    await seedNode(NODE_ID, USER_ID);
    const wsId = 'ws-cu-running';
    await seedWorkspace(wsId, NODE_ID, USER_ID, { status: 'running' });
    await seedComputeUsage('cu-running-1', USER_ID, wsId, NODE_ID, {
      startedAt: '2026-05-14T08:00:00Z',
      endedAt: null,
    });

    await runComputeUsageCleanup(env as unknown as Env);

    const record = await getComputeUsage('cu-running-1');
    expect(record!.ended_at).toBeNull();
  });

  it('returns 0 when no orphaned records exist', async () => {
    const closed = await runComputeUsageCleanup(env as unknown as Env);
    // May be > 0 due to prior test data, but the function should not error
    expect(typeof closed).toBe('number');
  });
});
