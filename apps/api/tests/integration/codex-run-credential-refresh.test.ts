/**
 * Capability: a Codex run refreshes, and syncs into, exactly the account it was
 * seeded with — profile pin, project pin, user default or legacy row — and never
 * the user's default by assumption.
 *
 * Real path, one real SQLite database with encrypted credentials:
 *   1. `POST /api/workspaces/:id/agent-key` (real route) seeds the run and records
 *      `agent_sessions.agent_credential_reference`;
 *   2. `POST /api/auth/codex-refresh` (real route) resolves the run's credentials and
 *      forwards to a real `CodexRefreshLock`, which calls a faked OpenAI;
 *   3. `POST /api/workspaces/:id/agent-credential-sync` (real route).
 *
 * Every attack case has an owner-path control (rule 28).
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ workspace: 'w1', scope: 'workspace' })),
  signCallbackToken: vi.fn(),
}));
vi.mock('../../src/services/project-data', () => ({ persistMessage: vi.fn(async () => 'notice') }));

import * as schema from '../../src/db/schema';
import { CodexRefreshLock } from '../../src/durable-objects/codex-refresh-lock';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { codexRefreshRoutes } from '../../src/routes/codex-refresh';
import { agentCredentialSyncRoutes } from '../../src/routes/workspaces/agent-credential-sync';
import { runtimeRoutes } from '../../src/routes/workspaces/runtime';
import { decrypt, encrypt } from '../../src/services/encryption';
import { verifyCallbackToken } from '../../src/services/jwt';
import { RUN_CREDENTIAL_CANDIDATE_LIMIT } from '../../src/services/run-agent-credential';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NOW = '2026-11-08T00:00:00.000Z';
const CODEX = 'openai-codex';

let sqlite: Database.Database;
let env: Env;
let upstreamRefreshTokens: string[];
let doRequestBodies: Array<Record<string, unknown>>;
/** Runs once just before the next D1 batch (the credential write), to stage a race. */
let beforeNextBatch: (() => void) | null;

const codexAuth = (who: string, generation = 1) =>
  JSON.stringify({
    tokens: {
      access_token: `${who}-access-${generation}`,
      refresh_token: `${who}-refresh-${generation}`,
      id_token: `${who}-id-${generation}`,
      account_id: `acct-${who}`,
    },
  });

/** A Codex auth.json account as cc_* rows (credential + configuration). */
async function seedCcAccount(who: string, owner = 'u1'): Promise<void> {
  const { ciphertext, iv } = await encrypt(codexAuth(who), ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'auth-json', ?, ?, 1, ?, ?)`
    )
    .run(`cred-${who}`, owner, who, ciphertext, iv, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', ?, ?, 1, ?, ?)`
    )
    .run(`cfg-${who}`, owner, who, CODEX, `cred-${who}`, NOW, NOW);
}

async function seedLegacyAccount(
  id: string,
  who: string,
  opts: { projectId?: string | null; active?: boolean } = {}
): Promise<void> {
  const { ciphertext, iv } = await encrypt(codexAuth(who), ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, agent_type,
         credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, 'u1', ?, ?, 'agent-api-key', ?, 'oauth-token', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      opts.projectId ?? null,
      CODEX,
      CODEX,
      opts.active === false ? 0 : 1,
      ciphertext,
      iv,
      NOW,
      NOW
    );
}

function attachDefault(who: string): void {
  sqlite.exec(`INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active)
    VALUES ('att-default', 'cfg-${who}', 'agent', '${CODEX}', 'u1', NULL, 1)`);
}
function pinProject(who: string, active = true): void {
  sqlite.exec(`INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active)
    VALUES ('att-project', 'cfg-${who}', 'agent', '${CODEX}', 'u1', 'p1', ${active ? 1 : 0})`);
}
function pinProfile(who: string, active = true): void {
  sqlite.exec(`INSERT INTO cc_profile_attachments (id, configuration_id, user_id, agent_profile_id, consumer_kind, consumer_target, is_active)
    VALUES ('pin-profile', 'cfg-${who}', 'u1', 'prof-1', 'agent', '${CODEX}', ${active ? 1 : 0})`);
}

