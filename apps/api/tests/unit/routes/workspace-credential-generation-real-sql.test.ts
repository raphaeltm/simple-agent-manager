/**
 * Credentials of a retired runtime stop working when the same workspace ID runs again.
 *
 * Incarnation A of a VM workspace holds a callback JWT and an agent session's SAM MCP
 * token. It stops (or keeps running and is rebuilt). The user restarts or rebuilds it
 * through the real lifecycle route, which reactivates the same workspace ID as incarnation
 * B. B's credentials must work; A's must not, at the credential verifier, a state sink
 * (`/ready`, `/provisioning-failed`), the AI proxy, MCP, and MCP token rotation.
 *
 * Everything is real except the edges: real RS256 JWTs, the real Hono routes over a real
 * SQLite engine, an in-memory KV, and a stubbed fetch standing in for the VM agent. Token B
 * is the one the route actually delivers to the agent in the restart request.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';
import { mcpTokenRotationRoutes } from '../../../src/routes/workspaces/mcp-token-rotation';
import { runtimeRoutes } from '../../../src/routes/workspaces/runtime';
import { verifyAIProxyAuth } from '../../../src/services/ai-proxy-auth';
import { encrypt } from '../../../src/services/encryption';
import { signCallbackToken, verifyCallbackToken } from '../../../src/services/jwt';
import { storeMcpToken } from '../../../src/services/mcp-token';
import { validateActiveWorkspaceMcpToken } from '../../../src/services/mcp-token-lifecycle';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cancelWorkspaceDeletion: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user-gen',
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));
vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: (...args: unknown[]) => mocks.requireRepositoryOwnerAccess(...args),
}));
vi.mock('../../../src/services/boot-log', () => ({ writeBootLogs: vi.fn(async () => undefined) }));
vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/session-sleep', () => ({ sleepWorkspaceSession: vi.fn() }));

const USER_ID = 'user-gen';
const PROJECT_ID = 'project-gen';
const NODE_ID = 'node-gen';
const WORKSPACE_ID = 'workspace-gen';
const CHAT_SESSION_ID = 'chat-gen';
const MCP_TOKEN_A = 'mcp-token-of-incarnation-a';
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let keys: { privateKey: string; publicKey: string };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  keys = {
    privateKey: await exportPKCS8(pair.privateKey),
    publicKey: await exportSPKI(pair.publicKey),
  };
});

function memoryKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string, options?: { type?: string } | string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      const type = typeof options === 'string' ? options : options?.type;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('workspace credential generation across VM restart and rebuild — real SQL, real JWTs', () => {
  let sqlite: Database.Database;
  let env: Env;
  let kv: ReturnType<typeof memoryKv>;
  let app: Hono<{ Bindings: Env }>;
  let waitUntilPromises: Promise<unknown>[];
  let agentRequests: Array<{ url: string; body: Record<string, unknown> | null }>;
  let agentResponse: () => Response;

  async function request(
    path: string,
    init: { method?: string; token?: string; body?: unknown } = {}
  ): Promise<Response> {
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const response = await app.fetch(
      new Request(`https://api.test/api/workspaces/${WORKSPACE_ID}${path}`, {
        method: init.method ?? 'POST',
        headers: {
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      }),
      env,
      executionContext
    );
    await Promise.all(waitUntilPromises.splice(0));
    return response;
  }

  function workspaceRow(): {
    status: string;
    callbackGeneration: string | null;
    errorMessage: string | null;
  } {
    return sqlite
      .prepare(
        'SELECT status, callback_generation AS callbackGeneration, error_message AS errorMessage FROM workspaces WHERE id = ?'
      )
      .get(WORKSPACE_ID) as never;
  }

  async function storeMcpTokenForGeneration(token: string, generation: string | null) {
    await storeMcpToken(kv, token, {
      taskId: '',
      contextType: 'conversation',
      taskMode: 'conversation',
      projectId: PROJECT_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      chatSessionId: CHAT_SESSION_ID,
      agentSessionId: 'agent-session-gen',
      ...(generation === undefined ? {} : { callbackGeneration: generation }),
      createdAt: new Date().toISOString(),
    });
  }

  /** The callback token the route handed to the VM agent in its restart/rebuild request. */
  function deliveredToken(): string {
    const delivered = agentRequests.find((r) => /\/(restart|rebuild)$/.test(r.url));
    expect(delivered?.body?.callbackToken).toEqual(expect.any(String));
    return delivered!.body!.callbackToken as string;
  }

  /** The VM agent reports the new runtime ready, as production does, with the token it received. */
  async function agentReportsReady(token: string): Promise<Response> {
    return request('/ready', { token, body: { status: 'running' } });
  }

  async function verifyStatus(token: string): Promise<number> {
    try {
      await verifyCallbackToken(token, env);
      return 200;
    } catch (err) {
      return err instanceof AppError ? err.statusCode : 500;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
    waitUntilPromises = [];
    agentRequests = [];
    agentResponse = () => Response.json({ status: 'creating' }, { status: 202 });
    kv = memoryKv();
    sqlite
      .prepare("INSERT INTO users (id, email, role, status) VALUES (?, ?, 'user', 'active')")
      .run(USER_ID, 'gen@example.test');
    sqlite
      .prepare("INSERT INTO projects (id, user_id, name, repo_provider) VALUES (?, ?, ?, 'github')")
      .run(PROJECT_ID, USER_ID, 'Generation project');
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')`
      )
      .run(PROJECT_ID, USER_ID);
    sqlite
      .prepare(
        `INSERT INTO nodes
           (id, user_id, name, status, health_status, node_role, node_class, runtime,
            provider_instance_id, credential_source, observed_hardware_source,
            observed_provider_instance_vcpu_count, observed_provider_instance_memory_mb,
            observed_provider_instance_disk_gb, last_heartbeat_at, last_metrics)
         VALUES (?, ?, 'Generation node', 'running', 'healthy', 'workspace', 'managed', 'vm',
                 'vm-1', 'user', 'observed', 2, 4096, 80, ?, ?)`
      )
      .run(
        NODE_ID,
        USER_ID,
        new Date().toISOString(),
        JSON.stringify({ version: 1, cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 })
      );
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, user_id, project_id, chat_session_id, name, repository, branch,
            status, vm_size, vm_location, eviction_generation, callback_generation,
            resolved_reservation_json)
         VALUES (?, ?, ?, ?, ?, 'Generation workspace', 'example/repository', 'main',
                 'running', 'small', 'nbg1', 'eviction-a', 'generation-a', ?)`
      )
      .run(
        WORKSPACE_ID,
        NODE_ID,
        USER_ID,
        PROJECT_ID,
        CHAT_SESSION_ID,
        JSON.stringify({
          version: 1,
          cpuMillis: 1000,
          memoryMb: 1024,
          diskMb: 1024,
          exclusiveNode: false,
          source: 'platform',
          sourceId: 'platform',
        })
      );
    mocks.cancelWorkspaceDeletion.mockResolvedValue(true);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const rawBody = init?.body ?? (input instanceof Request ? await input.text() : undefined);
        agentRequests.push({
          url,
          body: typeof rawBody === 'string' && rawBody ? JSON.parse(rawBody) : null,
        });
        return agentResponse();
      })
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.test',
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_PUBLIC_KEY: keys.publicKey,
      ENCRYPTION_KEY: ENCRYPTION_KEY,
      KV: kv,
      NODE_LIFECYCLE: {
        idFromName: (name: string) => name,
        get: () => ({ cancelWorkspaceDeletion: mocks.cancelWorkspaceDeletion }),
      } as unknown as DurableObjectNamespace,
    } as unknown as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/workspaces', lifecycleRoutes);
    app.route('/api/workspaces', mcpTokenRotationRoutes);
    app.route('/api/workspaces', runtimeRoutes);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  async function stopIncarnationA(): Promise<void> {
    sqlite.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = ?").run(WORKSPACE_ID);
  }

  it('restart: incarnation A is refused at every sink once incarnation B runs, and B works', async () => {
    const tokenA = await signCallbackToken(WORKSPACE_ID, env, {
      callbackGeneration: 'generation-a',
    });
    await storeMcpTokenForGeneration(MCP_TOKEN_A, 'generation-a');
    // Liveness: A's credentials work while A runs.
    expect(await verifyStatus(tokenA)).toBe(200);
    expect(await validateActiveWorkspaceMcpToken(env, MCP_TOKEN_A)).not.toBeNull();

    await stopIncarnationA();
    expect((await request('/restart')).status).toBe(200);

    // The admission write rotated the generation, and the agent received B's token.
    const rotated = workspaceRow();
    expect(rotated.status).toBe('creating');
    expect(rotated.callbackGeneration).not.toBe('generation-a');
    const tokenB = deliveredToken();
    expect(decodeJwt(tokenB).cgen).toBe(rotated.callbackGeneration);

    // A cannot report the new runtime ready or fail it; B can.
    expect((await agentReportsReady(tokenA)).status).toBe(401);
    expect(
      (await request('/provisioning-failed', { token: tokenA, body: { errorMessage: 'x' } })).status
    ).toBe(401);
    expect((await agentReportsReady(tokenB)).status).toBe(200);
    expect(workspaceRow().status).toBe('running');

    // Secret delivery route: the project's runtime assets reach B, and A gets nothing.
    const sealed = await encrypt('runtime-secret-value', ENCRYPTION_KEY);
    sqlite
      .prepare(
        `INSERT INTO project_runtime_env_vars (id, project_id, user_id, env_key, stored_value, value_iv, is_secret)
         VALUES ('env-1', ?, ?, 'PROJECT_SECRET', ?, ?, 1)`
      )
      .run(PROJECT_ID, USER_ID, sealed.ciphertext, sealed.iv);
    const assetsForA = await request('/runtime-assets', { method: 'GET', token: tokenA });
    expect(assetsForA.status).toBe(401);
    expect(await assetsForA.text()).not.toContain('PROJECT_SECRET');
    const assetsForB = await request('/runtime-assets', { method: 'GET', token: tokenB });
    expect(assetsForB.status).toBe(200);
    expect(await assetsForB.json()).toMatchObject({
      envVars: [expect.objectContaining({ key: 'PROJECT_SECRET', isSecret: true })],
    });

    // Verifier and AI proxy: B accepted, A refused although the workspace is active again.
    expect(await verifyStatus(tokenA)).toBe(401);
    expect(await verifyStatus(tokenB)).toBe(200);
    const db = drizzle(env.DATABASE, { schema });
    await expect(verifyAIProxyAuth(tokenA, env, db)).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyAIProxyAuth(tokenB, env, db)).resolves.toMatchObject({
      workspaceId: WORKSPACE_ID,
    });

    // MCP: A's callback token cannot rotate A's MCP token (B's credential is required) ...
    expect(
      (await request('/mcp-token/rotate', { token: tokenA, body: { mcpToken: MCP_TOKEN_A } }))
        .status
    ).toBe(401);
    // ... B's agent exchanges it, and only the replacement authenticates afterwards.
    const rotation = await request('/mcp-token/rotate', {
      token: tokenB,
      body: { mcpToken: MCP_TOKEN_A },
    });
    expect(rotation.status).toBe(200);
    const { token: mcpTokenB } = (await rotation.json()) as { token: string };
    expect(mcpTokenB).not.toBe(MCP_TOKEN_A);
    expect(await validateActiveWorkspaceMcpToken(env, MCP_TOKEN_A)).toBeNull();
    expect(await validateActiveWorkspaceMcpToken(env, mcpTokenB)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      agentSessionId: 'agent-session-gen',
      callbackGeneration: rotated.callbackGeneration,
    });
  });

  it('until B starts, A keeps its lifecycle treatment: allowed cleanup callbacks still work', async () => {
    const tokenA = await signCallbackToken(WORKSPACE_ID, env, {
      callbackGeneration: 'generation-a',
    });
    // A stopping runtime is refused by the lifecycle check, not by a generation change.
    await stopIncarnationA();
    expect(await verifyStatus(tokenA)).toBe(200);
    const db = drizzle(env.DATABASE, { schema });
    await expect(verifyAIProxyAuth(tokenA, env, db)).rejects.toMatchObject({ statusCode: 403 });
    // A provisioning-failure report for a workspace in error is a permitted cleanup callback.
    sqlite.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(WORKSPACE_ID);
    expect(
      (await request('/provisioning-failed', { token: tokenA, body: { errorMessage: 'boom' } }))
        .status
    ).toBe(200);
    expect(workspaceRow().callbackGeneration).toBe('generation-a');
  });

  it('restart: a copied MCP token from A is refused and revoked without any exchange', async () => {
    await storeMcpTokenForGeneration(MCP_TOKEN_A, 'generation-a');
    await stopIncarnationA();
    expect((await request('/restart')).status).toBe(200);
    expect((await agentReportsReady(deliveredToken())).status).toBe(200);

    expect(await validateActiveWorkspaceMcpToken(env, MCP_TOKEN_A)).toBeNull();
    expect(kv.store.has(`mcp:${MCP_TOKEN_A}`)).toBe(false);
  });

  it('restart: legacy credentials minted before generations existed die at the first rotation', async () => {
    sqlite
      .prepare('UPDATE workspaces SET callback_generation = NULL WHERE id = ?')
      .run(WORKSPACE_ID);
    const legacyToken = await signCallbackToken(WORKSPACE_ID, env, { callbackGeneration: null });
    await storeMcpTokenForGeneration('legacy-mcp', null);
    expect(decodeJwt(legacyToken).cgen).toBeUndefined();
    expect(await verifyStatus(legacyToken)).toBe(200);
    expect(await validateActiveWorkspaceMcpToken(env, 'legacy-mcp')).not.toBeNull();

    await stopIncarnationA();
    expect((await request('/restart')).status).toBe(200);
    expect((await agentReportsReady(deliveredToken())).status).toBe(200);

    expect(await verifyStatus(legacyToken)).toBe(401);
    expect(await validateActiveWorkspaceMcpToken(env, 'legacy-mcp')).toBeNull();
  });

  describe('MCP token rotation endpoint', () => {
    async function restartedTokenB(): Promise<string> {
      await stopIncarnationA();
      expect((await request('/restart')).status).toBe(200);
      const tokenB = deliveredToken();
      expect((await agentReportsReady(tokenB)).status).toBe(200);
      return tokenB;
    }

    it('refuses an MCP token issued for another workspace and leaves it intact', async () => {
      const tokenB = await restartedTokenB();
      await storeMcpToken(kv, 'foreign-mcp', {
        taskId: '',
        projectId: PROJECT_ID,
        userId: USER_ID,
        workspaceId: 'another-workspace',
        callbackGeneration: 'generation-a',
        createdAt: new Date().toISOString(),
      });
      const response = await request('/mcp-token/rotate', {
        token: tokenB,
        body: { mcpToken: 'foreign-mcp' },
      });
      expect(response.status).toBe(403);
      expect(kv.store.has('mcp:foreign-mcp')).toBe(true);
    });

    it('answers an unknown or expired MCP token with 404', async () => {
      const tokenB = await restartedTokenB();
      const response = await request('/mcp-token/rotate', {
        token: tokenB,
        body: { mcpToken: 'never-issued' },
      });
      expect(response.status).toBe(404);
    });

    it('returns an already-current token unchanged instead of minting another', async () => {
      const tokenB = await restartedTokenB();
      const current = workspaceRow().callbackGeneration;
      await storeMcpTokenForGeneration('current-mcp', current);
      const response = await request('/mcp-token/rotate', {
        token: tokenB,
        body: { mcpToken: 'current-mcp' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'current-mcp' });
      expect([...kv.store.keys()].filter((key) => key.startsWith('mcp:'))).toEqual([
        'mcp:current-mcp',
      ]);
    });

    it('refuses an exchange while the workspace is not running', async () => {
      const tokenB = await restartedTokenB();
      await storeMcpTokenForGeneration(MCP_TOKEN_A, 'generation-a');
      sqlite.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = ?").run(WORKSPACE_ID);
      const response = await request('/mcp-token/rotate', {
        token: tokenB,
        body: { mcpToken: MCP_TOKEN_A },
      });
      expect(response.status).toBe(410);
      expect(kv.store.has(`mcp:${MCP_TOKEN_A}`)).toBe(true);
    });
  });

  it('rebuild of a running workspace retires the running incarnation the same way', async () => {
    const tokenA = await signCallbackToken(WORKSPACE_ID, env, {
      callbackGeneration: 'generation-a',
    });
    expect(await verifyStatus(tokenA)).toBe(200);

    expect((await request('/rebuild')).status).toBe(202);
    const tokenB = deliveredToken();
    expect((await agentReportsReady(tokenA)).status).toBe(401);
    expect((await agentReportsReady(tokenB)).status).toBe(200);
    expect(await verifyStatus(tokenA)).toBe(401);
    expect(await verifyStatus(tokenB)).toBe(200);
  });

  it('an old VM agent that cannot take the new token fails the restart closed, explained', async () => {
    const tokenA = await signCallbackToken(WORKSPACE_ID, env, {
      callbackGeneration: 'generation-a',
    });
    // Exactly what a pre-release agent answers to an unknown field (workspace_reprovision.go).
    agentResponse = () =>
      Response.json({ error: 'invalid workspace restart request' }, { status: 400 });
    await stopIncarnationA();
    expect((await request('/restart')).status).toBe(200);

    const row = workspaceRow();
    expect(row.status).toBe('error');
    expect(row.errorMessage).toContain('too old to receive a new workspace credential');
    // Fail closed: the old runtime's token does not come back to life.
    expect(await verifyStatus(tokenA)).toBe(401);
  });

  it('control: an unrelated agent rejection keeps its own message', async () => {
    agentResponse = () => Response.json({ error: 'disk full' }, { status: 500 });
    await stopIncarnationA();
    expect((await request('/restart')).status).toBe(200);
    expect(workspaceRow().errorMessage).not.toContain('too old');
  });
});
