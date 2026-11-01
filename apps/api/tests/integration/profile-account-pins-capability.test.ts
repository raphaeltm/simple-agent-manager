/**
 * Capability: every place that picks an agent credential for a profile-pinned session
 * picks the same account.
 *
 *   (a) the agent-key callback (`POST /api/workspaces/:id/agent-key`, real route),
 *   (b) provider-limit admission (`holdTaskForProviderLimit`, real function),
 *   (c) the AI proxy passthrough (`verifyAIProxyAuth` + `resolveProxyUpstream`, the
 *       pair `prepareProxyRequest` runs).
 *
 * One real SQLite database with encrypted credentials, a default, a project pin and a
 * profile pin. Each site must choose the profile pin, and each falls back to the
 * project pin once the profile pin is removed (the control).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ workspace: 'w1', scope: 'workspace' })),
  signCallbackToken: vi.fn(),
}));
vi.mock('../../src/services/project-data', () => ({ persistMessage: vi.fn(async () => 'notice') }));

import * as schema from '../../src/db/schema';
import { holdTaskForProviderLimit } from '../../src/durable-objects/task-runner/provider-limit-admission';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { resolveProxyUpstream } from '../../src/routes/ai-proxy-passthrough';
import { runtimeRoutes } from '../../src/routes/workspaces/runtime';
import { verifyAIProxyAuth } from '../../src/services/ai-proxy-shared';
import { encrypt } from '../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NOW = '2026-11-01T00:00:00.000Z';
const SETTINGS = JSON.stringify({
  baseUrl: 'https://anthropic-alt.example/anthropic',
  dialect: 'anthropic',
});

let sqlite: Database.Database;
let env: Env;

async function seedAccount(id: string, token: string, settings = SETTINGS): Promise<void> {
  const { ciphertext, iv } = await encrypt(token, ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, 'u1', ?, 'api-key', ?, ?, 1, ?, ?)`
    )
    .run(`cred-${id}`, id, ciphertext, iv, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
       VALUES (?, 'u1', ?, 'agent', 'claude-code', ?, ?, 1, ?, ?)`
    )
    .run(`cfg-${id}`, id, `cred-${id}`, settings, NOW, NOW);
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1(sqlite),
    ENCRYPTION_KEY,
    BASE_DOMAIN: 'sammy.party',
    KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  } as unknown as Env;

  sqlite.exec(`
    INSERT INTO users (id, email, role, status) VALUES ('u1', 'u1@example.com', 'user', 'active');
    INSERT INTO projects (id, user_id, name, normalized_name, repository, default_branch, status, created_by, created_at, updated_at)
      VALUES ('p1', 'u1', 'P', 'p', 'acme/repo', 'main', 'active', 'u1', '${NOW}', '${NOW}');
    INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
      VALUES ('p1', 'u1', 'owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, created_at, updated_at)
      VALUES ('prof-1', 'p1', 'u1', 'Opus deep work', 'claude-code', '${NOW}', '${NOW}');
    INSERT INTO nodes (id, user_id, status) VALUES ('n1', 'u1', 'running');
    INSERT INTO workspaces (id, user_id, node_id, project_id, status)
      VALUES ('w1', 'u1', 'n1', 'p1', 'running');
    INSERT INTO tasks (id, project_id, user_id, workspace_id, status, agent_profile_hint)
      VALUES ('t1', 'p1', 'u1', 'w1', 'queued', 'prof-1');
    INSERT INTO agent_sessions (id, user_id, workspace_id, status, agent_type, agent_profile_id, agent_credential_generation)
      VALUES ('s1', 'u1', 'w1', 'running', 'claude-code', 'prof-1', 0);
  `);

  await seedAccount('default', 'sk-default');
  await seedAccount('project', 'sk-project');
  await seedAccount('pinned', 'sk-pinned');
  sqlite.exec(`
    INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active)
      VALUES ('att-default', 'cfg-default', 'agent', 'claude-code', 'u1', NULL, 1),
             ('att-project', 'cfg-project', 'agent', 'claude-code', 'u1', 'p1', 1);
    INSERT INTO cc_profile_attachments (id, configuration_id, user_id, agent_profile_id, consumer_kind, consumer_target, is_active)
      VALUES ('pin-1', 'cfg-pinned', 'u1', 'prof-1', 'agent', 'claude-code', 1);
  `);
});

afterEach(() => sqlite.close());

function unpinProfile(): void {
  sqlite.exec(`DELETE FROM cc_profile_attachments WHERE id = 'pin-1'`);
}

/** (a) The agent-key callback, through the real route. */
async function agentKey(): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: String(err) }, 500)
  );
  app.route('/api/workspaces', runtimeRoutes);
  const response = await app.request(
    '/api/workspaces/w1/agent-key',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-callback', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', agentSessionId: 's1' }),
    },
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** (b) Provider-limit admission: does a rejection on `reference` hold the task? */
async function admissionHolds(rejectedReference: string): Promise<boolean> {
  sqlite
    .prepare(
      `INSERT INTO credential_limit_windows (project_id, credential_reference, window_type, credential_source, provider, provider_mode, user_id, source, status, resets_at, observed_at, updated_at)
       VALUES ('p1', ?, 'anthropic.5h', 'user', 'anthropic', 'proxy-passthrough', 'u1', 'test', 'rejected', ?, ?, ?)`
    )
    .run(rejectedReference, Date.now() + 3_600_000, Date.now(), Date.now());
  const state = {
    taskId: 't1',
    projectId: 'p1',
    userId: 'u1',
    currentStep: 'node_selection',
    stepResults: { agentStarted: false },
    config: { agentType: 'claude-code', agentProfileHint: 'prof-1', chatSessionId: null },
  } as unknown as TaskRunnerState;
  const rc = {
    env,
    assertRecoveryAuthority: vi.fn(async () => {}),
    ctx: { storage: { setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) } },
  } as unknown as TaskRunnerContext;
  return holdTaskForProviderLimit(state, rc);
}

