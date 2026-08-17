import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('task recovery source migration', () => {
  it('upgrades an existing tasks table with the recovery lineage column and index', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, chat_session_id TEXT)');
      sqlite.exec(
        readFileSync(join(process.cwd(), 'src/db/migrations/0115_task_recovery_source.sql'), 'utf8')
      );

      const columns = sqlite.prepare(`PRAGMA table_info('tasks')`).all() as Array<{
        name: string;
      }>;
      const indexes = sqlite.prepare(`PRAGMA index_list('tasks')`).all() as Array<{
        name: string;
      }>;

      expect(columns.map((column) => column.name)).toContain('recovery_source_task_id');
      expect(indexes.map((index) => index.name)).toContain('idx_tasks_recovery_source_task_id');
    } finally {
      sqlite.close();
    }
  });
});
