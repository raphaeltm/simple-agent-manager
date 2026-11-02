/**
 * /api/cc/profile-attachments: personal profile pins, through the real Hono route and a
 * real SQLite engine. The access guard is a SQL predicate (own global profile, or a project
 * profile where the caller has task:write), so every attack case runs against SQL with an
 * owner-path control beside it (rule 28), and each ends in the real resolver (rule 35).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ candidateLimit: 500 as number }));
vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSetting: vi.fn(async () => settings.candidateLimit),
}));
vi.mock('../../../src/services/capacity-pool-credential-lifecycle', () => ({
  reconcileCapacityPoolsForCredentialMutation: vi.fn().mockResolvedValue(undefined),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { ccRoutes } from '../../../src/routes/composable-credentials';
import { resolveForConsumer } from '../../../src/services/composable-credentials/resolve';
import { encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OWNER = 'user-owner';
const OTHER = 'user-other';
const CLAUDE = { kind: 'agent' as const, agentType: 'claude-code' };
const NOW = '2026-11-01T00:00:00.000Z';

let sqlite: Database.Database;
let env: Env;
let caller = OWNER;

function app(): Hono<{ Bindings: Env }> {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    const auth: AuthContext = {
      user: {
        id: caller,
        email: `${caller}@example.test`,
        name: caller,
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: `session-${caller}`, expiresAt: new Date('2027-01-01T00:00:00.000Z') },
    };
    c.set('auth', auth);
    c.set('signupApprovalRequired', false);
    await next();
  });
  hono.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  hono.route('/api/cc', ccRoutes);
  return hono;
}

function seedProject(id: string, ownerId: string, name = id): void {
  sqlite
    .prepare(
      `INSERT INTO projects
         (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'acme/repo', 'main', 'github', 'active', ?, ?, ?)`
    )
    .run(id, ownerId, name, id, ownerId, NOW, NOW);
}

function seedMember(projectId: string, userId: string, role: string): void {
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`
    )
    .run(projectId, userId, role, NOW, NOW);
}

function seedProfile(
  id: string,
  userId: string,
  projectId: string | null,
  agentType = 'claude-code'
): void {
  sqlite
    .prepare(
      `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectId, userId, id, agentType, NOW, NOW);
}

async function seedAccount(
  id: string,
  ownerId: string,
  options: { configActive?: boolean; credentialActive?: boolean; agentType?: string } = {}
): Promise<void> {
  const { ciphertext, iv } = await encrypt(`sk-ant-oat01-${id}`, ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'oauth-token', ?, ?, ?, ?, ?)`
    )
    .run(
      `cred-${id}`,
      ownerId,
      id,
      ciphertext,
      iv,
      options.credentialActive === false ? 0 : 1,
      NOW,
      NOW
    );
  sqlite
    .prepare(
      `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?)`
    )
    .run(
      `cfg-${id}`,
      ownerId,
      id,
      options.agentType ?? 'claude-code',
      `cred-${id}`,
      options.configActive === false ? 0 : 1,
      NOW,
      NOW
    );
}

function seedAttachment(
  id: string,
  configurationId: string,
  userId: string,
  projectId: string | null
) {
  sqlite
    .prepare(
      `INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'agent', 'claude-code', ?, ?, 1, ?, ?)`
    )
    .run(id, configurationId, userId, projectId, NOW, NOW);
}

function pinsFor(userId = OWNER) {
  return sqlite
    .prepare(
      `SELECT agent_profile_id AS profileId, configuration_id AS configurationId
         FROM cc_profile_attachments WHERE user_id = ? ORDER BY agent_profile_id, configuration_id`
    )
    .all(userId) as Array<{ profileId: string; configurationId: string }>;
}

async function pin(body: Record<string, unknown>): Promise<Response> {
  return app().request(
    '/api/cc/profile-attachments',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
}

/** The account a run of `profileId` in `projectId` resolves to, through the real resolver. */
async function runsOn(projectId: string | null, profileId?: string): Promise<string | null> {
  const resolved = await resolveForConsumer(
    drizzle(env.DATABASE),
    OWNER,
    ENCRYPTION_KEY,
    CLAUDE,
    projectId,
    profileId ? { profileId, agentType: 'claude-code' } : null
  );
  return resolved?.configuration?.id ?? null;
}

