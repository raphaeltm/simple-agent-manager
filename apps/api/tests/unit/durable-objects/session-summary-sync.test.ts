import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { runMigrations } from '../../../src/durable-objects/migrations';
import { syncSessionSummariesToD1 } from '../../../src/durable-objects/project-data/session-summary-sync';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

function makeDoSql(): { db: Database.Database; sql: SqlStorage } {
  const db = new Database(':memory:');
  const sql = createSqlStorage(db);
  runMigrations(sql);
  return { db, sql };
}

function makeD1Env(): { db: Database.Database; env: Env } {
  const db = new Database(':memory:');
  createSchemaTables(db, [
    schema.projects,
    schema.sessionSummaries,
    schema.sessionIndexCoverage,
    schema.projectDataSessionIndexCursors,
  ]);
  db.prepare('INSERT INTO projects (id, user_id) VALUES (?, ?)').run('project-sync', 'user-sync');
  return {
    db,
    env: { DATABASE: createSqliteD1(db) } as Env,
  };
}

describe('ProjectData session summary sync', () => {
  it('persists archive_last_message_at when raw root messages have been source-deleted', async () => {
    const source = makeDoSql();
    const d1 = makeD1Env();
    try {
      source.sql.exec(
        `INSERT INTO chat_sessions
           (id, workspace_id, created_by_user_id, topic, status, message_count,
            started_at, ended_at, created_at, updated_at, agent_completed_at,
            materialized_at, archive_last_message_at, archive_state)
         VALUES ('session-archived-anchor', 'workspace-sync', 'user-sync', 'Archived anchor',
                 'stopped', 1, 1000, 2001, 1000, 2001, 2001, 2001, 2000,
                 'source_deleted')`
      );
      source.sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
         VALUES ('message-deleted-before-sync', 'session-archived-anchor', 'user',
                 'already copied to archive shard', NULL, 1500, 1, NULL)`
      );
      source.sql.exec(`DELETE FROM chat_messages WHERE session_id = 'session-archived-anchor'`);

      await syncSessionSummariesToD1(source.sql, d1.env, 'project-sync');

      expect(
        d1.db
          .prepare(
            `SELECT last_message_at, message_count, status
             FROM session_summaries WHERE id = 'session-archived-anchor'`
          )
          .get()
      ).toEqual({
        last_message_at: 2000,
        message_count: 1,
        status: 'stopped',
      });
    } finally {
      source.db.close();
      d1.db.close();
    }
  });
});