async function secret(table: 'cc_credentials' | 'credentials', id: string): Promise<string> {
  const row = sqlite
    .prepare(`SELECT encrypted_token AS t, iv FROM ${table} WHERE id = ?`)
    .get(id) as {
    t: string;
    iv: string;
  };
  return decrypt(row.t, row.iv, ENCRYPTION_KEY);
}

const refreshTokenOf = async (table: 'cc_credentials' | 'credentials', id: string) =>
  JSON.parse(await secret(table, id)).tokens.refresh_token as string;

function app(): Hono<{ Bindings: Env }> {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: String(err) }, 500)
  );
  hono.route('/api/workspaces', runtimeRoutes);
  hono.route('/api/workspaces', agentCredentialSyncRoutes);
  hono.route('/api/auth', codexRefreshRoutes);
  return hono;
}

async function agentKey(workspaceId = 'w1', agentSessionId = 's1') {
  vi.mocked(verifyCallbackToken).mockResolvedValueOnce({
    workspace: workspaceId,
    scope: 'workspace',
  } as never);
  const response = await app().request(
    `/api/workspaces/${workspaceId}/agent-key`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer cb', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: CODEX, agentSessionId }),
    },
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function refresh(refreshToken: string, workspaceId = 'w1') {
  vi.mocked(verifyCallbackToken).mockResolvedValueOnce({
    workspace: workspaceId,
    scope: 'workspace',
  } as never);
  const response = await app().request(
    `/api/auth/codex-refresh?token=cb`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    },
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function sync(credential: string, workspaceId = 'w1') {
  vi.mocked(verifyCallbackToken).mockResolvedValueOnce({
    workspace: workspaceId,
    scope: 'workspace',
  } as never);
  const response = await app().request(
    `/api/workspaces/${workspaceId}/agent-credential-sync`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer cb', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: CODEX, credentialKind: 'oauth-token', credential }),
    },
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  upstreamRefreshTokens = [];
  doRequestBodies = [];
  beforeNextBatch = null;
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
    },
  };
  const d1 = createSqliteD1(sqlite);
  const database = new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const hook = beforeNextBatch;
          beforeNextBatch = null;
          hook?.();
          return target.batch(statements);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const base = {
    DATABASE: database,
    ENCRYPTION_KEY,
    BASE_DOMAIN: 'sammy.party',
    CODEX_EXPECTED_SCOPES: '',
    KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  };
  // One lock instance per user, as `idFromName(userId)` gives in production.
  const locks = new Map<string, CodexRefreshLock>();
  env = {
    ...base,
    CODEX_REFRESH_LOCK: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!locks.has(name)) locks.set(name, new CodexRefreshLock(ctx as never, base as never));
        return {
          fetch: async (request: Request) => {
            doRequestBodies.push((await request.clone().json()) as Record<string, unknown>);
            return locks.get(name)!.fetch(request);
          },
        };
      },
    },
  } as unknown as Env;

  // OpenAI: rotate whatever account presented the token, to that account's next generation.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const presented = JSON.parse(String(init?.body)).refresh_token as string;
      upstreamRefreshTokens.push(presented);
      const who = presented.replace(/-refresh-\d+$/, '');
      return new Response(
        JSON.stringify({
          access_token: `${who}-access-2`,
          refresh_token: `${who}-refresh-2`,
          id_token: `${who}-id-2`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    })
  );

  sqlite.exec(`
    INSERT INTO users (id, email, role, status) VALUES ('u1', 'u1@example.com', 'user', 'active'),
      ('u2', 'u2@example.com', 'user', 'active');
    INSERT INTO projects (id, user_id, name, normalized_name, repository, default_branch, status, created_by, created_at, updated_at)
      VALUES ('p1', 'u1', 'P', 'p', 'acme/repo', 'main', 'active', 'u1', '${NOW}', '${NOW}');
    INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
      VALUES ('p1', 'u1', 'owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, created_at, updated_at)
      VALUES ('prof-1', 'p1', 'u1', 'Codex deep work', '${CODEX}', '${NOW}', '${NOW}');
    INSERT INTO nodes (id, user_id, status) VALUES ('n1', 'u1', 'running'), ('n2', 'u2', 'running');
    INSERT INTO workspaces (id, user_id, node_id, project_id, status)
      VALUES ('w1', 'u1', 'n1', 'p1', 'running'), ('w2', 'u2', 'n2', NULL, 'running');
    INSERT INTO tasks (id, project_id, user_id, workspace_id, status, agent_profile_hint)
      VALUES ('t1', 'p1', 'u1', 'w1', 'in_progress', 'prof-1');
    INSERT INTO agent_sessions (id, user_id, workspace_id, status, agent_type, agent_profile_id, agent_credential_generation)
      VALUES ('s1', 'u1', 'w1', 'running', '${CODEX}', 'prof-1', 0),
             ('s2', 'u2', 'w2', 'running', '${CODEX}', NULL, 0);
  `);
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

