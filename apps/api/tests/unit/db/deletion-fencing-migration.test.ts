import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('0137 deletion fencing migration', () => {
  it('adds the strict runtime-termination proof marker without inferring proof from status', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
      sqlite.exec(`INSERT INTO nodes (id, status) VALUES ('legacy-deleted', 'deleted')`);
      sqlite.exec(
        readFileSync(join(process.cwd(), 'src/db/migrations/0137_deletion_fencing.sql'), 'utf8')
      );

      const columns = sqlite.prepare(`PRAGMA table_info('nodes')`).all() as Array<{ name: string }>;
      const row = sqlite
        .prepare('SELECT runtime_termination_confirmed_at AS proof FROM nodes WHERE id = ?')
        .get('legacy-deleted') as { proof: string | null };
      expect(columns.map((column) => column.name)).toContain('runtime_termination_confirmed_at');
      expect(row.proof).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
