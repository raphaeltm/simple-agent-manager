import { AI_PROXY_BILLING_MODE_KV_KEY } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { aiProxyRoutes } from '../../src/routes/ai-proxy';
import { aiProxyAnthropicRoutes } from '../../src/routes/ai-proxy-anthropic';
import { aiProxyPassthroughRoutes } from '../../src/routes/ai-proxy-passthrough';
import { getSelectedAgentCredentialReference } from '../../src/routes/credentials';
import { taskCallbackRoute } from '../../src/routes/tasks/callback';
import { runtimeRoutes } from '../../src/routes/workspaces/runtime';
import { resolveUpstreamAuth } from '../../src/services/ai-billing';
import { encrypt } from '../../src/services/encryption';
import { newProviderLimitWait } from '../../src/services/provider-limit-policy';
import { rejectedProviderWindow } from '../../src/services/provider-limit-window';
import { queueWorkspaceSessionSleep } from '../../src/services/session-sleep';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ workspace: 'workspace-1', scope: 'workspace' })),
  signCallbackToken: vi.fn(),
}));
vi.mock('../../src/services/project-data', () => ({
  persistMessage: vi.fn(async () => 'notice'),
  createProjectSchedule: vi.fn(async () => ({ schedule: { id: 'fixture-schedule' } })),
}));
vi.mock('../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResourcesOrThrow: vi.fn(async () => {}),
}));
vi.mock('../../src/services/session-sleep', () => ({
  queueWorkspaceSessionSleep: vi.fn(async () => {}),
}));

