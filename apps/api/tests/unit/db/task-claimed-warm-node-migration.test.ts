import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
});
