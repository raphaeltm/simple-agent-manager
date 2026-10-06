import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createSqliteD1 } from '../../helpers/sqlite-d1';

const migrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0111_backfill_task_chat_session_id.sql'),
  'utf8'
);

function createMigrationDb(): { sqlite: Database.Database; d1: D1Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      chat_session_id TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      chat_session_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_tasks_chat_session_id_unique
      ON tasks(chat_session_id) WHERE chat_session_id IS NOT NULL;
  `);
  return { sqlite, d1: createSqliteD1(sqlite) };
}

function seedWorkspace(
  sqlite: Database.Database,
  id: string,
  projectId: string,
  chatSessionId: string | null
): void {
  sqlite
    .prepare(`INSERT INTO workspaces (id, project_id, chat_session_id) VALUES (?, ?, ?)`)
    .run(id, projectId, chatSessionId);
}

function seedTask(
  sqlite: Database.Database,
  id: string,
  projectId: string,
  workspaceId: string | null,
  chatSessionId: string | null = null
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, workspace_id, chat_session_id, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-15T00:00:00.000Z')`
    )
    .run(id, projectId, workspaceId, chatSessionId);
}

describe('0111_backfill_task_chat_session_id migration', () => {
  it('backfills only unambiguous workspace-derived task links', async () => {
    const { sqlite, d1 } = createMigrationDb();
    try {
      seedWorkspace(sqlite, 'ws-linked', 'project-1', 'session-linked');
      seedTask(sqlite, 'task-linked', 'project-1', 'ws-linked');

      seedWorkspace(sqlite, 'ws-absent', 'project-1', null);
      seedTask(sqlite, 'task-absent', 'project-1', 'ws-absent');

      seedWorkspace(sqlite, 'ws-ambiguous', 'project-1', 'session-ambiguous');
      seedTask(sqlite, 'task-ambiguous-a', 'project-1', 'ws-ambiguous');
      seedTask(sqlite, 'task-ambiguous-b', 'project-1', 'ws-ambiguous');

      seedWorkspace(sqlite, 'ws-conflict', 'project-1', 'session-conflict');
      seedTask(sqlite, 'task-conflict-owner', 'project-1', 'ws-other', 'session-conflict');
      seedTask(sqlite, 'task-conflict-null', 'project-1', 'ws-conflict');

      seedWorkspace(sqlite, 'ws-cross-project-conflict', 'project-1', 'session-cross-conflict');
      seedTask(sqlite, 'task-cross-conflict-owner', 'project-2', 'ws-other', 'session-cross-conflict');
      seedTask(sqlite, 'task-cross-conflict-null', 'project-1', 'ws-cross-project-conflict');

      seedWorkspace(sqlite, 'ws-project-mismatch', 'project-2', 'session-project-mismatch');
      seedTask(sqlite, 'task-project-mismatch', 'project-1', 'ws-project-mismatch');

      await d1.exec(migrationSql);

      const rows = sqlite
        .prepare(`SELECT id, chat_session_id FROM tasks ORDER BY id`)
        .all() as Array<{ id: string; chat_session_id: string | null }>;
      expect(Object.fromEntries(rows.map((row) => [row.id, row.chat_session_id]))).toEqual({
        'task-absent': null,
        'task-ambiguous-a': null,
        'task-ambiguous-b': null,
        'task-conflict-null': null,
        'task-conflict-owner': 'session-conflict',
        'task-cross-conflict-null': null,
        'task-cross-conflict-owner': 'session-cross-conflict',
        'task-linked': 'session-linked',
        'task-project-mismatch': null,
      });
    } finally {
      sqlite.close();
    }
  });
});
