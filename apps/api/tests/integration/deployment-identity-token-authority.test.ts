/**
 * The GCP deployment identity endpoint hands a signed OIDC token to whoever presents a live
 * workspace MCP token. It must re-check the actor's CURRENT project authority on every call:
 * membership through the token lifecycle gate (`validateActiveWorkspaceMcpToken`), and the
 * `deployment:deploy` capability through `requireProjectCapability`, both BEFORE a cached
 * identity token is read or a new one is signed.
 *
 * Real route, real lifecycle SQL and real project-auth SQL against SQLite; only the signer is
 * stubbed so the test can see whether signing was reached.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signer = vi.hoisted(() => ({ signIdentityToken: vi.fn() }));
vi.mock('../../src/services/jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/jwt')>()),
  signIdentityToken: signer.signIdentityToken,
}));

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { deploymentIdentityTokenRoute } from '../../src/routes/project-deployment';
import { createJsonKv, storeMcpToken } from '../helpers/mcp-route';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const TOKEN = 'deploy-identity-mcp-token';
const IDENTITY = { taskId: '', projectId: 'project-1', userId: 'user-1', workspaceId: 'ws-1' };

let sqlite: Database.Database;
let env: Env;
let kvReads: string[];
let app: Hono;

function setMember(change: { role?: string; status?: string }): void {
  if (change.role) {
    sqlite.prepare(`UPDATE project_members SET role = ? WHERE user_id = 'user-1'`).run(change.role);
  }
  if (change.status) {
    sqlite
      .prepare(`UPDATE project_members SET status = ? WHERE user_id = 'user-1'`)
      .run(change.status);
  }
}

async function requestIdentityToken(): Promise<Response> {
  return app.request(
    '/api/projects/project-1/deployment-identity-token',
    { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
    env
  );
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
  sqlite.exec(`
    INSERT INTO users (id, email, status) VALUES ('user-1', 'user-1@example.test', 'active');
    INSERT INTO projects (id, user_id, name) VALUES ('project-1', 'owner-1', 'Project');
    INSERT INTO project_members (project_id, user_id, role, status)
      VALUES ('project-1', 'user-1', 'maintainer', 'active');
    INSERT INTO nodes (id, user_id, status) VALUES ('node-1', 'user-1', 'running');
    INSERT INTO workspaces (id, user_id, project_id, node_id, status)
      VALUES ('ws-1', 'user-1', 'project-1', 'node-1', 'running');
    INSERT INTO project_deployment_credentials
      (id, project_id, user_id, provider, gcp_project_id, gcp_project_number,
       service_account_email, wif_pool_id, wif_provider_id)
      VALUES ('cred-1', 'project-1', 'owner-1', 'gcp', 'gcp-project', '123456',
              'deployer@gcp-project.iam.example.test', 'pool', 'provider');
  `);
  const kv = createJsonKv();
  kvReads = [];
  const get = kv.get.bind(kv);
  kv.get = (async (key: string, type?: unknown) => {
    kvReads.push(key);
    return get(key, type as never);
  }) as KVNamespace['get'];
  env = { DATABASE: createSqliteD1(sqlite), KV: kv } as unknown as Env;
  await storeMcpToken(env.KV, TOKEN, IDENTITY);
  signer.signIdentityToken.mockResolvedValue('signed-identity-token');

  app = new Hono();
  app.onError(handleAppError);
  app.route('/api/projects', deploymentIdentityTokenRoute);
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

const cacheReads = () => kvReads.filter((key) => key.startsWith('identity-token-cache:'));

describe('GET /api/projects/:id/deployment-identity-token current authority', () => {
  it('signs a token for an active member whose role can deploy (control)', async () => {
    const res = await requestIdentityToken();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: 'signed-identity-token' });
    expect(signer.signIdentityToken).toHaveBeenCalledTimes(1);
  });

  it('403s an active viewer before reading the identity-token cache or signing', async () => {
    setMember({ role: 'viewer' });

    const res = await requestIdentityToken();

    expect(res.status).toBe(403);
    expect(cacheReads()).toEqual([]);
    expect(signer.signIdentityToken).not.toHaveBeenCalled();
  });

  it('stops serving a previously cached identity token once the member is downgraded', async () => {
    expect((await requestIdentityToken()).status).toBe(200);
    expect(signer.signIdentityToken).toHaveBeenCalledTimes(1);

    setMember({ role: 'viewer' });
    const res = await requestIdentityToken();

    expect(res.status).toBe(403);
    expect(signer.signIdentityToken).toHaveBeenCalledTimes(1);
  });

  it('403s and revokes the MCP token of a member removed from the project', async () => {
    setMember({ status: 'removed' });

    const res = await requestIdentityToken();

    expect(res.status).toBe(403);
    expect(cacheReads()).toEqual([]);
    expect(signer.signIdentityToken).not.toHaveBeenCalled();
    expect(await env.KV.get(`mcp:${TOKEN}`)).toBeNull();
  });
});
