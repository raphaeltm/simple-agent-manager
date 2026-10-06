import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('task claimed warm node migration', () => {
  it('adds a nullable node reference for crash-safe claim recovery', () => {
    const sql = readFileSync(
      join(process.cwd(), 'src/db/migrations/0116_task_claimed_warm_node.sql'),
      'utf8'
    );
    expect(sql).toContain('ALTER TABLE tasks ADD COLUMN claimed_warm_node_id TEXT');
    expect(sql).toContain('REFERENCES nodes(id) ON DELETE SET NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX idx_tasks_claimed_warm_node_unique');
    expect(sql).toContain('WHERE claimed_warm_node_id IS NOT NULL');
    expect(sql).toContain("status NOT IN ('completed', 'failed', 'cancelled')");
  });

  it('adds a fixed timestamp for bounded cleanup placement-race protection', () => {
    const sql = readFileSync(
      join(process.cwd(), 'src/db/migrations/0123_task_claimed_warm_node_at.sql'),
      'utf8'
    );
    expect(sql).toContain('ALTER TABLE tasks ADD COLUMN claimed_warm_node_at TEXT');
    expect(sql).toContain('SET claimed_warm_node_at = updated_at');
    expect(sql).toContain('CREATE INDEX idx_tasks_claimed_warm_node_at');
    expect(sql).toContain('ON tasks(claimed_warm_node_id, claimed_warm_node_at)');
    expect(sql).toContain("status NOT IN ('completed', 'failed', 'cancelled')");
  });

  it('corrects the partial index so the cleanup guard can use it on upgraded databases', () => {
    const timestampMigration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0123_task_claimed_warm_node_at.sql'),
      'utf8'
    );
    const activeIndexMigration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0124_task_claimed_warm_node_active_index.sql'),
      'utf8'
    );
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          claimed_warm_node_id TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      sqlite.exec(timestampMigration);
      sqlite.exec(activeIndexMigration);
      const plan = sqlite
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT 1
           FROM tasks placement_claim
           WHERE placement_claim.claimed_warm_node_id = ?
             AND placement_claim.status IN ('queued', 'delegated', 'in_progress')
             AND placement_claim.claimed_warm_node_at >= ?`
        )
        .all('node-1', '2026-08-27T12:00:00.000Z') as Array<{ detail: string }>;

      expect(plan.map((row) => row.detail).join('\n')).toContain(
        'USING INDEX idx_tasks_claimed_warm_node_at'
      );
    } finally {
      sqlite.close();
    }
  });
});
