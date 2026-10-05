import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const directory = join(process.cwd(), 'src/db/migrations');
const migration = '0182_session_snapshot_recovery_attempt_id.sql';
const files = readdirSync(directory)
  .filter((file) => file.endsWith('.sql'))
  .sort();

describe('stable wake attempt migration', () => {
  it('preserves legacy claims on upgrade and supports fresh installs', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of files.slice(0, files.indexOf(migration))) {
        db.exec(readFileSync(join(directory, file), 'utf8'));
      }
      db.exec(`INSERT INTO users (id, github_id, email) VALUES ('u', 'gh', 'user@example.test');
        INSERT INTO session_snapshots
          (id,user_id,chat_session_id,runtime,status,degradation,manifest_r2_key,expires_at,recovery_status,recovery_task_id,updated_at)
        VALUES ('legacy','u','chat','vm','available','none','manifest','2099-01-01','waking','task','2026-10-04');`);
      db.exec(readFileSync(join(directory, migration), 'utf8'));
      expect(
        db
          .prepare(
            'SELECT recovery_status, recovery_task_id, recovery_attempt_id FROM session_snapshots'
          )
          .get()
      ).toEqual({ recovery_status: 'waking', recovery_task_id: 'task', recovery_attempt_id: null });
      db.exec("UPDATE session_snapshots SET recovery_attempt_id = 'new-wake'");
      expect(db.prepare('SELECT recovery_attempt_id FROM session_snapshots').get()).toEqual({
        recovery_attempt_id: 'new-wake',
      });
    } finally {
      db.close();
    }
    const fresh = new DatabaseSync(':memory:');
    try {
      for (const file of files) fresh.exec(readFileSync(join(directory, file), 'utf8'));
      expect(fresh.prepare('PRAGMA table_info(session_snapshots)').all()).toContainEqual(
        expect.objectContaining({ name: 'recovery_attempt_id', type: 'TEXT', notnull: 0 })
      );
    } finally {
      fresh.close();
    }
  });
});
