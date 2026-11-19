import Database from 'better-sqlite3';
import { vi } from 'vitest';

import { createSchemaTables, createSqliteD1 } from './sqlite-d1';

/** Native D1 credential-attribution statements execute real ownership and generation SQL. */
export async function createAgentCredentialAttributionFixture(
  workspaceId: string,
  userId: string,
  identity: { nodeId: string; projectId: string | null; chatSessionId: string | null } = {
    nodeId: 'node-1',
    projectId: null,
    chatSessionId: null,
  }
) {
  const schema = await vi.importActual<typeof import('../../src/db/schema')>('../../src/db/schema');
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.agentSessions, schema.tasks, schema.workspaces, schema.nodes]);
  sqlite
    .prepare("INSERT INTO nodes(id,user_id,status)VALUES(?,?,'running')")
    .run(identity.nodeId, userId);
  sqlite
    .prepare(
      "INSERT INTO workspaces(id,user_id,node_id,project_id,chat_session_id,status)VALUES(?,?,?,?,?,'running')"
    )
    .run(workspaceId, userId, identity.nodeId, identity.projectId, identity.chatSessionId);
  const insert = sqlite.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, user_id, status, agent_type, agent_credential_generation, created_at, updated_at)
    VALUES (?, ?, ?, 'running', NULL, ?, ?, ?)`);
  insert.run('owned-agent', workspaceId, userId, 7, '2026-09-07', '2026-09-07');
  insert.run('foreign-workspace', 'other-workspace', userId, 13, '2026-09-08', '2026-09-08');
  insert.run('foreign-user', workspaceId, 'other-user', 17, '2026-09-08', '2026-09-08');
  return { sqlite, database: createSqliteD1(sqlite) };
}
