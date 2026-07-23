/**
 * Vertical slice tests for observability-purge scheduled job.
 *
 * Uses real OBSERVABILITY_DATABASE (Miniflare D1) to verify:
 * 1. Age-based purge: errors older than retention period are deleted
 * 2. Count-based purge: oldest excess rows are deleted when over max
 * 3. No-op when OBSERVABILITY_DATABASE is missing
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { runObservabilityPurge } from '../../src/scheduled/observability-purge';

/**
 * Insert a platform_errors row directly into the observability DB.
 */
async function insertError(
  db: D1Database,
  id: string,
  opts?: { createdAt?: number; message?: string }
): Promise<void> {
  const createdAt = opts?.createdAt ?? Date.now();
  await db
    .prepare(
      `INSERT INTO platform_errors (id, source, level, message, timestamp, created_at)
     VALUES (?, 'api', 'error', ?, ?, ?)`
    )
    .bind(id, opts?.message ?? `Error ${id}`, createdAt, createdAt)
    .run();
}

describe('runObservabilityPurge', () => {
  it('deletes errors older than retention period', async () => {
    const db = env.OBSERVABILITY_DATABASE;
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    // Seed old and recent errors
    await insertError(db, 'purge-old-1', { createdAt: thirtyOneDaysAgo });
    await insertError(db, 'purge-old-2', { createdAt: thirtyOneDaysAgo - 1000 });
    await insertError(db, 'purge-recent-1', { createdAt: twoDaysAgo });
    await insertError(db, 'purge-recent-2', { createdAt: now });

    const testEnv = {
      ...env,
      OBSERVABILITY_ERROR_RETENTION_DAYS: '30',
      OBSERVABILITY_ERROR_MAX_ROWS: '100000',
    } as unknown as Env;

    await runObservabilityPurge(testEnv);

    // Old errors should be gone, recent ones should remain
    const remaining = await db
      .prepare('SELECT id FROM platform_errors WHERE id LIKE ? ORDER BY id')
      .bind('purge-%')
      .all<{ id: string }>();

    const ids = remaining.results.map((r) => r.id);
    expect(ids).toContain('purge-recent-1');
    expect(ids).toContain('purge-recent-2');
    expect(ids).not.toContain('purge-old-1');
    expect(ids).not.toContain('purge-old-2');
  });

  it('deletes oldest excess rows when count exceeds max', async () => {
    const db = env.OBSERVABILITY_DATABASE;
    const now = Date.now();

    // Count retention applies globally, so isolate this case from the prior age-retention case.
    await db.prepare('DELETE FROM platform_errors').run();

    // Insert 5 recent errors
    for (let i = 0; i < 5; i++) {
      await insertError(db, `count-${String(i).padStart(3, '0')}`, {
        createdAt: now - (5 - i) * 1000,
      });
    }

    const testEnv = {
      ...env,
      OBSERVABILITY_ERROR_RETENTION_DAYS: '30',
      OBSERVABILITY_ERROR_MAX_ROWS: '3', // keep only 3
    } as unknown as Env;

    await runObservabilityPurge(testEnv);

    // Only the 3 newest should remain
    const remaining = await db
      .prepare('SELECT id FROM platform_errors WHERE id LIKE ? ORDER BY created_at ASC')
      .bind('count-%')
      .all<{ id: string }>();

    expect(remaining.results.length).toBe(3);
    // The oldest 2 (count-000, count-001) should be deleted
    const ids = remaining.results.map((r) => r.id);
    expect(ids).not.toContain('count-000');
    expect(ids).not.toContain('count-001');
    expect(ids).toContain('count-004');
  });

  it('returns zero counts when OBSERVABILITY_DATABASE is missing', async () => {
    const testEnv = {
      ...env,
      OBSERVABILITY_DATABASE: undefined,
    } as unknown as Env;

    const result = await runObservabilityPurge(testEnv);
    expect(result).toEqual({ deletedByAge: 0, deletedByCount: 0 });
  });
});
