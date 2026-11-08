/**
 * A workspace callback token may only spend model credentials through the AI proxy while
 * its workspace is active on a live node (`verifyAIProxyAuth`). Tokens are really signed and
 * verified, and the lifecycle predicate runs against a real SQLite engine, so a dropped
 * status or node check turns these red.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { prepareAIProxyRequest } from '../../../src/routes/ai-proxy-admission';
import { AIProxyAuthError, verifyAIProxyAuth } from '../../../src/services/ai-proxy-auth';
import { signCallbackToken, signNodeCallbackToken } from '../../../src/services/jwt';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let keys: { privateKey: string; publicKey: string };
let sqlite: Database.Database;
let env: Env;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  keys = {
    privateKey: await exportPKCS8(pair.privateKey),
    publicKey: await exportSPKI(pair.publicKey),
  };
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
  env = {
    DATABASE: createSqliteD1(sqlite),
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
    BASE_DOMAIN: 'example.test',
  } as unknown as Env;
});

afterEach(() => sqlite.close());

function seed(workspaceStatus: string, nodeStatus: string | null = 'running'): void {
  if (nodeStatus !== null) {
    sqlite
      .prepare(`INSERT INTO nodes (id, user_id, status) VALUES ('node-1', 'user-1', ?)`)
      .run(nodeStatus);
  }
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, project_id, node_id, status)
       VALUES ('ws-1', 'user-1', 'project-1', 'node-1', ?)`
    )
    .run(workspaceStatus);
}

function setWorkspaceStatus(status: string): void {
  sqlite.prepare(`UPDATE workspaces SET status = ? WHERE id = 'ws-1'`).run(status);
}

async function verify(token: string) {
  const { drizzle } = await import('drizzle-orm/d1');
  return verifyAIProxyAuth(token, env, drizzle(env.DATABASE, { schema }));
}

async function rejection(promise: Promise<unknown>): Promise<AIProxyAuthError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(AIProxyAuthError);
  return error as AIProxyAuthError;
}

describe('verifyAIProxyAuth lifecycle binding', () => {
  it.each(['creating', 'running', 'recovery'])(
    'accepts a workspace token while the workspace is %s',
    async (status) => {
      seed(status);
      const result = await verify(await signCallbackToken('ws-1', env));
      expect(result).toMatchObject({
        workspaceId: 'ws-1',
        userId: 'user-1',
        projectId: 'project-1',
      });
    }
  );

  it.each(['stopping', 'stopped', 'sleeping', 'evicted', 'deleted', 'error', 'pending'])(
    'refuses a still-unexpired token once its workspace is %s',
    async (status) => {
      seed(status);
      const error = await rejection(verify(await signCallbackToken('ws-1', env)));
      expect(error.statusCode).toBe(403);
    }
  );

  it.each([
    ['stopping', 'stopping'],
    ['destroying', 'destroying'],
    ['destroyed', 'destroyed'],
    ['deleted', 'deleted'],
    ['missing', null],
  ] as const)('refuses a running workspace whose node is %s', async (_label, nodeStatus) => {
    seed('running', nodeStatus);
    const error = await rejection(verify(await signCallbackToken('ws-1', env)));
    expect(error.statusCode).toBe(403);
  });

  it('refuses the same token after its workspace stops, having accepted it while running', async () => {
    seed('running');
    const token = await signCallbackToken('ws-1', env);
    await expect(verify(token)).resolves.toMatchObject({ workspaceId: 'ws-1' });

    setWorkspaceStatus('stopped');
    expect((await rejection(verify(token))).statusCode).toBe(403);
  });

  it('refuses a node-scoped token even when it names a running workspace id', async () => {
    seed('running');
    await expect(verify(await signNodeCallbackToken('ws-1', env))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses an unscoped legacy token for a running workspace', async () => {
    seed('running');
    const legacy = await new SignJWT({ workspace: 'ws-1', type: 'callback' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer('https://api.example.test')
      .setSubject('ws-1')
      .setAudience('workspace-callback')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(await importPKCS8(keys.privateKey, 'RS256'));
    await expect(verify(legacy)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('AI proxy admission (/ai/v1) refuses inactive workspaces before any upstream call', () => {
  function app(): Hono<{ Bindings: Env }> {
    const instance = new Hono<{ Bindings: Env }>();
    instance.post('/ai/v1/chat/completions', async (c) => {
      const prepared = await prepareAIProxyRequest(c);
      if (prepared instanceof Response) return prepared;
      return c.json({ admitted: prepared.workspaceId });
    });
    return instance;
  }

  async function post(token: string): Promise<Response> {
    return app().request(
      '/ai/v1/chat/completions',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' },
      env
    );
  }

  it('admits a running workspace token, then refuses it with 403 once the workspace sleeps', async () => {
    seed('running');
    const token = await signCallbackToken('ws-1', env);

    const live = await post(token);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ admitted: 'ws-1' });

    setWorkspaceStatus('sleeping');
    const stale = await post(token);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { message: 'Workspace is not active' } });
  });
});
