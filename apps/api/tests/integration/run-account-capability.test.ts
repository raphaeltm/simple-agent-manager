/**
 * Capability: an account chosen for one run (`tasks.agent_configuration_id`) is the
 * account every credential site uses for that run, over the profile pin.
 *
 *   (a) the agent-key callback (`POST /api/workspaces/:id/agent-key`, real route),
 *   (b) provider-limit admission (`holdTaskForProviderLimit`, real function),
 *   (c) the AI proxy passthrough (`verifyAIProxyAuth` + `resolveProxyUpstream`),
 *   (d) credential write-back (`resolveRunAgentCredentialReferences`).
 *
 * An unusable choice (paused, another person's, for another agent) stops the run; it
 * never falls back to the profile pin, the project pin or the default. A task with no
 * choice resolves exactly as before (the control).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ workspace: 'w1', scope: 'workspace' })),
  signCallbackToken: vi.fn(),
  signCurrentWorkspaceCallbackToken: vi.fn(),
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
import { resolveRunAgentCredentialReferences } from '../../src/services/run-agent-credential';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NOW = '2026-11-01T00:00:00.000Z';
const SETTINGS = JSON.stringify({
  baseUrl: 'https://anthropic-alt.example/anthropic',
  dialect: 'anthropic',
});

let sqlite: Database.Database;
let env: Env;

async function seedAccount(
  id: string,
  token: string,
  settings = SETTINGS,
  owner = 'u1',
  agentType = 'claude-code'
): Promise<void> {
  const { ciphertext, iv } = await encrypt(token, ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'api-key', ?, ?, 1, ?, ?)`
    )
    .run(`cred-${id}`, owner, id, ciphertext, iv, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?, 1, ?, ?)`
    )
    .run(`cfg-${id}`, owner, id, agentType, `cred-${id}`, settings, NOW, NOW);
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
    INSERT INTO users (id, email, role, status) VALUES ('u2', 'u2@example.com', 'user', 'active');
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
  await seedAccount('chosen', 'sk-chosen');
  sqlite.exec(`
    INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active)
      VALUES ('att-default', 'cfg-default', 'agent', 'claude-code', 'u1', NULL, 1),
             ('att-project', 'cfg-project', 'agent', 'claude-code', 'u1', 'p1', 1);
    INSERT INTO cc_profile_attachments (id, configuration_id, user_id, agent_profile_id, consumer_kind, consumer_target, is_active)
      VALUES ('pin-1', 'cfg-pinned', 'u1', 'prof-1', 'agent', 'claude-code', 1);
  `);
});

afterEach(() => sqlite.close());

/** (a) The agent-key callback, through the real route. */
async function agentKey(
  agentSessionId: string | null = 's1'
): Promise<{ status: number; body: Record<string, unknown> }> {
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
      body: JSON.stringify({
        agentType: 'claude-code',
        ...(agentSessionId ? { agentSessionId } : {}),
      }),
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

/** (c) The AI proxy: the session's auth, then the upstream it would forward to (as `prepareProxyRequest` wires it). */
async function proxyUpstream() {
  const auth = await verifyAIProxyAuth('wstoken', env, drizzle(env.DATABASE, { schema }));
  return resolveProxyUpstream({
    env,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    projectId: auth.projectId,
    agentType: auth.agentType,
    agentSessionId: auth.agentSessionId,
    runtimeRows: auth.runtimeRows,
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

function chooseForRun(configurationId: string | null): void {
  sqlite
    .prepare(`UPDATE tasks SET agent_configuration_id = ? WHERE id = 't1'`)
    .run(configurationId);
}

async function writeBackReferences(): Promise<string[]> {
  return resolveRunAgentCredentialReferences(
    drizzle(env.DATABASE, { schema }),
    env.DATABASE,
    ENCRYPTION_KEY,
    { workspaceId: 'w1', userId: 'u1', projectId: 'p1', agentType: 'claude-code' }
  );
}

describe('a run account is used over the profile pin everywhere', () => {
  beforeEach(() => chooseForRun('cfg-chosen'));

  it('(a) agent-key returns the chosen account and records the run scope', async () => {
    const { status, body } = await agentKey();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      credentialReference: 'cc_credentials:cred-chosen',
      credentialSource: 'user',
    });
    expect(sessionAttribution()).toEqual({
      source: 'user',
      scope: 'run',
      reference: 'cc_credentials:cred-chosen',
    });
  });

  it('(a) the choice applies with no running session too (task path)', async () => {
    sqlite.exec(`UPDATE agent_sessions SET status = 'stopped' WHERE id = 's1'`);
    const { body } = await agentKey(null);
    expect(body).toMatchObject({ credentialReference: 'cc_credentials:cred-chosen' });
  });

  it('(b) admission holds for a limit on the chosen account', async () => {
    expect(await admissionHolds('cc_credentials:cred-chosen')).toBe(true);
  });

  it('(b) admission ignores a limit on the profile-pinned account the run no longer uses', async () => {
    expect(await admissionHolds('cc_credentials:cred-pinned')).toBe(false);
  });

  it('(c) the AI proxy forwards with the chosen account', async () => {
    expect(await proxyUpstream()).toMatchObject({
      apiKey: 'sk-chosen',
      credentialReference: 'cc_credentials:cred-chosen',
      credentialScope: 'run',
    });
  });

  it('(d) write-back targets the chosen account the run was seeded with', async () => {
    await agentKey();
    expect(await writeBackReferences()).toEqual(['cc_credentials:cred-chosen']);
  });

  it('(d) before any session recorded it, write-back still selects the chosen account', async () => {
    sqlite.exec(`UPDATE agent_sessions SET agent_credential_reference = NULL WHERE id = 's1'`);
    expect(await writeBackReferences()).toEqual(['cc_credentials:cred-chosen']);
  });
});

describe('control: a run without a choice resolves as before', () => {
  it('uses the profile pin at every site', async () => {
    chooseForRun(null);
    const { body } = await agentKey();
    expect(body).toMatchObject({ credentialReference: 'cc_credentials:cred-pinned' });
    expect(sessionAttribution()).toMatchObject({ scope: 'profile' });
    expect(await proxyUpstream()).toMatchObject({ credentialScope: 'profile' });
    expect(await admissionHolds('cc_credentials:cred-pinned')).toBe(true);
  });
});

describe('an unusable run account stops the run instead of switching accounts', () => {
  async function expectStopped(): Promise<void> {
    const { status, body } = await agentKey();
    const text = JSON.stringify(body);
    expect(status).toBe(404);
    for (const secret of ['sk-chosen', 'sk-pinned', 'sk-project', 'sk-default', 'sk-theirs']) {
      expect(text).not.toContain(secret);
    }
    expect(await proxyUpstream()).toBeNull();
    // Admission selects no credential, so a limit on the profile pin does not hold it.
    expect(await admissionHolds('cc_credentials:cred-pinned')).toBe(false);
  }

  it('a paused account', async () => {
    chooseForRun('cfg-chosen');
    sqlite.exec(`UPDATE cc_credentials SET is_active = 0 WHERE id = 'cred-chosen'`);
    await expectStopped();
  });

  it('a paused configuration', async () => {
    chooseForRun('cfg-chosen');
    sqlite.exec(`UPDATE cc_configurations SET is_active = 0 WHERE id = 'cfg-chosen'`);
    await expectStopped();
  });

  it('another person’s account id', async () => {
    await seedAccount('theirs', 'sk-theirs', SETTINGS, 'u2');
    chooseForRun('cfg-theirs');
    await expectStopped();
  });

  it('an account for another agent', async () => {
    await seedAccount('codex', 'sk-codex', SETTINGS, 'u1', 'openai-codex');
    chooseForRun('cfg-codex');
    await expectStopped();
  });

  it('a deleted account', async () => {
    chooseForRun('cfg-gone');
    await expectStopped();
  });
});
