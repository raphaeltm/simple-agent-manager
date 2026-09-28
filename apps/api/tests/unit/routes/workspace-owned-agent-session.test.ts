/**
 * `getOwnedAgentSession` / `getOwnedNodeAgentSession` back the workspace page's agent-session
 * rename, stop, suspend and resume routes. Their ownership guard is a SQL predicate, so it runs
 * on a real SQL engine (`.claude/rules/28`), and every attack case sits beside an owner control.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  getOwnedAgentSession,
  getOwnedNodeAgentSession,
} from '../../../src/routes/workspaces/_helpers';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('owned agent-session lookup', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.workspaces, schema.agentSessions]);
    const workspace = sqlite.prepare(
      `INSERT INTO workspaces (id, user_id, node_id, status) VALUES (?, ?, ?, 'running')`
    );
    workspace.run('ws-a', 'user-a', 'node-a');
    workspace.run('ws-a2', 'user-a', 'node-a2');
    workspace.run('ws-b', 'user-b', 'node-b');
    workspace.run('ws-unattached', 'user-a', null);
    const session = sqlite.prepare(
      `INSERT INTO agent_sessions (id, workspace_id, user_id, status) VALUES (?, ?, ?, 'running')`
    );
    session.run('agent-a', 'ws-a', 'user-a');
    session.run('agent-a2', 'ws-a2', 'user-a');
    session.run('agent-b', 'ws-b', 'user-b');
    // Another user's session on user A's workspace.
    session.run('agent-x', 'ws-a', 'user-b');
    db = drizzle(createSqliteD1(sqlite), { schema });
  });

  afterEach(() => sqlite.close());

  it("returns the owner's node-attached workspace and agent session", async () => {
    const { workspace, session } = await getOwnedNodeAgentSession(db, 'ws-a', 'agent-a', 'user-a');

    expect(workspace).toMatchObject({ id: 'ws-a', nodeId: 'node-a' });
    expect(session).toMatchObject({ id: 'agent-a', workspaceId: 'ws-a' });
  });

  it.each([
    ["another user's workspace", 'ws-b', 'agent-b', 'Workspace not found'],
    [
      "the caller's session from their other workspace",
      'ws-a',
      'agent-a2',
      'Agent session not found',
    ],
    [
      "another user's session on the caller's workspace",
      'ws-a',
      'agent-x',
      'Agent session not found',
    ],
  ])('answers 404 for %s', async (_case, workspaceId, sessionId, message) => {
    await expect(
      getOwnedNodeAgentSession(db, workspaceId, sessionId, 'user-a')
    ).rejects.toMatchObject({ statusCode: 404, message });
  });

  it('answers 400 for a workspace that is not attached to a node', async () => {
    await expect(
      getOwnedNodeAgentSession(db, 'ws-unattached', 'agent-a', 'user-a')
    ).rejects.toMatchObject({ statusCode: 400, message: 'Workspace is not attached to a node' });
  });

  it('scopes the bare session lookup to the workspace and the user', async () => {
    await expect(getOwnedAgentSession(db, 'ws-a', 'agent-a', 'user-a')).resolves.toMatchObject({
      id: 'agent-a',
    });
    await expect(getOwnedAgentSession(db, 'ws-a', 'agent-x', 'user-a')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(getOwnedAgentSession(db, 'ws-a', 'agent-a2', 'user-a')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(getOwnedAgentSession(db, 'ws-b', 'agent-b', 'user-a')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
