/**
 * `.claude/rules/71`: a new column must not leave existing rows without a path
 * back. Every session stranded by the old lifetime wake cap predates
 * `recovery_failed_at`, and the decay predicate deliberately refuses a NULL, so
 * without the backfill these rows would stay permanently unwakeable — the exact
 * state four production sessions were in on 2026-09-09.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'src/db/migrations');
const orderedMigrations = readdirSync(migrationsDirectory)
  .filter((filename) => filename.endsWith('.sql'))
  .sort();
const MIGRATION = '0155_session_snapshot_recovery_failed_at.sql';

function applyMigrationsBefore(db: DatabaseSync, migration: string): void {
  const index = orderedMigrations.indexOf(migration);
  if (index < 0) throw new Error(`Migration ${migration} is missing from the real chain`);
  for (const filename of orderedMigrations.slice(0, index)) {
    db.exec(readFileSync(join(migrationsDirectory, filename), 'utf8'));
  }
}

describe('session snapshot recovery_failed_at migration', () => {
  it('backfills stranded rows and leaves never-failed rows untouched', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsBefore(db, MIGRATION);
    db.exec(`
      INSERT INTO users (id, github_id, email)
      VALUES ('u1','gh-1','u1@example.com');
      INSERT INTO session_snapshots
        (id,user_id,chat_session_id,runtime,status,degradation,manifest_r2_key,
         expires_at,sleeping_at,sleep_status,recovery_status,recovery_attempts,updated_at)
      VALUES
        ('stranded','u1','chat-516141ed','vm','available','none','manifest',
         '2026-09-16T12:03:01.120Z','2026-09-09T12:03:01.120Z','sleeping','failed',3,
         '2026-09-09T12:37:21.894Z'),
        ('healthy','u1','chat-healthy','vm','available','none','manifest',
         '2026-09-16T12:03:01.120Z','2026-09-09T12:03:01.120Z','sleeping',NULL,0,
         '2026-09-09T12:37:21.894Z');
    `);

    db.exec(readFileSync(join(migrationsDirectory, MIGRATION), 'utf8'));

    const rows = db
      .prepare('SELECT id, recovery_failed_at FROM session_snapshots ORDER BY id')
      .all();
    expect(rows).toEqual([
      // A session that never failed a wake must not gain a decay anchor.
      { id: 'healthy', recovery_failed_at: null },
      // The stranded row inherits the instant its terminal failure was written,
      // which is already older than any decay window, so its next wake succeeds.
      { id: 'stranded', recovery_failed_at: '2026-09-09T12:37:21.894Z' },
    ]);
  });
});
