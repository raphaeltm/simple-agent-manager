/**
 * Workspace MCP tokens are bound to their workspace's lifecycle
 * (`validateActiveWorkspaceMcpToken`). Every case runs the real lifecycle SQL against a
 * real SQLite engine, and the route cases enter through the real `/mcp` router, so a
 * deleted predicate or a bypassed call site turns them red.
 */
import { DEFAULT_MCP_TOKEN_TTL_SECONDS } from '@simple-agent-manager/shared';
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

function setMembership(change: { status?: string; role?: string }): void {
  if (change.status) {
    sqlite
      .prepare(`UPDATE project_members SET status = ? WHERE user_id = 'user-1'`)
      .run(change.status);
  }
  if (change.role) {
    sqlite.prepare(`UPDATE project_members SET role = ? WHERE user_id = 'user-1'`).run(change.role);
  }
}

function setUserStatus(status: string | null): void {
  sqlite.prepare(`UPDATE users SET status = ? WHERE id = 'user-1'`).run(status);
}

function setUserRole(role: string): void {
  sqlite.prepare(`UPDATE users SET role = ? WHERE id = 'user-1'`).run(role);
}

/** Write the runtime `signup.requireApproval` row the admin toggle writes, or delete it. */
function setSignupApprovalSetting(value: 'true' | 'false' | null): void {
  sqlite.prepare(`DELETE FROM platform_settings WHERE key = 'signup.requireApproval'`).run();
  if (value !== null) {
    sqlite
      .prepare(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ('signup.requireApproval', ?, '2026-11-16T00:00:00Z')`
      )
      .run(value);
  }
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
    .prepare(
      `INSERT INTO users (id, email, status) VALUES ('user-1', 'user@example.test', 'active')`
    )
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
    setMembership({ role: 'viewer' });
    seed({ status: 'running' });

    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
    expect(await tokenStillStored()).toBe(true);
  });

  it('accepts a project owner through their owner membership row', async () => {
    sqlite
      .prepare(`INSERT INTO projects (id, user_id, name) VALUES ('project-1', 'user-1', 'p1')`)
      .run();
    seed({ status: 'running' });

    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
  });

  it('revokes the token when the member is removed from the project', async () => {
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();

    setMembership({ status: 'removed' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(false);

    // Re-adding the member cannot resurrect the revoked token.
    setMembership({ status: 'active' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
  });

  it('revokes the token when the member has no membership row at all', async () => {
    sqlite.prepare(`DELETE FROM project_members WHERE user_id = 'user-1'`).run();
    seed({ status: 'running' });

    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(false);
  });

  it('revokes the token when the user account row is gone (user deleted)', async () => {
    sqlite.prepare(`DELETE FROM users WHERE id = 'user-1'`).run();
    seed({ status: 'running' });

    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(false);
  });

  it('rejects, but keeps, the token while the user is suspended, and accepts it again after unsuspend', async () => {
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();

    setUserStatus('suspended');
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(true);

    setUserStatus('active');
    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
  });

  it('does not slide the idle TTL of a token it rejects, and slides it again once accepted', async () => {
    seed({ status: 'running' });
    // Make the sliding refresh due: last refreshed longer ago than half the idle TTL.
    const due = new Date(Date.now() - (DEFAULT_MCP_TOKEN_TTL_SECONDS * 1000 * 3) / 4).toISOString();
    await env.KV.put(
      `mcp:${TOKEN}`,
      JSON.stringify({ ...TOKEN_DATA, createdAt: due, lastRefreshedAt: due })
    );
    const storedRefresh = async () =>
      ((await env.KV.get(`mcp:${TOKEN}`, { type: 'json' })) as { lastRefreshedAt?: string } | null)
        ?.lastRefreshedAt;

    setUserStatus('suspended');
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await storedRefresh()).toBe(due);

    setUserStatus('active');
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();
    expect(await storedRefresh()).not.toBe(due);
  });

  it.each(['invited', 'suspended'])(
    'rejects, but keeps, the token while membership is %s, and accepts it again once active',
    async (membershipStatus) => {
      seed({ status: 'running' });
      setMembership({ status: membershipStatus });

      expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
      expect(await tokenStillStored()).toBe(true);

      setMembership({ status: 'active' });
      await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
    }
  );

  it('rejects, but keeps, the token for an unrecognised account status', async () => {
    setUserStatus('system');
    seed({ status: 'running' });

    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(true);
  });

  it.each([
    ['pending while signup approval is not required', 'pending'],
    ['NULL (the D1 column default is active)', null],
  ])('accepts the token when the account status is %s', async (_label, status) => {
    setUserStatus(status);
    seed({ status: 'running' });

    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
  });

  it.each([
    ['suspended', () => setUserStatus('suspended')],
    [
      'pending while approval is required',
      () => {
        setUserStatus('pending');
        setSignupApprovalSetting('true');
      },
    ],
    ['in an unrecognised status', () => setUserStatus('system')],
  ] as const)(
    'revokes when membership is removed while the account is %s, so restoring both cannot revive the token',
    async (_label, makeAccountReversiblyRefused) => {
      seed({ status: 'running' });
      expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();

      makeAccountReversiblyRefused();
      setMembership({ status: 'removed' });
      expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
      expect(await tokenStillStored()).toBe(false);

      // Re-admit the member and clear the account state: the revoked token stays dead.
      setMembership({ status: 'active' });
      setUserStatus('active');
      setSignupApprovalSetting(null);
      expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    }
  );

  it('revokes when the membership row is gone while the account is suspended', async () => {
    seed({ status: 'running' });
    setUserStatus('suspended');
    sqlite.prepare(`DELETE FROM project_members WHERE user_id = 'user-1'`).run();

    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(false);
  });

  it('rejects, but keeps, a pending owner token once approval is turned on, and accepts it again after approval', async () => {
    setUserStatus('pending');
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).not.toBeNull();

    setSignupApprovalSetting('true');
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(true);

    setUserStatus('active');
    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
  });

  it('accepts a pending owner token again when approval is turned back off', async () => {
    setUserStatus('pending');
    setSignupApprovalSetting('true');
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();

    setSignupApprovalSetting('false');
    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
  });

  it('falls back to REQUIRE_APPROVAL when no runtime setting row exists, and the row overrides it', async () => {
    env = { ...env, REQUIRE_APPROVAL: 'true' } as Env;
    setUserStatus('pending');
    seed({ status: 'running' });
    expect(await validateActiveWorkspaceMcpToken(env, TOKEN)).toBeNull();
    expect(await tokenStillStored()).toBe(true);

    setSignupApprovalSetting('false');
    await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
  });

  it.each(['true', 'false'])(
    'treats an unparseable stored setting as REQUIRE_APPROVAL=%s, like REST',
    async (requireApprovalEnv) => {
      env = { ...env, REQUIRE_APPROVAL: requireApprovalEnv } as Env;
      setUserStatus('pending');
      sqlite
        .prepare(
          `INSERT INTO platform_settings (key, value, updated_at) VALUES ('signup.requireApproval', 'garbage', '2026-11-16T00:00:00Z')`
        )
        .run();
      seed({ status: 'running' });

      const result = await validateActiveWorkspaceMcpToken(env, TOKEN);
      if (requireApprovalEnv === 'true') {
        expect(result).toBeNull();
        expect(await tokenStillStored()).toBe(true);
      } else {
        expect(result).toMatchObject(TOKEN_DATA);
      }
    }
  );

  it.each([
    ['an active user', 'active', 'user'],
    ['a pending platform admin', 'pending', 'admin'],
    ['a pending superadmin', 'pending', 'superadmin'],
  ])(
    'accepts %s while approval is required (same exemptions as REST)',
    async (_label, status, role) => {
      setUserStatus(status);
      setUserRole(role);
      setSignupApprovalSetting('true');
      seed({ status: 'running' });

      await expect(validateActiveWorkspaceMcpToken(env, TOKEN)).resolves.toMatchObject(TOKEN_DATA);
    }
  );

  it('rejects a member of project A acting through a workspace in project B, while project B owner is accepted', async () => {
    // user-1 is an active owner of project-1 only. user-2 owns project-2.
    sqlite
      .prepare(
        `INSERT INTO users (id, email, status) VALUES ('user-2', 'two@example.test', 'active')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES ('project-2', 'user-2', 'owner', 'active')`
      )
      .run();
    sqlite
      .prepare(`INSERT INTO nodes (id, user_id, status) VALUES ('node-b', 'user-2', 'running')`)
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, user_id, project_id, node_id, status) VALUES
           ('ws-attack', 'user-1', 'project-2', 'node-b', 'running'),
           ('ws-owner', 'user-2', 'project-2', 'node-b', 'running')`
      )
      .run();
    const attack = {
      taskId: '',
      projectId: 'project-2',
      userId: 'user-1',
      workspaceId: 'ws-attack',
    };
    const owner = { taskId: '', projectId: 'project-2', userId: 'user-2', workspaceId: 'ws-owner' };
    await storeMcpToken(env.KV, 'attack-token', attack);
    await storeMcpToken(env.KV, 'owner-token', owner);

    expect(await validateActiveWorkspaceMcpToken(env, 'attack-token')).toBeNull();
    expect(await env.KV.get('mcp:attack-token')).toBeNull();
    await expect(validateActiveWorkspaceMcpToken(env, 'owner-token')).resolves.toMatchObject(owner);
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

    setMembership({ status: 'removed' });
    const stale = await postMcp('/mcp', toolsList);
    expect(stale.status).toBe(401);
    expect(await tokenStillStored()).toBe(false);
  });

  it('401s while the account is suspended, then serves the same token again after unsuspend', async () => {
    seed({ status: 'running' });
    expect((await postMcp('/mcp', toolsList)).status).toBe(200);

    setUserStatus('suspended');
    expect((await postMcp('/mcp', toolsList)).status).toBe(401);

    setUserStatus('active');
    expect((await postMcp('/mcp', toolsList)).status).toBe(200);
  });

  it('401s for a pending owner once signup approval is turned on, then serves again after approval', async () => {
    setUserStatus('pending');
    seed({ status: 'running' });
    expect((await postMcp('/mcp', toolsList)).status).toBe(200);

    setSignupApprovalSetting('true');
    expect((await postMcp('/mcp', toolsList)).status).toBe(401);
    expect(await tokenStillStored()).toBe(true);

    setUserStatus('active');
    expect((await postMcp('/mcp', toolsList)).status).toBe(200);
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