beforeEach(async () => {
  caller = OWNER;
  settings.candidateLimit = 500;
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = { DATABASE: createSqliteD1(sqlite), ENCRYPTION_KEY } as Env;

  seedProject('p-own', OWNER, 'Alpha');
  seedProject('p-maintained', OTHER, 'Beta');
  seedProject('p-viewed', OTHER, 'Gamma');
  seedProject('p-foreign', OTHER, 'Delta');
  seedMember('p-own', OWNER, 'owner');
  for (const id of ['p-maintained', 'p-viewed', 'p-foreign']) seedMember(id, OTHER, 'owner');
  seedMember('p-maintained', OWNER, 'maintainer');
  seedMember('p-viewed', OWNER, 'viewer');

  seedProfile('prof-global', OWNER, null);
  seedProfile('prof-other-global', OTHER, null);
  seedProfile('prof-own', OWNER, 'p-own');
  seedProfile('prof-codex', OWNER, 'p-own', 'openai-codex');
  seedProfile('prof-maintained', OTHER, 'p-maintained');
  seedProfile('prof-viewed', OTHER, 'p-viewed');
  seedProfile('prof-foreign', OTHER, 'p-foreign');

  await seedAccount('default', OWNER);
  await seedAccount('client', OWNER);
  await seedAccount('max', OWNER);
  await seedAccount('other', OTHER);
  seedAttachment('att-default', 'cfg-default', OWNER, null);
  seedAttachment('att-client', 'cfg-client', OWNER, 'p-own');
});

afterEach(() => sqlite.close());