describe('a Codex run refreshes the account it was seeded with', () => {
  beforeEach(async () => {
    await seedCcAccount('default');
    await seedCcAccount('project');
    await seedCcAccount('profile');
    attachDefault('default');
  });

  it('profile pin: the pinned account rotates and the default is untouched', async () => {
    pinProject('project');
    pinProfile('profile');
    expect((await agentKey()).body.credentialReference).toBe('cc_credentials:cred-profile');

    const res = await refresh('profile-refresh-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      access_token: 'profile-access-2',
      refresh_token: 'profile-refresh-2',
    });
    expect(upstreamRefreshTokens).toEqual(['profile-refresh-1']);
    expect(await refreshTokenOf('cc_credentials', 'cred-profile')).toBe('profile-refresh-2');
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
    expect(await secret('cc_credentials', 'cred-project')).toBe(codexAuth('project'));
  });

  it('project pin (no legacy project row): the pinned account rotates, the default is untouched', async () => {
    pinProject('project');
    expect((await agentKey()).body.credentialReference).toBe('cc_credentials:cred-project');

    const res = await refresh('project-refresh-1');

    expect(res.status).toBe(200);
    expect(await refreshTokenOf('cc_credentials', 'cred-project')).toBe('project-refresh-2');
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('attack: a pinned run presenting a token it does not hold never receives the default account', async () => {
    pinProject('project');
    await agentKey();

    const res = await refresh('unknown-refresh');

    expect(res.body).toEqual({
      access_token: 'project-access-1',
      id_token: 'project-id-1',
      stale: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('default');
    expect(upstreamRefreshTokens).toEqual([]);
  });

  it('control: an unpinned run refreshes the user default', async () => {
    expect((await agentKey()).body.credentialReference).toBe('cc_credentials:cred-default');

    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(200);
    expect(await refreshTokenOf('cc_credentials', 'cred-default')).toBe('default-refresh-2');
  });

  it.each([
    { tier: 'profile', pin: () => pinProfile('profile', false) },
    { tier: 'project', pin: () => pinProject('project', false) },
  ])('an inactive $tier pin blocks fallback to the default', async ({ pin }) => {
    pin();
    await agentKey(); // halts: records nothing

    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(401);
    expect(upstreamRefreshTokens).toEqual([]);
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('a session without a recorded reference resolves through the same resolver (profile pin)', async () => {
    pinProject('project');
    pinProfile('profile');

    const res = await refresh('profile-refresh-1'); // no agent-key call: nothing recorded

    expect(res.status).toBe(200);
    expect(await refreshTokenOf('cc_credentials', 'cred-profile')).toBe('profile-refresh-2');
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('keeps refreshing the seeded account after the user re-pins mid-run', async () => {
    pinProject('project');
    await agentKey();
    sqlite.exec(
      `UPDATE cc_attachments SET configuration_id = 'cfg-default' WHERE id = 'att-project'`
    );

    const res = await refresh('project-refresh-1');

    expect(res.status).toBe(200);
    expect(await refreshTokenOf('cc_credentials', 'cred-project')).toBe('project-refresh-2');
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('attack: a forged reference to another user’s credential is refused; owner control succeeds', async () => {
    sqlite.exec(`UPDATE agent_sessions SET agent_credential_reference = 'cc_credentials:cred-profile',
      agent_credential_source = 'user' WHERE id IN ('s1', 's2')`);

    const attack = await refresh('profile-refresh-1', 'w2');
    expect(attack.status).toBe(401);
    expect(upstreamRefreshTokens).toEqual([]);

    const owner = await refresh('profile-refresh-1', 'w1');
    expect(owner.status).toBe(200);
    expect(upstreamRefreshTokens).toEqual(['profile-refresh-1']);
  });
});

describe('which recorded references are candidates', () => {
  beforeEach(async () => {
    await seedCcAccount('default');
    await seedCcAccount('project');
    await seedCcAccount('profile');
    attachDefault('default');
  });

  function record(sessionId: string, reference: string, updatedAt: string, source = 'user') {
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, user_id, workspace_id, status, agent_type, agent_credential_source,
           agent_credential_reference, agent_credential_generation, updated_at)
         VALUES (?, 'u1', 'w1', 'stopped', ?, ?, ?, 1, ?)`
      )
      .run(sessionId, CODEX, source, reference, updatedAt);
  }

  it('several sessions: deduplicated, most recently used first, chosen by possession', async () => {
    record('s-old', 'cc_credentials:cred-project', '2026-11-07T00:00:00.000Z');
    record('s-new', 'cc_credentials:cred-profile', '2026-11-08T00:00:00.000Z');
    record('s-new2', 'cc_credentials:cred-profile', '2026-11-08T01:00:00.000Z');

    const res = await refresh('project-refresh-1');

    expect(doRequestBodies[0]?.credentialReferences).toEqual([
      'cc_credentials:cred-profile',
      'cc_credentials:cred-project',
    ]);
    expect(res.status).toBe(200);
    expect(await refreshTokenOf('cc_credentials', 'cred-project')).toBe('project-refresh-2');
    expect(await secret('cc_credentials', 'cred-profile')).toBe(codexAuth('profile'));
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('several sessions and no proof of possession: nothing is handed out', async () => {
    record('s-old', 'cc_credentials:cred-project', '2026-11-07T00:00:00.000Z');
    record('s-new', 'cc_credentials:cred-profile', '2026-11-08T00:00:00.000Z');

    const res = await refresh('unknown-refresh');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'refresh_token_invalidated' });
  });

  it('caps the candidates at the most recently used, dropping only the oldest', async () => {
    for (let n = 0; n <= RUN_CREDENTIAL_CANDIDATE_LIMIT; n++) {
      const minute = String(n).padStart(2, '0');
      record(`s-${n}`, `cc_credentials:cred-gone-${n}`, `2026-11-08T00:${minute}:00.000Z`);
    }

    await refresh('profile-refresh-1');

    const refs = doRequestBodies[0]?.credentialReferences as string[];
    expect(refs).toHaveLength(RUN_CREDENTIAL_CANDIDATE_LIMIT);
    expect(refs[0]).toBe(`cc_credentials:cred-gone-${RUN_CREDENTIAL_CANDIDATE_LIMIT}`);
    expect(refs).not.toContain('cc_credentials:cred-gone-0');
  });

  it('a recorded legacy reference is honoured', async () => {
    await seedLegacyAccount('leg-pinned', 'legacy');
    record('s-legacy', 'credentials:leg-pinned', '2026-11-08T00:00:00.000Z');

    const res = await refresh('legacy-refresh-1');

    expect(res.status).toBe(200);
    expect(await refreshTokenOf('credentials', 'leg-pinned')).toBe('legacy-refresh-2');
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('a platform-seeded run never falls back to a personal default configured later', async () => {
    record('s-platform', 'platform_proxy:openai', '2026-11-08T00:00:00.000Z', 'platform');

    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(401);
    expect(doRequestBodies).toEqual([]);
    expect(upstreamRefreshTokens).toEqual([]);
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('a platform-sourced recording is not a candidate even if it names a user credential', async () => {
    record('s-platform', 'cc_credentials:cred-profile', '2026-11-08T00:00:00.000Z', 'platform');

    const res = await refresh('profile-refresh-1');

    expect(res.status).toBe(401);
    expect(upstreamRefreshTokens).toEqual([]);
    expect(await secret('cc_credentials', 'cred-profile')).toBe(codexAuth('profile'));
  });

  it('control: no recorded attribution at all falls back to the resolver (user default)', async () => {
    const res = await refresh('default-refresh-1');

    expect(doRequestBodies[0]?.credentialReferences).toEqual(['cc_credentials:cred-default']);
    expect(res.status).toBe(200);
  });

  it('a live session’s credential ranks ahead of newer references from ended sessions', async () => {
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, user_id, workspace_id, status, agent_type, agent_credential_source,
           agent_credential_reference, agent_credential_generation, updated_at)
         VALUES ('s-live', 'u1', 'w1', 'running', ?, 'user', 'cc_credentials:cred-project', 1, '2026-11-01T00:00:00.000Z')`
      )
      .run(CODEX);
    record('s-ended', 'cc_credentials:cred-profile', '2026-11-08T00:00:00.000Z');

    await refresh('project-refresh-1');

    expect(doRequestBodies[0]?.credentialReferences).toEqual([
      'cc_credentials:cred-project',
      'cc_credentials:cred-profile',
    ]);
  });

  it('a malformed recorded reference is skipped, and a valid one still refreshes', async () => {
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, user_id, workspace_id, status, agent_type, agent_credential_source,
           agent_credential_reference, agent_credential_generation, updated_at)
         VALUES ('s-blob', 'u1', 'w1', 'stopped', ?, 'user', X'00ff', 1, '2026-11-08T01:00:00.000Z')`
      )
      .run(CODEX);
    record('s-ok', 'cc_credentials:cred-project', '2026-11-08T00:00:00.000Z');

    const res = await refresh('project-refresh-1');

    expect(res.status).toBe(200);
    expect(doRequestBodies[0]?.credentialReferences).toEqual(['cc_credentials:cred-project']);
  });
});

describe('workspace lifecycle', () => {
  beforeEach(async () => {
    await seedCcAccount('default');
    attachDefault('default');
  });

  it.each([
    {
      name: 'a stopped workspace',
      sql: `UPDATE workspaces SET status = 'stopped' WHERE id = 'w1'`,
    },
    { name: 'a deleted node', sql: `UPDATE nodes SET status = 'deleted' WHERE id = 'n1'` },
  ])('refuses a refresh from $name (410) and rotates nothing', async ({ sql }) => {
    sqlite.exec(sql);

    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(410);
    expect(upstreamRefreshTokens).toEqual([]);
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('control: the same workspace while running refreshes', async () => {
    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(200);
    expect(upstreamRefreshTokens).toEqual(['default-refresh-1']);
  });
});

describe('legacy-only users', () => {
  it('a legacy project row is refreshed in place (no cc data, nothing recorded)', async () => {
    await seedLegacyAccount('leg-user', 'default');
    await seedLegacyAccount('leg-project', 'project', { projectId: 'p1' });

    const res = await refresh('project-refresh-1');

    expect(res.status).toBe(200);
    expect(await refreshTokenOf('credentials', 'leg-project')).toBe('project-refresh-2');
    expect(await secret('credentials', 'leg-user')).toBe(codexAuth('default'));
  });

  it('an inactive legacy project row blocks fallback to the legacy user row', async () => {
    await seedLegacyAccount('leg-user', 'default');
    await seedLegacyAccount('leg-project', 'project', { projectId: 'p1', active: false });

    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(401);
    expect(await secret('credentials', 'leg-user')).toBe(codexAuth('default'));
  });

  it('no project row falls back to the legacy user row', async () => {
    await seedLegacyAccount('leg-user', 'default');

    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(200);
    expect(await refreshTokenOf('credentials', 'leg-user')).toBe('default-refresh-2');
  });

  it('no credential at all is a 401', async () => {
    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(401);
    expect(upstreamRefreshTokens).toEqual([]);
  });

  it('after agent-key backfills cc, the rotation lands in both stores', async () => {
    await seedLegacyAccount('leg-user', 'default');
    const key = await agentKey();
    expect(String(key.body.credentialReference)).toMatch(/^cc_credentials:/);

    const res = await refresh('default-refresh-1');

    expect(res.status).toBe(200);
    const ccId = String(key.body.credentialReference).slice('cc_credentials:'.length);
    expect(await refreshTokenOf('cc_credentials', ccId)).toBe('default-refresh-2');
    expect(await secret('credentials', 'leg-user')).toBe(await secret('cc_credentials', ccId));
  });
});

describe('agent-credential-sync writes into the seeded account', () => {
  beforeEach(async () => {
    await seedCcAccount('default');
    await seedCcAccount('project');
    attachDefault('default');
    pinProject('project');
    await agentKey();
  });

  it('a pinned run syncs into the pinned account; the default is untouched', async () => {
    const res = await sync(codexAuth('project', 3));

    expect(res.body).toEqual({ success: true, updated: true });
    expect(await secret('cc_credentials', 'cred-project')).toBe(codexAuth('project', 3));
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('attack: an auth.json of another account is refused; nothing is written', async () => {
    const res = await sync(codexAuth('default', 3));

    expect(res.body).toEqual({ success: false, reason: 'credential_account_mismatch' });
    expect(await secret('cc_credentials', 'cred-project')).toBe(codexAuth('project'));
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it.each([
    { name: 'not JSON', body: 'not-json{' },
    { name: 'without an account id', body: JSON.stringify({ tokens: { refresh_token: 'x' } }) },
  ])('an auth.json $name is refused; the pinned credential is untouched', async ({ body }) => {
    const res = await sync(body);

    expect(res.body.success).toBe(false);
    expect(await secret('cc_credentials', 'cred-project')).toBe(codexAuth('project'));
  });

  it('an unchanged auth.json is a no-op', async () => {
    expect((await sync(codexAuth('project'))).body).toEqual({ success: true, updated: false });
  });

  it('the workspace moving between read and write: nothing is written (410)', async () => {
    beforeNextBatch = () => sqlite.exec(`UPDATE workspaces SET status = 'stopped' WHERE id = 'w1'`);

    const res = await sync(codexAuth('project', 3));

    expect(res.status).toBe(410);
    expect(await secret('cc_credentials', 'cred-project')).toBe(codexAuth('project'));
  });

  it('the credential rotating between read and write: credential_changed, nothing overwritten', async () => {
    const rotated = await encrypt(codexAuth('project', 2), ENCRYPTION_KEY);
    beforeNextBatch = () =>
      sqlite
        .prepare(`UPDATE cc_credentials SET encrypted_token = ?, iv = ? WHERE id = 'cred-project'`)
        .run(rotated.ciphertext, rotated.iv);

    const res = await sync(codexAuth('project', 3));

    expect(res.body).toEqual({ success: false, reason: 'credential_changed' });
    expect(await secret('cc_credentials', 'cred-project')).toBe(codexAuth('project', 2));
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });

  it('attack: a forged reference to another user’s credential is not written; owner control is', async () => {
    await seedCcAccount('victim', 'u2');
    sqlite.exec(`INSERT INTO workspaces (id, user_id, node_id, project_id, status)
      VALUES ('w3', 'u1', 'n1', NULL, 'running')`);
    sqlite.exec(`INSERT INTO agent_sessions (id, user_id, workspace_id, status, agent_type,
      agent_credential_source, agent_credential_reference, agent_credential_generation)
      VALUES ('s3', 'u1', 'w3', 'running', '${CODEX}', 'user', 'cc_credentials:cred-victim', 1)`);

    const attack = await sync(codexAuth('victim', 3), 'w3');
    expect(attack.body.success).toBe(false);
    expect(await secret('cc_credentials', 'cred-victim')).toBe(codexAuth('victim'));

    const owner = await sync(codexAuth('project', 3), 'w1');
    expect(owner.body).toEqual({ success: true, updated: true });
  });

  it('an inactive pinned credential is not replaced by the default', async () => {
    sqlite.exec(`UPDATE cc_credentials SET is_active = 0 WHERE id = 'cred-project'`);

    const res = await sync(codexAuth('project', 3));

    expect(res.body).toEqual({ success: false, reason: 'credential_not_found' });
    expect(await secret('cc_credentials', 'cred-default')).toBe(codexAuth('default'));
  });
});
