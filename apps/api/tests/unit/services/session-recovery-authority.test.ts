import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { restoreSessionRecoveryHandoff } from '../../../src/services/session-recovery-authority';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('restoreSessionRecoveryHandoff', () => {
  it('converges a restored-snapshot crash window back to the sleeping source owner', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.tasks, schema.workspaces, schema.sessionSnapshots]);
      sqlite.exec(`
        INSERT INTO tasks
          (id, project_id, user_id, chat_session_id, recovery_source_task_id, title,
           status, priority, task_mode, dispatch_depth, triggered_by, created_by,
           created_at, updated_at)
        VALUES
          ('source-1', 'project-1', 'user-1', NULL, NULL, 'Source',
           'completed', 0, 'conversation', 0, 'mcp', 'user-1',
           '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'),
          ('recovery-1', 'project-1', 'user-1', 'chat-1', 'source-1', 'Recovery',
           'failed', 0, 'conversation', 0, 'session-recovery', 'user-1',
           '2026-08-16T00:01:00.000Z', '2026-08-16T00:01:00.000Z');

        INSERT INTO workspaces (id, project_id, user_id, chat_session_id, status)
        VALUES ('workspace-old', 'project-1', 'user-1', NULL, 'sleeping');

        INSERT INTO session_snapshots
          (id, workspace_id, project_id, user_id, chat_session_id, runtime, status,
           degradation, manifest_r2_key, expires_at, recovery_status,
           recovery_task_id, recovery_workspace_id, recovery_attempts, updated_at)
        VALUES
          ('snapshot-1', 'workspace-old', 'project-1', 'user-1', 'chat-1', 'vm',
           'available', 'none', 'snapshots/chat-1/manifest.json',
           '2026-08-20T00:00:00.000Z', 'restored', 'recovery-1',
           'workspace-new', 1, '2026-08-16T00:02:00.000Z');
      `);

      await restoreSessionRecoveryHandoff(createSqliteD1(sqlite), 'recovery-1', 'chat-1');

      expect(
        sqlite.prepare(`SELECT chat_session_id FROM tasks WHERE id = 'recovery-1'`).get()
      ).toEqual({ chat_session_id: null });
      expect(
        sqlite.prepare(`SELECT chat_session_id FROM tasks WHERE id = 'source-1'`).get()
      ).toEqual({ chat_session_id: 'chat-1' });
      expect(
        sqlite.prepare(`SELECT chat_session_id FROM workspaces WHERE id = 'workspace-old'`).get()
      ).toEqual({ chat_session_id: 'chat-1' });
    } finally {
      sqlite.close();
    }
  });
});
