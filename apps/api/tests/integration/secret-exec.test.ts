import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/node-agent', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/node-agent')>(
    '../../src/services/node-agent'
  )),
  fetchNodeAgent: boundary.fetch,
}));

import type { Env } from '../../src/env';
import { mcpRoutes } from '../../src/routes/mcp';
import type { JsonRpcResponse } from '../../src/routes/mcp/_helpers';
import { encrypt } from '../../src/services/encryption';
import type { McpTokenData } from '../../src/services/mcp-token';
import { createSqliteD1 } from '../helpers/sqlite-d1';

let sqlite: Database.Database | undefined;
afterEach(() => {
  sqlite?.close();
  vi.clearAllMocks();
});

async function fixture() {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT,agent_profile_hint TEXT,status TEXT,node_id TEXT);
    CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,agent_profile_id TEXT,skill_id TEXT);
    CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE skills(id TEXT PRIMARY KEY,project_id TEXT);
    INSERT INTO workspaces VALUES('ws','user','project',NULL,'running','node-1'),('other-ws','other-user','other-project',NULL,'running','node-2');
    INSERT INTO agent_sessions VALUES('session','ws','user','profile','skill'),('other-session','other-ws','other-user',NULL,NULL);
    INSERT INTO agent_profiles VALUES('profile','project');
    INSERT INTO skills VALUES('skill','project');
  `);
  for (const scope of ['project', 'profile', 'skill']) {
    sqlite.exec(
      `CREATE TABLE ${scope}_runtime_env_vars(id TEXT PRIMARY KEY,${scope}_id TEXT,env_key TEXT,stored_value TEXT,value_iv TEXT,is_secret INTEGER)`
    );
  }
  const encryptionKey = btoa('01234567890123456789012345678901');
  const cipher = await encrypt("synthetic-selected\n'$(exit 99)'", encryptionKey);
  sqlite
    .prepare('INSERT INTO project_runtime_env_vars VALUES(?,?,?,?,?,?)')
    .run('p-selected', 'project', 'SELECTED', 'invalid-overridden-cipher', 'iv', 1);
  sqlite
    .prepare('INSERT INTO profile_runtime_env_vars VALUES(?,?,?,?,?,?)')
    .run('profile-selected', 'profile', 'SELECTED', cipher.ciphertext, cipher.iv, 1);
  sqlite
    .prepare('INSERT INTO skill_runtime_env_vars VALUES(?,?,?,?,?,?)')
    .run('other', 'skill', 'OTHER', 'invalid-unselected-cipher', null, 1);
  sqlite
    .prepare('INSERT INTO project_runtime_env_vars VALUES(?,?,?,?,?,?)')
    .run('plain', 'project', 'PLAIN', 'nonsecret', null, 0);
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(pkcs8)))}\n-----END PRIVATE KEY-----`;
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => {
      const value = store.get(key);
      return value ? JSON.parse(value) : null;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
  const env = {
    DATABASE: createSqliteD1(sqlite),
    KV: kv,
    ENCRYPTION_KEY: encryptionKey,
    JWT_PRIVATE_KEY: pem,
    BASE_DOMAIN: 'synthetic.example',
  } as unknown as Env;
  const token: McpTokenData = {
    taskId: 'task',
    workspaceId: 'ws',
    agentSessionId: 'session',
    userId: 'user',
    projectId: 'project',
    createdAt: new Date().toISOString(),
  };
  boundary.fetch.mockImplementation(async (_node, _env, _url, options) => {
    const payload = JSON.parse(String(options.body));
    return new Response(
      JSON.stringify({
        jobId: payload.jobId,
        status: 'completed',
        stdout: '[REDACTED]',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        redacted: true,
        truncated: false,
        execution: {
          containerId: 'live-container',
          user: 'node',
          cwd: '/workspaces/repo',
          environmentMode: 'placeholder',
        },
      })
    );
  });
  return { env, token };
}

describe('HTTP MCP → real auth/D1/encryption → mock VM HTTP', () => {
  it('resolves only the winning selected row and sends every other secret as a placeholder', async () => {
    const { env, token } = await fixture();
    const response = await callMcp(
      1,
      {
        argv: ['printf', '%s', 'literal $HOME'],
        secretNames: ['SELECTED'],
        idempotencyKey: 'attempt',
        env: { PROBE: 'plain-override' },
      },
      token,
      env,
      'start'
    );
    expect(response.error).toBeUndefined();
    expect(boundary.fetch).toHaveBeenCalledOnce();
    const options = boundary.fetch.mock.calls[0]![3];
    const payload = JSON.parse(String(options.body));
    expect(boundary.fetch.mock.calls[0]![5]).toEqual({
      noWakeContainer: true,
      recoverContainerOnTimeout: false,
    });
    expect(boundary.fetch.mock.calls[0]![0]).toBe('node-1');
    expect(boundary.fetch.mock.calls[0]![2]).toContain('/workspaces/ws/mcp/secret-exec');
    expect(payload).toMatchObject({
      agentSessionId: 'session',
      argv: ['printf', '%s', 'literal $HOME'],
      env: { PROBE: 'plain-override' },
    });
    expect(payload.managedEnv).toEqual([
      { key: 'SELECTED', value: "synthetic-selected\n'$(exit 99)'", isSecret: true },
      { key: 'PLAIN', value: 'nonsecret', isSecret: false },
      { key: 'OTHER', value: '__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__OTHER__', isSecret: true },
    ]);
    expect(JSON.stringify(response)).not.toContain('synthetic-selected');
  });
  it.each([
    { agentSessionId: 'other-session' },
    { projectId: 'other-project' },
    { userId: 'other-user' },
  ])('denies wrong session/project/user before the private VM call', async (change) => {
    const { env, token } = await fixture();
    const response = await callMcp(
      1,
      { argv: ['true'], secretNames: ['SELECTED'] },
      { ...token, ...change },
      env,
      'start'
    );
    expect(response.error).toBeDefined();
    expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it('rejects unknown selected names without touching invalid unselected ciphertext', async () => {
    const { env, token } = await fixture();
    const response = await callMcp(
      1,
      { argv: ['true'], secretNames: ['MISSING'] },
      token,
      env,
      'start'
    );
    expect(response.error).toBeDefined();
    expect(boundary.fetch).not.toHaveBeenCalled();
  });
});

async function callMcp(
  id: number,
  args: Record<string, unknown>,
  token: McpTokenData,
  env: Env,
  operation: 'start' | 'status' | 'cancel'
): Promise<JsonRpcResponse> {
  await env.KV.put('mcp:synthetic-test-token', JSON.stringify(token));
  const tool =
    operation === 'start'
      ? 'exec_with_secrets'
      : operation === 'status'
        ? 'exec_with_secrets_status'
        : 'exec_with_secrets_cancel';
  const response = await mcpRoutes.request(
    '/',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    },
    env
  );
  return response.json();
}