const PLATFORM_SECRET = 'synthetic-platform-fixture-value';
describe('platform quota attribution at real credential and callback boundaries', () => {
  let sqlite: Database.Database;
  let env: Env;
  let mode: string;
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    mode = 'platform-key';
    const encryptionKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    env = {
      DATABASE: createSqliteD1(sqlite),
      ENCRYPTION_KEY: encryptionKey,
      BASE_DOMAIN: 'fixture.example',
      AI_PROXY_ENABLED: 'true',
      KV: {
        get: vi.fn(async (key: string) => (key === AI_PROXY_BILLING_MODE_KV_KEY ? mode : null)),
        put: vi.fn(async () => {}),
      },
    } as unknown as Env;
    const encrypted = await encrypt(PLATFORM_SECRET, encryptionKey);
    sqlite
      .prepare(
        "INSERT INTO platform_credentials(id,credential_type,agent_type,credential_kind,label,encrypted_token,iv,is_enabled,created_by)VALUES('platform-1','agent-api-key','claude-code','api-key','Fixture',?,?,1,'user-1')"
      )
      .run(encrypted.ciphertext, encrypted.iv);
    sqlite.exec(
      "INSERT INTO users(id,email,name,status)VALUES('user-1','fixture@example.test','Fixture','active');INSERT INTO projects(id,user_id,name,repository)VALUES('project-1','user-1','Fixture','fixture/repo');INSERT INTO nodes(id,user_id,status)VALUES('node-1','user-1','running');INSERT INTO workspaces(id,user_id,node_id,project_id,status)VALUES('workspace-1','user-1','node-1','project-1','running');INSERT INTO tasks(id,project_id,user_id,workspace_id,chat_session_id,status)VALUES('task-1','project-1','user-1','workspace-1','chat-1','delegated');INSERT INTO agent_sessions(id,user_id,workspace_id,status,agent_type,agent_credential_generation)VALUES('agent-1','user-1','workspace-1','running','claude-code',0);INSERT INTO agent_settings(id,user_id,agent_type,provider_mode)VALUES('settings-1','user-1','claude-code','sam');"
    );
  });
  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  async function seedOpenAIPlatform() {
    const encrypted = await encrypt(PLATFORM_SECRET, env.ENCRYPTION_KEY);
    sqlite
      .prepare(
        "INSERT INTO platform_credentials(id,credential_type,agent_type,credential_kind,label,encrypted_token,iv,is_enabled,created_by)VALUES('openai-platform','agent-api-key','codex','api-key','Fixture',?,?,1,'user-1')"
      )
      .run(encrypted.ciphertext, encrypted.iv);
  }
  function db() {
    return drizzle(env.DATABASE, { schema });
  }
  function selected() {
    return getSelectedAgentCredentialReference(
      db(),
      'user-1',
      'claude-code',
      env.ENCRYPTION_KEY,
      'project-1'
    );
  }
  async function request(path: string, body: object) {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode)
        : c.json({ error: 'fixture_error' }, 500)
    );
    app.route('/api/workspaces', runtimeRoutes);
    app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
    app.route('/ai/v1', aiProxyRoutes);
    app.route('/ai/proxy', aiProxyPassthroughRoutes);
    app.route('/api/projects', taskCallbackRoute);
    return app.request(
      path,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-fixture-callback',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} }
    );
  }
  function inject() {
    return request('/api/workspaces/workspace-1/agent-key', {
      agentType: 'claude-code',
      agentSessionId: 'agent-1',
    });
  }
  function hold(reference: string) {
    const wait = newProviderLimitWait({
      taskId: 'task-1',
      origin: 'admission',
      incidentId: 'admission:task-1',
      credentialKey: reference,
      previous: null,
      now: Date.now(),
      resetsAt: Date.now() + 60_000,
    });
    sqlite
      .prepare(
        "UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_waiting' WHERE id='task-1'"
      )
      .run(JSON.stringify({ ...wait, phase: 'released' }));
  }
  it.each(['platform-key', 'unified'])(
    'excludes %s platform limits from admission and startup pinning',
    async (billing) => {
      mode = billing;
      if (billing === 'unified') env.CF_AIG_TOKEN = 'synthetic-unified-fixture-value';
      const actual = await resolveUpstreamAuth(env, db());
      sqlite
        .prepare(
          "INSERT INTO credential_limit_windows(project_id,credential_reference,window_type,status,observed_at,updated_at,resets_at)VALUES('project-1',?,'api.requests','rejected',?,?,?)"
        )
        .run(actual.credentialReference, Date.now(), Date.now(), Date.now() + 60_000);
      expect(await selected()).toBeNull();
      expect(await rejectedProviderWindow(env, await selected())).toBeNull();
      hold('credentials:unrelated-old-personal');
      expect((await inject()).status).toBe(200);
      expect(
        sqlite.prepare("SELECT admission_state AS state FROM tasks WHERE id='task-1'").get()
      ).toEqual({ state: 'provider_limit_waiting' });
    }
  );
  it('does not park a platform callback even with a known reset', async () => {
    const injected = await (await inject()).json();
    const response = await request('/api/projects/project-1/tasks/task-1/status/callback', {
      toStatus: 'failed',
      errorMessage: 'provider_limit_reached',
      providerLimitResetsAt: Date.now() + 60_000,
      providerLimitAgentSessionId: 'agent-1',
      providerLimitCredentialGeneration: injected.credentialGeneration,
      providerLimitPromptAttemptId: 1,
    });
    expect(response.status).toBe(200);
    expect(
      sqlite
        .prepare(
          "SELECT admission_state AS state,provider_limit_wait_json AS wait,status FROM tasks WHERE id='task-1'"
        )
        .get()
    ).toEqual({ state: null, wait: null, status: 'failed' });
    expect(queueWorkspaceSessionSleep).not.toHaveBeenCalled();
  });
  it.each([
    '/ai/anthropic/v1/messages',
    '/ai/anthropic/v1/messages/count_tokens',
    '/ai/v1/chat/completions',
    '/ai/v1/responses',
  ])('does not read recovery pins or block platform proxy requests: %s', async (path) => {
    await seedOpenAIPlatform();
    hold('credentials:old-personal');
    const prepare = vi.spyOn(env.DATABASE, 'prepare');
    const outbound = vi.fn(
      async () => new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 })
    );
    vi.stubGlobal('fetch', outbound);
    const response = await request(path, {
      model: path.startsWith('/ai/v1/') ? 'gpt-5.5' : 'claude-sonnet-5',
      input: 'Fixture',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Fixture' }],
    });
    expect(response.status).toBe(200);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(
      prepare.mock.calls.filter(([sql]) => sql.includes('provider_limit_wait_json'))
    ).toHaveLength(0);
  });
  it.each(['task', 'conversation'])(
    'keeps a blocked %s current-source failure visible and queues canonical sleep',
    async (taskMode) => {
      sqlite.exec(
        "UPDATE agent_sessions SET agent_credential_reference='credentials:personal',agent_credential_source='user',agent_credential_generation=1"
      );
      const injected = { credentialGeneration: 1 };
      hold('credentials:personal');
      const raw = sqlite
        .prepare("SELECT provider_limit_wait_json AS wait FROM tasks WHERE id='task-1'")
        .get() as { wait: string };
      const wait = JSON.parse(raw.wait);
      sqlite
        .prepare(
          "UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked',admission_reason=? WHERE id='task-1'"
        )
        .run(
          JSON.stringify({
            ...wait,
            phase: 'blocked',
            reason: 'Blocked: selected provider credential changed; review before resuming.',
          }),
          'Blocked: selected provider credential changed; review before resuming.'
        );
      const response = await request('/api/projects/project-1/tasks/task-1/status/callback', {
        ...(taskMode === 'task' ? { toStatus: 'failed' } : { executionStep: 'awaiting_followup' }),
        errorMessage: 'agent_prompt_failed',
        providerLimitAgentSessionId: 'agent-1',
        providerLimitCredentialGeneration: injected.credentialGeneration,
        providerLimitPromptAttemptId: 1,
      });
      expect(response.status).toBe(200);
      expect(
        sqlite.prepare("SELECT admission_state AS state,status FROM tasks WHERE id='task-1'").get()
      ).toEqual({ state: 'provider_limit_blocked', status: 'delegated' });
      expect(queueWorkspaceSessionSleep).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ workspaceId: 'workspace-1', sleepAfterMs: 0 })
      );
    }
  );
  it.each([
    ['anthropic', 'claude-code', '/anthropic/v1/messages'],
    ['anthropic', 'claude-code', '/anthropic/v1/messages/count_tokens'],
    ['openai-compatible', 'openai-codex', '/openai/v1/chat/completions'],
  ])(
    'BYO %s %s %s uses ordinary passthrough without recovery pin queries',
    async (dialect, agentType, path) => {
      const encrypted = await encrypt('synthetic-byo-fixture-value', env.ENCRYPTION_KEY);
      sqlite
        .prepare(
          "INSERT INTO cc_credentials(id,owner_id,name,kind,encrypted_token,iv,is_active)VALUES('byo-current','user-1','Fixture','api-key',?,?,1)"
        )
        .run(encrypted.ciphertext, encrypted.iv);
      sqlite
        .prepare(
          "INSERT INTO cc_configurations(id,owner_id,name,consumer_kind,consumer_target,credential_id,settings_json,is_active)VALUES('byo-config','user-1','Fixture','agent',?,'byo-current',?,1)"
        )
        .run(agentType, JSON.stringify({ dialect, baseUrl: 'https://provider.example.test' }));
      sqlite
        .prepare(
          "INSERT INTO cc_attachments(id,configuration_id,consumer_kind,consumer_target,user_id,is_active)VALUES('byo-attachment','byo-config','agent',?,'user-1',1)"
        )
        .run(agentType);
      sqlite.prepare('UPDATE agent_sessions SET agent_type=?').run(agentType);
      const outbound = vi.fn(
        async () => new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 })
      );
      vi.stubGlobal('fetch', outbound);
      hold('cc_credentials:byo-current');
      const body = {
        model: agentType === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Fixture' }],
      };
      const matching = await request('/ai/proxy/fixture-token' + path, body);
      expect(await matching.json()).toMatchObject({ input_tokens: 10 });
      expect(matching.status).toBe(200);
      expect(outbound).toHaveBeenCalledTimes(1);
      outbound.mockClear();
      hold('cc_credentials:byo-original');
      const prepare = vi.spyOn(env.DATABASE, 'prepare');
      const changed = await request('/ai/proxy/fixture-token' + path, body);
      expect(changed.status).toBe(200);
      expect(outbound).toHaveBeenCalledTimes(1);
      expect(
        prepare.mock.calls.filter(([sql]) => sql.includes('provider_limit_wait_json'))
      ).toHaveLength(0);
    }
  );
  it.each(['disabled', 'native'])(
    'does not admit platform proxy identity when %s',
    async (condition) => {
      if (condition === 'disabled') env.AI_PROXY_ENABLED = 'false';
      else sqlite.exec("UPDATE agent_settings SET provider_mode='native'");
      expect(await selected()).toBeNull();
    }
  );
  it('personal OAuth keeps precedence over a platform proxy credential', async () => {
    const encrypted = await encrypt('synthetic-personal-oauth-fixture', env.ENCRYPTION_KEY);
    sqlite
      .prepare(
        "INSERT INTO credentials(id,user_id,credential_type,provider,agent_type,credential_kind,encrypted_token,iv,is_active)VALUES('personal-oauth','user-1','agent-api-key','anthropic','claude-code','oauth-token',?,?,1)"
      )
      .run(encrypted.ciphertext, encrypted.iv);
    expect(await selected()).toBe('credentials:personal-oauth');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM cc_credentials').get()).toEqual({
      count: 0,
    });
  });
});
