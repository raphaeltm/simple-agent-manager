import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const directory = join(process.cwd(), 'src/db/migrations');
const filename = '0187_task_terminal_reason.sql';
const files = readdirSync(directory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const migration = readFileSync(join(directory, filename), 'utf8');
const cohort = [...migration.matchAll(/'(01[A-Z0-9]{24})'/g)].map((match) => match[1]!);

describe('expiry migration and bounded backfill', () => {
  it('supports a clean install through the real migration chain', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of files) db.exec(readFileSync(join(directory, file), 'utf8'));
      expect(db.prepare('PRAGMA table_info(tasks)').all()).toContainEqual(
        expect.objectContaining({ name: 'terminal_reason', type: 'TEXT', notnull: 0 })
      );
    } finally {
      db.close();
    }
  });

  it('normalizes only the bounded legacy cohort and corrects verified failures, retaining controls', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of files.slice(0, files.indexOf(filename))) {
        db.exec(readFileSync(join(directory, file), 'utf8'));
      }
      db.exec(`INSERT INTO users (id,email,github_id) VALUES ('u','u@example.test','gh');
        INSERT INTO github_installations (id,user_id,installation_id,account_type,account_name)
          VALUES ('i','u','i','User','u');
        INSERT INTO projects (id,user_id,name,normalized_name,installation_id,repository,created_by)
          VALUES ('p','u','p','p','i','org/repo','u');
        BEGIN; PRAGMA defer_foreign_keys = ON;`);
      const seed = (id: string, status: string, expiry: string | null, live = false) => {
        db.prepare(
          `INSERT INTO tasks (id, project_id, user_id, title, status, created_by,
          task_mode, workspace_id, chat_session_id, completed_at, error_message)
          VALUES (?, 'p', 'u', 'Kept transcript', ?, 'u', 'conversation', ?, ?,
          '2026-10-06T04:46:31.035Z', ?)`
        ).run(
          id,
          status,
          `w-${id}`,
          `s-${id}`,
          status === 'failed'
            ? 'Task runtime is no longer live (workspace_deleted); task started 10112 minutes ago.'
            : null
        );
        db.prepare(
          `INSERT INTO workspaces (id,user_id,name,repository,branch,status,vm_size,vm_location)
          VALUES (?, 'u', 'w', 'org/repo', 'main', ?, 'small', 'nbg1')`
        ).run(`w-${id}`, live ? 'running' : 'deleted');
        if (expiry)
          db.prepare(
            `INSERT INTO session_snapshots
          (id,project_id,user_id,chat_session_id,runtime,status,degradation,manifest_r2_key,
           expires_at,sleeping_at,sleep_status) VALUES (?, 'p','u',?,'vm','degraded','transcript-only',
           'keep-r2',?,'2026-10-01T00:00:00.000Z','sleeping')`
          ).run(id, `s-${id}`, expiry);
        db.prepare(
          `INSERT INTO session_summaries
          (id,project_id,user_id,status,message_count,started_at,updated_at)
          VALUES (?, 'p','u','stopped',321,1,1)`
        ).run(`s-${id}`);
      };
      seed(cohort[0]!, 'in_progress', '2026-10-07T00:00:00.000Z');
      seed(cohort[1]!, 'in_progress', '2099-01-01T00:00:00.000Z');
      seed(cohort[2]!, 'in_progress', '2099-01-01T00:00:00.000Z', true);
      seed('unlisted', 'in_progress', '2026-10-07T00:00:00.000Z');
      seed('01M3NNVFXJ706QKGM4HKFZMX0D', 'failed', null);
      seed('01M3A01ZD0EY2SCPFFHBAPTXSQ', 'failed', '2099-01-01T00:00:00.000Z');
      db.exec('COMMIT');
      db.exec(migration);
      const row = (id: string) =>
        db.prepare('SELECT status,terminal_reason,error_message FROM tasks WHERE id=?').get(id);
      expect(row(cohort[0]!)).toMatchObject({ status: 'sleeping', terminal_reason: null });
      expect(row(cohort[1]!)).toMatchObject({ status: 'sleeping', terminal_reason: null });
      expect(row(cohort[2]!)).toMatchObject({ status: 'in_progress' });
      expect(row('unlisted')).toMatchObject({ status: 'in_progress' });
      expect(row('01M3NNVFXJ706QKGM4HKFZMX0D')).toEqual({
        status: 'cancelled',
        terminal_reason: 'snapshot_expired',
        error_message: null,
      });
      expect(row('01M3A01ZD0EY2SCPFFHBAPTXSQ')).toMatchObject({ status: 'failed' });
      expect(db.prepare('SELECT count(*) AS n FROM session_snapshots').get()).toEqual({ n: 5 });
      expect(
        db.prepare('SELECT count(*) AS n FROM session_summaries WHERE message_count=321').get()
      ).toEqual({ n: 6 });
      expect(db.prepare('SELECT count(*) AS n FROM task_status_events').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
