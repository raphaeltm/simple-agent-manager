/**
 * Workspace MCP tokens are bound to their workspace's lifecycle
 * (`validateActiveWorkspaceMcpToken`). Every case runs the real lifecycle SQL against a
 * real SQLite engine, and the route cases enter through the real `/mcp` router, so a
 * deleted predicate or a bypassed call site turns them red.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { validateActiveWorkspaceMcpToken } from '../../../src/services/mcp-token-lifecycle';
import { createJsonKv, createMcpApp, storeMcpToken } from '../../helpers/mcp-route';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const TOKEN = 'mcp-token-under-test';
const TOKEN_DATA = {
  taskId: 'task-1',
  projectId: 'project-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
};

let sqlite: Database.Database;
let env: Env;

function seed(workspace: {
  status: string;
  userId?: string;
  projectId?: string | null;
  nodeId?: string | null;
  nodeStatus?: string | null;
}): void {
  const nodeId = workspace.nodeId === undefined ? 'node-1' : workspace.nodeId;
  if (nodeId && workspace.nodeStatus !== null) {
    sqlite
      .prepare(`INSERT INTO nodes (id, user_id, status) VALUES (?, 'user-1', ?)`)
      .run(nodeId, workspace.nodeStatus ?? 'running');
  }
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, project_id, node_id, status) VALUES ('ws-1', ?, ?, ?, ?)`
    )
    .run(
      workspace.userId ?? 'user-1',
      workspace.projectId === undefined ? 'project-1' : workspace.projectId,
      nodeId,
      workspace.status
    );
}

function setWorkspaceStatus(status: string): void {
  sqlite.prepare(`UPDATE workspaces SET status = ? WHERE id = 'ws-1'`).run(status);
}

async function tokenStillStored(): Promise<boolean> {
  return (await env.KV.get(`mcp:${TOKEN}`)) !== null;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
  sqlite
    .prepare(`INSERT INTO users (id, email, status) VALUES ('user-1', 'user@example.test', 'active')`)
    .run();
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status)
       VALUES ('project-1', 'user-1', 'owner', 'active')`
    )
    .run();
  env = { DATABASE: createSqliteD1(sqlite), KV: createJsonKv() } as unknown as Env;
  await storeMcpToken(env.KV, TOKEN, TOKEN_DATA);
});

afterEach(() => sqlite.close());

describe('validateActiveWorkspaceMcpToken', () => {
  it.each(['creating', 'running', 'recovery'])(
    'accepts the token while its workspace is %s on a running node',
    async (status) => {
      seed({ status });
      await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
    }
  );

  it('keeps an active viewer token valid for downstream read-capability checks', async () => {
    sqlite
      .prepare(`UPDATE project_members SET role = 'viewer' WHERE user_id = 'user-1'`)
      .run();
    seed({ status: 'running' });

    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
    expect(await tokenStillStored()).toBe(true);
  });

  it.each(['invited', 'suspended', 'removed'])(
    'rejects and revokes the token when project membership becomes %s',
    async (membershipStatus) => {
      sqlite
        .prepare(`UPDATE project_members SET status = ? WHERE user_id = 'user-1'`)
        .run(membershipStatus);
      seed({ status: 'running' });

      await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toBeNull();
      expect(await tokenStillStored()).toBe(false);
    }
  );

  it('rejects and revokes the token when the user account is suspended', async () => {
    sqlite.prepare(`UPDATE users SET status = 'suspended' WHERE id = 'user-1'`).run();
    seed({ status: 'running' });

    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toBeNull();
    expect(await tokenStillStored()).toBe(false);
  });

  it.each(['stopping', 'stopped', 'sleeping', 'evicted', 'error', 'pending'])(
    'rejects, but keeps, the token while its workspace is %s',
    async (status) => {
      seed({ status });
      await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toBeNull();
      expect(await tokenStillStored()).toBe(true);
    }
  );

  it('works again once a stopped workspace is running again (same agent session)', async () => {
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();
    setWorkspaceStatus('stopped');
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    setWorkspaceStatus('running');
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();
  });

  it('revokes the token once its workspace is deleted', async () => {
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();
    setWorkspaceStatus('deleted');

    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(false);
  });

  it('revokes the token when its workspace row is gone', async () => {
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(false);
  });

  it.each([
    ['another user', { userId: 'user-2' }],
    ['another project', { projectId: 'project-2' }],
    ['no project (project deleted)', { projectId: null }],
  ])('revokes the token when its workspace now belongs to %s', async (_label, identity) => {
    seed({ status: 'running', ...identity });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(false);
  });

  it.each([
    ['stopping', { nodeStatus: 'stopping' }],
    ['destroying', { nodeStatus: 'destroying' }],
    ['destroyed', { nodeStatus: 'destroyed' }],
    ['deleted', { nodeStatus: 'deleted' }],
    ['missing', { nodeStatus: null }],
    ['unassigned', { nodeId: null }],
  ])('rejects a running workspace whose node is %s', async (_label, node) => {
    seed({ status: 'running', ...node });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(true);
  });

  it('returns null for an unknown token without reading the workspace', async () => {
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, 'not-a-token')).toBeNull();
  });
});

describe('MCP entry points enforce current token lifecycle authority', () => {
  let app: Hono;

  beforeAll(async () => {
    // The MCP router module graph is large; import it once, outside any test's timeout.
    app = new Hono();
    app.onError(handleAppError);
    app.route('/', await createMcpApp());
  }, 60_000);

  async function postMcp(path: string, body?: unknown): Promise<Response> {
    return app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body ?? {}),
      },
      env
    );
  }

  const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  it('serves tools/list while the workspace is running, then 401s after it stops', async () => {
    seed({ status: 'running' });
    const live = await postMcp('/mcp', toolsList);
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as { result?: { tools?: unknown[] } };
    expect(liveBody.result?.tools?.length).toBeGreaterThan(0);

    setWorkspaceStatus('stopped');
    const stale = await postMcp('/mcp', toolsList);
    expect(stale.status).toBe(401);
  });

  it('serves tools/list while membership is active, then 401s after removal', async () => {
    seed({ status: 'running' });
    const live = await postMcp('/mcp', toolsList);
    expect(live.status).toBe(200);

    sqlite
      .prepare(`UPDATE project_members SET status = 'removed' WHERE user_id = 'user-1'`)
      .run();
    const stale = await postMcp('/mcp', toolsList);
    expect(stale.status).toBe(401);
    expect(await tokenStillStored()).toBe(false);
  });

  it('refuses webhook-claim redemption for a stopped workspace token', async () => {
    seed({ status: 'running' });
    // Control: a live workspace's token authenticates and reaches the claim lookup
    // (webhook triggers are off in this env, so the claim itself is not found).
    const live = await postMcp('/mcp/webhook-claims/claim-1');
    expect(live.status).toBe(404);

    setWorkspaceStatus('stopped');
    const res = await postMcp('/mcp/webhook-claims/claim-1');
    expect(res.status).toBe(401);
  });
});
