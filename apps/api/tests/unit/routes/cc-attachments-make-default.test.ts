/**
 * POST /api/cc/attachments/default makes one of the caller's existing agent
 * accounts their default. Driven through the real Hono route on a real SQLite
 * engine (rule 28: the ownership guards and the replace are SQL predicates), and
 * read back through the resolver the runtime uses and the legacy row the Codex
 * refresh path reads (rule 44: both representations move together).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/capacity-pool-credential-lifecycle', () => ({
  reconcileCapacityPoolsForCredentialMutation: vi.fn().mockResolvedValue(undefined),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { ccRoutes } from '../../../src/routes/composable-credentials';
import { getDecryptedAgentKey } from '../../../src/routes/credentials';
import { syncActiveAgentCredentialSecret } from '../../../src/services/composable-credentials/agent-sync';
import { resolveForConsumer } from '../../../src/services/composable-credentials/resolve';
import { decrypt, encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OWNER = 'user-owner';
const OTHER = 'user-other';
const PROJECT_PINNED = 'project-pinned';
const PROJECT_UNPINNED = 'project-unpinned';
const CODEX = 'openai-codex';
const NOW = '2026-11-01T00:00:00.000Z';

const codexAuth = (who: string) =>
  JSON.stringify({ tokens: { access_token: `access-${who}`, refresh_token: `refresh-${who}` } });

let sqlite: Database.Database;
let env: Env;
let app: Hono<{ Bindings: Env }>;

function authContext(): AuthContext {
  return {
    user: {
      id: OWNER,
      email: 'owner@example.test',
      name: 'Owner',
      avatarUrl: null,
      role: 'user',
      status: 'active',
    },
    session: { id: 'session-owner', expiresAt: new Date('2027-01-01T00:00:00.000Z') },
  };
}

function seedProject(id: string): void {
  sqlite
    .prepare(
      `INSERT INTO projects
         (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'acme/repo', 'main', 'github', 'active', ?, ?, ?)`
    )
    .run(id, OWNER, id, id, OWNER, NOW, NOW);
}

interface AccountOptions {
  ownerId?: string;
  agent?: string;
  consumerKind?: string;
  kind?: string;
  configActive?: boolean;
  credentialActive?: boolean;
}

/** One account: an encrypted cc credential plus the configuration binding it to an agent. */
async function seedAccount(id: string, secret: string, options: AccountOptions = {}) {
  const ownerId = options.ownerId ?? OWNER;
  const { ciphertext, iv } = await encrypt(secret, ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `cred-${id}`,
      ownerId,
      id,
      options.kind ?? 'auth-json',
      ciphertext,
      iv,
      options.credentialActive === false ? 0 : 1,
      NOW,
      NOW
    );
  sqlite
    .prepare(
      `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `cfg-${id}`,
      ownerId,
      id,
      options.consumerKind ?? 'agent',
      options.agent ?? CODEX,
      `cred-${id}`,
      options.configActive === false ? 0 : 1,
      NOW,
      NOW
    );
  return { ciphertext, iv };
}

function seedAttachment(
  id: string,
  configurationId: string,
  projectId: string | null,
  options: { userId?: string; agent?: string; isActive?: boolean } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      configurationId,
      options.agent ?? CODEX,
      options.userId ?? OWNER,
      projectId,
      options.isActive === false ? 0 : 1,
      NOW,
      NOW
    );
}

/** The legacy user-scoped row the Connections flow keeps for the current default. */
function seedLegacyRow(
  kind: 'api-key' | 'oauth-token',
  token: { ciphertext: string; iv: string },
  options: { userId?: string; agent?: string; isActive?: boolean } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, agent_type, credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, NULL, 'openai', 'agent-api-key', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `legacy-${options.userId ?? OWNER}-${options.agent ?? CODEX}-${kind}`,
      options.userId ?? OWNER,
      options.agent ?? CODEX,
      kind,
      options.isActive === false ? 0 : 1,
      token.ciphertext,
      token.iv,
      NOW,
      NOW
    );
}

function userDefaults(userId = OWNER, agent = CODEX) {
  return sqlite
    .prepare(
      `SELECT configuration_id AS configurationId, is_active AS isActive FROM cc_attachments
        WHERE user_id = ? AND consumer_target = ? AND project_id IS NULL`
    )
    .all(userId, agent) as Array<{ configurationId: string; isActive: number }>;
}

function legacyRows(userId = OWNER, agent = CODEX) {
  return sqlite
    .prepare(
      `SELECT credential_kind AS kind, is_active AS isActive, encrypted_token AS encryptedToken, iv
         FROM credentials
        WHERE user_id = ? AND agent_type = ? AND project_id IS NULL
        ORDER BY credential_kind`
    )
    .all(userId, agent) as Array<{
    kind: string;
    isActive: number;
    encryptedToken: string;
    iv: string;
  }>;
}

async function activeLegacySecret(agent = CODEX): Promise<string | null> {
  const active = legacyRows(OWNER, agent).filter((row) => row.isActive === 1);
  expect(active.length).toBeLessThanOrEqual(1);
  if (active.length === 0) return null;
  return decrypt(active[0]!.encryptedToken, active[0]!.iv, ENCRYPTION_KEY);
}

async function makeDefault(configurationId: string): Promise<Response> {
  return app.request(
    '/api/cc/attachments/default',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configurationId }),
    },
    env
  );
}

async function resolvedConfiguration(projectId?: string, agentType = CODEX) {
  const db = drizzle(env.DATABASE);
  const resolved = await resolveForConsumer(
    db,
    OWNER,
    ENCRYPTION_KEY,
    { kind: 'agent', agentType },
    projectId
  );
  return resolved?.configuration?.id ?? null;
}

let workToken: { ciphertext: string; iv: string };

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = { DATABASE: createSqliteD1(sqlite), ENCRYPTION_KEY } as Env;

  app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('auth', authContext());
    c.set('signupApprovalRequired', false);
    await next();
  });
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/cc', ccRoutes);

  seedProject(PROJECT_PINNED);
  seedProject(PROJECT_UNPINNED);

  // The user's shape: Codex "work" is the default (connected through Connections,
  // so the legacy row holds it), "personal" is connected but not the default, and
  // "client" is pinned to one project.
  workToken = await seedAccount('work', codexAuth('work'));
  await seedAccount('personal', codexAuth('personal'));
  await seedAccount('client', codexAuth('client'));
  seedAttachment('att-default', 'cfg-work', null);
  seedAttachment('att-pin', 'cfg-client', PROJECT_PINNED);
  seedLegacyRow('oauth-token', workToken);
});

afterEach(() => sqlite.close());

describe('POST /api/cc/attachments/default — make an existing account the default', () => {
  it('switches the default, and every unpinned project resolves to the new account', async () => {
    expect(await resolvedConfiguration(PROJECT_UNPINNED)).toBe('cfg-work');

    const response = await makeDefault('cfg-personal');

    expect(response.status).toBe(200);
    expect(userDefaults()).toEqual([{ configurationId: 'cfg-personal', isActive: 1 }]);
    expect(await resolvedConfiguration()).toBe('cfg-personal');
    expect(await resolvedConfiguration(PROJECT_UNPINNED)).toBe('cfg-personal');
    // A pinned project keeps its pin.
    expect(await resolvedConfiguration(PROJECT_PINNED)).toBe('cfg-client');
    // The previous default stays connected.
    const work = sqlite.prepare(`SELECT id FROM cc_configurations WHERE id = 'cfg-work'`).get();
    expect(work).toBeDefined();
  });

  it('moves the legacy row the Codex refresh path reads to the new default', async () => {
    expect(await activeLegacySecret()).toBe(codexAuth('work'));

    await makeDefault('cfg-personal');

    // CodexRefreshLock compares a workspace's refresh token against this row. If it
    // still held "work", a workspace on "personal" would be answered with work's tokens.
    expect(await activeLegacySecret()).toBe(codexAuth('personal'));
    expect(legacyRows()).toHaveLength(1);
  });

  it('the runtime hands workspaces the new default’s secret', async () => {
    await makeDefault('cfg-personal');

    const db = drizzle(env.DATABASE);
    const key = await getDecryptedAgentKey(db, OWNER, CODEX, ENCRYPTION_KEY, PROJECT_UNPINNED);

    expect(key?.credential).toBe(codexAuth('personal'));
  });

  it('a later token rotation lands on the new default, not the old one', async () => {
    await makeDefault('cfg-personal');

    // Drive the real mirror writer CodexRefreshLock calls after a rotation.
    const rotated = await encrypt(codexAuth('personal-rotated'), ENCRYPTION_KEY);
    const updated = await syncActiveAgentCredentialSecret(env.DATABASE, {
      userId: OWNER,
      agentType: CODEX,
      credentialKind: 'oauth-token',
      encryptedToken: rotated.ciphertext,
      iv: rotated.iv,
    });

    expect(updated).toBe(1);
    const secretOf = async (id: string) => {
      const row = sqlite
        .prepare(`SELECT encrypted_token AS t, iv FROM cc_credentials WHERE id = ?`)
        .get(id) as { t: string; iv: string };
      return decrypt(row.t, row.iv, ENCRYPTION_KEY);
    };
    expect(await secretOf('cred-personal')).toBe(codexAuth('personal-rotated'));
    expect(await secretOf('cred-work')).toBe(codexAuth('work'));
  });

  it('switching back restores the old account in both stores', async () => {
    await makeDefault('cfg-personal');
    await makeDefault('cfg-work');

    expect(userDefaults()).toEqual([{ configurationId: 'cfg-work', isActive: 1 }]);
    expect(await activeLegacySecret()).toBe(codexAuth('work'));
  });

  it('activates the matching legacy kind when the new default is a different kind', async () => {
    await seedAccount('apikey', 'sk-openai-personal', { kind: 'api-key' });

    expect((await makeDefault('cfg-apikey')).status).toBe(200);

    const rows = legacyRows();
    expect(rows.map((row) => [row.kind, row.isActive])).toEqual([
      ['api-key', 1],
      ['oauth-token', 0],
    ]);
    expect(await activeLegacySecret()).toBe('sk-openai-personal');
  });

  it('deactivates the legacy rows when the account has no legacy equivalent', async () => {
    seedLegacyRow('api-key', await encrypt('sk-opencode-old', ENCRYPTION_KEY), {
      agent: 'opencode',
    });
    await seedAccount(
      'endpoint',
      JSON.stringify({ apiKey: 'k', baseUrl: 'https://llm.example.test/v1' }),
      { agent: 'opencode', kind: 'openai-compatible' }
    );
    seedAttachment('att-opencode-default', 'cfg-endpoint', null, { agent: 'opencode' });
    await seedAccount('opencode-key', 'sk-opencode-new', { agent: 'opencode', kind: 'api-key' });

    expect((await makeDefault('cfg-endpoint')).status).toBe(200);
    expect(await activeLegacySecret('opencode')).toBeNull();
    expect(await resolvedConfiguration(undefined, 'opencode')).toBe('cfg-endpoint');

    // Control: an account that does have a legacy equivalent writes it.
    expect((await makeDefault('cfg-opencode-key')).status).toBe(200);
    expect(await activeLegacySecret('opencode')).toBe('sk-opencode-new');
  });

  it('deactivates rather than copies a secret the legacy validator rejects', async () => {
    await seedAccount('broken', 'not an auth.json');

    expect((await makeDefault('cfg-broken')).status).toBe(200);

    expect(userDefaults()).toEqual([{ configurationId: 'cfg-broken', isActive: 1 }]);
    expect(await activeLegacySecret()).toBeNull();
    expect(legacyRows()[0]?.isActive).toBe(0);
  });

  it('replaces every user-level attachment, including a paused one', async () => {
    seedAttachment('att-paused-default', 'cfg-client', null, { isActive: false });

    await makeDefault('cfg-personal');

    expect(userDefaults()).toEqual([{ configurationId: 'cfg-personal', isActive: 1 }]);
  });

  it('making the current default the default again leaves exactly one default', async () => {
    expect((await makeDefault('cfg-work')).status).toBe(200);

    expect(userDefaults()).toEqual([{ configurationId: 'cfg-work', isActive: 1 }]);
    expect(await activeLegacySecret()).toBe(codexAuth('work'));
  });

  it('leaves other agents and other users untouched', async () => {
    const otherToken = await seedAccount('other-work', codexAuth('other'), { ownerId: OTHER });
    seedAttachment('att-other-default', 'cfg-other-work', null, { userId: OTHER });
    seedLegacyRow('oauth-token', otherToken, { userId: OTHER });
    await seedAccount('claude', 'sk-ant-oat01-claude', {
      agent: 'claude-code',
      kind: 'oauth-token',
    });
    seedAttachment('att-claude-default', 'cfg-claude', null, { agent: 'claude-code' });

    await makeDefault('cfg-personal');

    expect(userDefaults(OTHER)).toEqual([{ configurationId: 'cfg-other-work', isActive: 1 }]);
    expect(legacyRows(OTHER)[0]?.isActive).toBe(1);
    expect(userDefaults(OWNER, 'claude-code')).toEqual([
      { configurationId: 'cfg-claude', isActive: 1 },
    ]);
  });
});

describe('POST /api/cc/attachments/default — refusals change nothing', () => {
  async function expectRefused(configurationId: string) {
    const response = await makeDefault(configurationId);
    expect(response.status).toBe(400);
    expect(userDefaults()).toEqual([{ configurationId: 'cfg-work', isActive: 1 }]);
    expect(await activeLegacySecret()).toBe(codexAuth('work'));
  }

  it('refuses another user’s account', async () => {
    await seedAccount('foreign', codexAuth('foreign'), { ownerId: OTHER });
    await expectRefused('cfg-foreign');
  });

  it('refuses a configuration that points at another user’s credential', async () => {
    await seedAccount('foreign-cred', codexAuth('foreign'), { ownerId: OTHER });
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
         VALUES ('cfg-borrowed', ?, 'borrowed', 'agent', ?, 'cred-foreign-cred', 1, ?, ?)`
      )
      .run(OWNER, CODEX, NOW, NOW);
    await expectRefused('cfg-borrowed');
  });

  it('refuses a paused configuration', async () => {
    await seedAccount('paused-cfg', codexAuth('p'), { configActive: false });
    await expectRefused('cfg-paused-cfg');
  });

  it('refuses a paused credential', async () => {
    await seedAccount('paused-cred', codexAuth('p'), { credentialActive: false });
    await expectRefused('cfg-paused-cred');
  });

  it('refuses a cloud account', async () => {
    await seedAccount('cloud', 'hetzner-token', {
      consumerKind: 'compute',
      agent: 'hetzner',
      kind: 'cloud-provider',
    });
    await expectRefused('cfg-cloud');
  });

  it('refuses a platform binding with no credential of the caller’s', async () => {
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
         VALUES ('cfg-platform', ?, 'platform', 'agent', ?, NULL, 1, ?, ?)`
      )
      .run(OWNER, CODEX, NOW, NOW);
    await expectRefused('cfg-platform');
  });

  it('refuses an account whose secret cannot be decrypted', async () => {
    await seedAccount('garbled', codexAuth('g'));
    sqlite
      .prepare(`UPDATE cc_credentials SET iv = 'AAAAAAAAAAAAAAAA' WHERE id = 'cred-garbled'`)
      .run();
    await expectRefused('cfg-garbled');
  });

  it('rejects a missing configuration id', async () => {
    const response = await app.request(
      '/api/cc/attachments/default',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env
    );
    expect(response.status).toBe(400);
  });
});