describe('POST /api/cc/profile-attachments', () => {
  it('pins an account to my global profile, and it wins in every project over a project pin', async () => {
    const response = await pin({ configurationId: 'cfg-max', profileId: 'prof-global' });

    expect(response.status).toBe(201);
    expect(pinsFor()).toEqual([{ profileId: 'prof-global', configurationId: 'cfg-max' }]);
    expect(await runsOn('p-own', 'prof-global')).toBe('cfg-max');
    expect(await runsOn('p-maintained', 'prof-global')).toBe('cfg-max');
    // Without the profile, the project pin and the default still apply.
    expect(await runsOn('p-own')).toBe('cfg-client');
    expect(await runsOn('p-maintained')).toBe('cfg-default');
  });

  it('lets a maintainer pin their own account to a project profile someone else created', async () => {
    const response = await pin({ configurationId: 'cfg-max', profileId: 'prof-maintained' });

    expect(response.status).toBe(201);
    expect(await runsOn('p-maintained', 'prof-maintained')).toBe('cfg-max');
  });

  it('keeps project pins alongside profile pins', async () => {
    await pin({ configurationId: 'cfg-max', profileId: 'prof-own' });

    expect(await runsOn('p-own', 'prof-own')).toBe('cfg-max');
    expect(
      sqlite
        .prepare(`SELECT configuration_id AS c FROM cc_attachments WHERE project_id = 'p-own'`)
        .all()
    ).toEqual([{ c: 'cfg-client' }]);
  });

  it.each([
    ['another user’s global profile', 'prof-other-global'],
    ['a project profile where I am not a member', 'prof-foreign'],
    ['a project profile where I am only a viewer', 'prof-viewed'],
    ['a profile that does not exist', 'prof-missing'],
  ])('answers not found for %s and writes nothing', async (_label, profileId) => {
    const response = await pin({ configurationId: 'cfg-max', profileId });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Agent profile not found' });
    expect(pinsFor()).toEqual([]);
  });

  it('refuses another user’s platform-managed configuration (no credential to check)', async () => {
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
         VALUES ('cfg-other-platform', ?, 'platform', 'agent', 'claude-code', NULL, 1, ?, ?)`
      )
      .run(OTHER, NOW, NOW);

    const response = await pin({ configurationId: 'cfg-other-platform', profileId: 'prof-global' });

    expect(response.status).toBe(400);
    expect(pinsFor()).toEqual([]);
  });

  it('refuses another user’s account', async () => {
    const response = await pin({ configurationId: 'cfg-other', profileId: 'prof-global' });

    expect(response.status).toBe(400);
    expect(pinsFor()).toEqual([]);
    expect(pinsFor(OTHER)).toEqual([]);
  });

  it.each([
    ['configuration', { configActive: false }],
    ['credential', { credentialActive: false }],
  ])('refuses a paused %s, which would halt the profile', async (_label, options) => {
    await seedAccount('paused', OWNER, options);

    const response = await pin({ configurationId: 'cfg-paused', profileId: 'prof-own' });

    expect(response.status).toBe(400);
    expect(pinsFor()).toEqual([]);
    expect(await runsOn('p-own', 'prof-own')).toBe('cfg-client');
  });

  it('refuses an account for a different agent than the profile runs', async () => {
    const response = await pin({ configurationId: 'cfg-max', profileId: 'prof-codex' });

    expect(response.status).toBe(400);
    expect(pinsFor()).toEqual([]);
  });

  it('replaces my previous pin on that profile, leaving exactly one', async () => {
    await pin({ configurationId: 'cfg-max', profileId: 'prof-own' });
    const response = await pin({ configurationId: 'cfg-client', profileId: 'prof-own' });

    expect(response.status).toBe(201);
    expect(pinsFor()).toEqual([{ profileId: 'prof-own', configurationId: 'cfg-client' }]);
  });

  it('never touches another member’s pin on the same profile', async () => {
    caller = OTHER;
    expect((await pin({ configurationId: 'cfg-other', profileId: 'prof-maintained' })).status).toBe(
      201
    );
    caller = OWNER;
    expect((await pin({ configurationId: 'cfg-max', profileId: 'prof-maintained' })).status).toBe(
      201
    );

    expect(pinsFor(OTHER)).toEqual([
      { profileId: 'prof-maintained', configurationId: 'cfg-other' },
    ]);
    expect(pinsFor()).toEqual([{ profileId: 'prof-maintained', configurationId: 'cfg-max' }]);
    // My run of that profile uses my account, not theirs.
    expect(await runsOn('p-maintained', 'prof-maintained')).toBe('cfg-max');
  });
});

describe('GET and DELETE /api/cc/profile-attachments', () => {
  it('lists only my pins', async () => {
    caller = OTHER;
    await pin({ configurationId: 'cfg-other', profileId: 'prof-maintained' });
    caller = OWNER;
    await pin({ configurationId: 'cfg-max', profileId: 'prof-maintained' });

    const response = await app().request('/api/cc/profile-attachments', {}, env);
    const body = (await response.json()) as {
      attachments: Array<{ configurationId: string; profileName: string; projectName: string }>;
    };

    expect(body.attachments).toEqual([
      expect.objectContaining({
        configurationId: 'cfg-max',
        profileName: 'prof-maintained',
        projectId: 'p-maintained',
        projectName: 'Beta',
      }),
    ]);
  });

  it('removing my pin falls back to the project pin', async () => {
    await pin({ configurationId: 'cfg-max', profileId: 'prof-own' });
    const [row] = sqlite.prepare('SELECT id FROM cc_profile_attachments').all() as Array<{
      id: string;
    }>;

    const response = await app().request(
      `/api/cc/profile-attachments/${row!.id}`,
      { method: 'DELETE' },
      env
    );

    expect(response.status).toBe(200);
    expect(pinsFor()).toEqual([]);
    expect(await runsOn('p-own', 'prof-own')).toBe('cfg-client');
  });

  it('cannot delete another member’s pin', async () => {
    caller = OTHER;
    await pin({ configurationId: 'cfg-other', profileId: 'prof-maintained' });
    const [row] = sqlite.prepare('SELECT id FROM cc_profile_attachments').all() as Array<{
      id: string;
    }>;
    caller = OWNER;

    const response = await app().request(
      `/api/cc/profile-attachments/${row!.id}`,
      { method: 'DELETE' },
      env
    );

    expect(response.status).toBe(404);
    expect(pinsFor(OTHER)).toHaveLength(1);
  });
});

describe('GET /api/cc/profile-attachments/profiles', () => {
  async function candidates(query = '') {
    const response = await app().request(`/api/cc/profile-attachments/profiles${query}`, {}, env);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      profiles: Array<{ id: string; projectName: string | null }>;
      truncated: boolean;
      limit: number;
    };
  }

  it('lists my global profiles first, then profiles in projects where I can run tasks', async () => {
    const body = await candidates();

    expect(body.profiles.map((p) => p.id)).toEqual([
      'prof-global',
      'prof-codex',
      'prof-own',
      'prof-maintained',
    ]);
    expect(body.profiles.map((p) => p.projectName)).toEqual([null, 'Alpha', 'Alpha', 'Beta']);
    expect(body.truncated).toBe(false);
  });

  it('filters by agent type', async () => {
    const body = await candidates('?agentType=openai-codex');
    expect(body.profiles.map((p) => p.id)).toEqual(['prof-codex']);
  });

  it('discloses when the list hit its cap', async () => {
    settings.candidateLimit = 2;
    const body = await candidates();

    expect(body.profiles.map((p) => p.id)).toEqual(['prof-global', 'prof-codex']);
    expect(body).toMatchObject({ truncated: true, limit: 2 });
  });
});