/** (c) The AI proxy: the session's auth, then the upstream it would forward to. */
async function proxyUpstream() {
  const auth = await verifyAIProxyAuth('wstoken', env, drizzle(env.DATABASE, { schema }));
  return resolveProxyUpstream({
    env,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    projectId: auth.projectId,
    agentType: auth.agentType,
    agentSessionId: auth.agentSessionId,
    dialect: 'anthropic',
  });
}

function sessionAttribution() {
  return sqlite
    .prepare(
      `SELECT agent_credential_source AS source, agent_credential_scope AS scope,
              agent_credential_reference AS reference
         FROM agent_sessions WHERE id = 's1'`
    )
    .get();
}

describe('a profile-pinned session runs on the pinned account everywhere', () => {
  it('(a) agent-key returns the pinned account and records the profile scope', async () => {
    const { status, body } = await agentKey();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      credentialReference: 'cc_credentials:cred-pinned',
      credentialSource: 'user',
      providerMode: 'proxy-passthrough',
    });
    expect(sessionAttribution()).toEqual({
      source: 'user',
      scope: 'profile',
      reference: 'cc_credentials:cred-pinned',
    });
  });

  it('(b) admission holds the task for a limit on the pinned account', async () => {
    expect(await admissionHolds('cc_credentials:cred-pinned')).toBe(true);
    expect(
      sqlite.prepare(`SELECT admission_state AS state FROM tasks WHERE id = 't1'`).get()
    ).toEqual({ state: 'provider_limit_waiting' });
  });

  it('(b) admission ignores a limit on the project-pinned account the run does not use', async () => {
    expect(await admissionHolds('cc_credentials:cred-project')).toBe(false);
  });

  it('(c) the AI proxy forwards with the pinned account', async () => {
    const upstream = await proxyUpstream();

    expect(upstream).toMatchObject({
      apiKey: 'sk-pinned',
      credentialReference: 'cc_credentials:cred-pinned',
      credentialScope: 'profile',
    });
  });

  it('all three fall back to the project pin once the profile pin is removed', async () => {
    unpinProfile();

    const { body } = await agentKey();
    expect(body).toMatchObject({ credentialReference: 'cc_credentials:cred-project' });
    expect(sessionAttribution()).toMatchObject({ scope: 'project' });
    expect(await proxyUpstream()).toMatchObject({
      apiKey: 'sk-project',
      credentialScope: 'project',
    });
    expect(await admissionHolds('cc_credentials:cred-project')).toBe(true);
  });
});

describe('a paused profile pin stops the run instead of switching accounts', () => {
  beforeEach(async () => {
    sqlite.exec(`UPDATE cc_credentials SET is_active = 0 WHERE id = 'cred-pinned'`);
    // A legacy user credential exists too: the pre-fix fallback would hand it out.
    const { ciphertext, iv } = await encrypt('sk-legacy', ENCRYPTION_KEY);
    sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, provider, credential_type, agent_type, credential_kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES ('legacy-1', 'u1', 'anthropic', 'agent-api-key', 'claude-code', 'api-key', ?, ?, 1, ?, ?)`
      )
      .run(ciphertext, iv, NOW, NOW);
  });

  it('agent-key returns no credential: not the project pin, the default, or the legacy key', async () => {
    const { status, body } = await agentKey();
    const text = JSON.stringify(body);

    expect(status).toBe(404);
    for (const secret of ['sk-project', 'sk-default', 'sk-legacy', 'sk-pinned']) {
      expect(text).not.toContain(secret);
    }
    expect(body).not.toHaveProperty('credentialReference');
  });

  it('the proxy finds no upstream and admission selects no credential', async () => {
    expect(await proxyUpstream()).toBeNull();
    expect(await admissionHolds('cc_credentials:cred-project')).toBe(false);
  });
});
