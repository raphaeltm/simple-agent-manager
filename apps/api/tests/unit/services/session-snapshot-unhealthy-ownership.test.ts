import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { ensureSessionSnapshotForSleep } from '../../../src/services/session-snapshot-artifacts';
import { scheduleSessionSnapshotSleep } from '../../../src/services/session-snapshot-sleep-lifecycle';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = new Date('2026-09-25T12:00:00.000Z');

describe('unhealthy-node snapshot ownership fences', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.nodes, schema.workspaces, schema.sessionSnapshots]);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    for (const nodeId of ['old-node', 'new-node']) {
      sqlite
        .prepare(
          `INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location)
           VALUES (?, 'user-1', ?, 'running', 'small', 'nbg1')`
        )
        .run(nodeId, nodeId);
    }
    for (const [workspaceId, nodeId] of [
      ['old-workspace', 'old-node'],
      ['new-workspace', 'new-node'],
    ]) {
      sqlite
        .prepare(
          `INSERT INTO workspaces
           (id, node_id, user_id, project_id, name, repository, branch, status, vm_size,
            vm_location, chat_session_id)
           VALUES (?, ?, 'user-1', 'project-1', ?, 'repo', 'main', 'running',
                   'small', 'nbg1', 'chat-1')`
        )
        .run(workspaceId, nodeId, workspaceId);
    }
  });

  afterEach(() => sqlite.close());

  function oldSnapshotInput() {
    return {
      workspaceId: 'old-workspace',
      nodeId: 'old-node',
      projectId: 'project-1',
      userId: 'user-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'old-agent',
      runtime: 'vm',
    };
  }

  function snapshot() {
    return sqlite
      .prepare(
        `SELECT workspace_id, node_id, agent_session_id, sleep_status
         FROM session_snapshots WHERE chat_session_id = 'chat-1'`
      )
      .get() as
      | {
          workspace_id: string;
          node_id: string;
          agent_session_id: string;
          sleep_status: string | null;
        }
      | undefined;
  }

  it('does not repoint a recovered session when the old node completes late', async () => {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
         (id, workspace_id, node_id, project_id, user_id, chat_session_id,
          agent_session_id, runtime, manifest_r2_key, expires_at)
         VALUES ('snapshot-1', 'new-workspace', 'new-node', 'project-1', 'user-1',
                 'chat-1', 'new-agent', 'vm', 'manifest', ?)`
      )
      .run(new Date(NOW.getTime() + 60_000).toISOString());
    const before = snapshot();

    const accepted = await ensureSessionSnapshotForSleep(
      drizzle(env.DATABASE, { schema }),
      env,
      oldSnapshotInput(),
      { expectedNodeId: 'old-node' }
    );

    expect(accepted).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('does not insert an old-node snapshot after the workspace lost its node', async () => {
    sqlite.prepare(`UPDATE workspaces SET node_id = NULL WHERE id = 'old-workspace'`).run();

    const accepted = await ensureSessionSnapshotForSleep(
      drizzle(env.DATABASE, { schema }),
      env,
      oldSnapshotInput(),
      { expectedNodeId: 'old-node' }
    );

    expect(accepted).toBe(false);
    expect(snapshot()).toBeUndefined();
  });

  it('schedules only while snapshot and workspace still belong to the old node', async () => {
    const db = drizzle(env.DATABASE, { schema });
    expect(
      await ensureSessionSnapshotForSleep(db, env, oldSnapshotInput(), {
        expectedNodeId: 'old-node',
      })
    ).toBe(true);

    sqlite.prepare(`UPDATE workspaces SET node_id = 'new-node' WHERE id = 'old-workspace'`).run();
    const scheduled = await scheduleSessionSnapshotSleep(db, env, 'chat-1', NOW, {
      sleepAfterMs: 0,
      allowIncomplete: true,
      expectedWorkspaceId: 'old-workspace',
      expectedNodeId: 'old-node',
    });

    expect(scheduled).toBe(false);
    expect(snapshot()?.sleep_status).toBeNull();
  });

  it('accepts the guarded sleep intent while ownership is still current', async () => {
    const db = drizzle(env.DATABASE, { schema });
    expect(
      await ensureSessionSnapshotForSleep(db, env, oldSnapshotInput(), {
        expectedNodeId: 'old-node',
      })
    ).toBe(true);

    const scheduled = await scheduleSessionSnapshotSleep(db, env, 'chat-1', NOW, {
      sleepAfterMs: 0,
      allowIncomplete: true,
      expectedWorkspaceId: 'old-workspace',
      expectedNodeId: 'old-node',
    });

    expect(scheduled).toBe(true);
    expect(snapshot()?.sleep_status).toBe('scheduled');
  });
});
