/**
 * POST /api/cc/attachments with a projectId pins one of the caller's existing
 * accounts to a project. Behavioral coverage through the real Hono route and a
 * real SQLite engine (rule 28: the ownership and replace guards are SQL
 * predicates, so a mock that ignores `.where()` could not prove them), ending in
 * the real composable-credentials resolver the runtime uses (rule 35).
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
import { resolveForConsumer } from '../../../src/services/composable-credentials/resolve';
import { encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OWNER = 'user-owner';
const OTHER = 'user-other';
const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const PROJECT_FOREIGN = 'project-foreign';
const PROJECT_MAINTAINED = 'project-maintained';
const CLAUDE = { kind: 'agent' as const, agentType: 'claude-code' };
const NOW = '2026-10-31T00:00:00.000Z';

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

function seedProject(id: string, ownerId: string): void {
  sqlite
    .prepare(
      `INSERT INTO projects
         (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'acme/repo', 'main', 'github', 'active', ?, ?, ?)`
    )
    .run(id, ownerId, id, id, ownerId, NOW, NOW);
}

function seedMember(projectId: string, userId: string, role: string): void {
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`
    )
    .run(projectId, userId, role, NOW, NOW);
}

/** One account: an encrypted credential plus the configuration that binds it to Claude Code. */
async function seedAccount(
  id: string,
  ownerId: string,
  token: string,
  options: { configActive?: boolean; credentialActive?: boolean } = {}
): Promise<void> {
  const { ciphertext, iv } = await encrypt(token, ENCRYPTION_KEY);
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
       VALUES (?, ?, ?, 'agent', 'claude-code', ?, ?, ?, ?)`
    )
    .run(`cfg-${id}`, ownerId, id, `cred-${id}`, options.configActive === false ? 0 : 1, NOW, NOW);
}

function seedAttachment(
  id: string,
  configurationId: string,
  userId: string,
  projectId: string | null,
  consumer: { kind: string; target: string } = { kind: 'agent', target: 'claude-code' }
): void {
  sqlite
    .prepare(
      `INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(id, configurationId, consumer.kind, consumer.target, userId, projectId, NOW, NOW);
}

function attachmentsFor(projectId: string | null, userId = OWNER) {
  return sqlite
    .prepare(
      `SELECT configuration_id AS configurationId, consumer_target AS consumerTarget
         FROM cc_attachments
        WHERE user_id = ? AND project_id IS ?
        ORDER BY configuration_id`
    )
    .all(userId, projectId) as Array<{ configurationId: string; consumerTarget: string }>;
}

async function attach(body: Record<string, unknown>): Promise<Response> {
  return app.request(
    '/api/cc/attachments',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
}

async function resolvedConfiguration(projectId?: string): Promise<string | null> {
  const db = drizzle(env.DATABASE);
  const resolved = await resolveForConsumer(db, OWNER, ENCRYPTION_KEY, CLAUDE, projectId);
  return resolved?.configuration?.id ?? null;
}

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

  seedProject(PROJECT_A, OWNER);
  seedProject(PROJECT_B, OWNER);
  seedProject(PROJECT_FOREIGN, OTHER);
  seedProject(PROJECT_MAINTAINED, OTHER);
  seedMember(PROJECT_A, OWNER, 'owner');
  seedMember(PROJECT_B, OWNER, 'owner');
  seedMember(PROJECT_FOREIGN, OTHER, 'owner');
  seedMember(PROJECT_MAINTAINED, OTHER, 'owner');
  seedMember(PROJECT_MAINTAINED, OWNER, 'maintainer');

  // The screenshot's shape: a default, a pinned account, and an unattached one.
  await seedAccount('ec', OWNER, 'sk-ant-oat01-ec');
  await seedAccount('defang', OWNER, 'sk-ant-oat01-defang');
  await seedAccount('sam', OWNER, 'sk-ant-oat01-sam');
  seedAttachment('att-default', 'cfg-ec', OWNER, null);
  seedAttachment('att-pin-a', 'cfg-defang', OWNER, PROJECT_A);
});

afterEach(() => sqlite.close());

describe('POST /api/cc/attachments — pin an existing account to a project', () => {
  it('replaces the project’s previous pin, and the project resolves to the attached account', async () => {
    expect(await resolvedConfiguration(PROJECT_A)).toBe('cfg-defang');

    const response = await attach({ configurationId: 'cfg-sam', projectId: PROJECT_A });

    expect(response.status).toBe(201);
    expect(attachmentsFor(PROJECT_A)).toEqual([
      { configurationId: 'cfg-sam', consumerTarget: 'claude-code' },
    ]);
    expect(await resolvedConfiguration(PROJECT_A)).toBe('cfg-sam');
    // The default and every unpinned project are untouched.
    expect(attachmentsFor(null)).toEqual([
      { configurationId: 'cfg-ec', consumerTarget: 'claude-code' },
    ]);
    expect(await resolvedConfiguration(PROJECT_B)).toBe('cfg-ec');
    expect(await resolvedConfiguration()).toBe('cfg-ec');
  });

  it('pins one non-default account to several projects', async () => {
    expect((await attach({ configurationId: 'cfg-sam', projectId: PROJECT_A })).status).toBe(201);
    expect((await attach({ configurationId: 'cfg-sam', projectId: PROJECT_B })).status).toBe(201);

    expect(await resolvedConfiguration(PROJECT_A)).toBe('cfg-sam');
    expect(await resolvedConfiguration(PROJECT_B)).toBe('cfg-sam');
    expect(attachmentsFor(PROJECT_B)).toHaveLength(1);
  });

  it('re-attaching the same account to a project leaves exactly one pin', async () => {
    await attach({ configurationId: 'cfg-sam', projectId: PROJECT_A });
    await attach({ configurationId: 'cfg-sam', projectId: PROJECT_A });

    expect(attachmentsFor(PROJECT_A)).toEqual([
      { configurationId: 'cfg-sam', consumerTarget: 'claude-code' },
    ]);
  });

  it('replaces only the same consumer: another agent’s pin and another user’s pin survive', async () => {
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
         VALUES ('cfg-codex', ?, 'codex', 'agent', 'openai-codex', 'cred-ec', 1, ?, ?)`
      )
      .run(OWNER, NOW, NOW);
    seedAttachment('att-codex-a', 'cfg-codex', OWNER, PROJECT_A, {
      kind: 'agent',
      target: 'openai-codex',
    });
    seedMember(PROJECT_A, OTHER, 'admin');
    await seedAccount('other', OTHER, 'sk-ant-oat01-other');
    seedAttachment('att-other-a', 'cfg-other', OTHER, PROJECT_A);

    expect((await attach({ configurationId: 'cfg-sam', projectId: PROJECT_A })).status).toBe(201);

    expect(attachmentsFor(PROJECT_A)).toEqual([
      { configurationId: 'cfg-codex', consumerTarget: 'openai-codex' },
      { configurationId: 'cfg-sam', consumerTarget: 'claude-code' },
    ]);
    expect(attachmentsFor(PROJECT_A, OTHER)).toEqual([
      { configurationId: 'cfg-other', consumerTarget: 'claude-code' },
    ]);
  });

  it('refuses a project the caller is not a member of, and writes nothing', async () => {
    const response = await attach({ configurationId: 'cfg-sam', projectId: PROJECT_FOREIGN });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(attachmentsFor(PROJECT_FOREIGN)).toEqual([]);
  });

  it('refuses a member without secret:write, and writes nothing', async () => {
    const response = await attach({ configurationId: 'cfg-sam', projectId: PROJECT_MAINTAINED });

    expect(response.status).toBe(403);
    expect(attachmentsFor(PROJECT_MAINTAINED)).toEqual([]);
  });

  it('refuses another user’s account and keeps the existing pin', async () => {
    await seedAccount('foreign', OTHER, 'sk-ant-oat01-foreign');

    const response = await attach({ configurationId: 'cfg-foreign', projectId: PROJECT_A });

    expect(response.status).toBe(400);
    expect(await resolvedConfiguration(PROJECT_A)).toBe('cfg-defang');
  });

  it.each([
    ['configuration', { configActive: false }],
    ['credential', { credentialActive: false }],
  ])(
    'refuses a paused %s, which would halt the project, and keeps the existing pin',
    async (_label, options) => {
      await seedAccount('paused', OWNER, 'sk-ant-oat01-paused', options);

      const response = await attach({ configurationId: 'cfg-paused', projectId: PROJECT_A });

      expect(response.status).toBe(400);
      expect(attachmentsFor(PROJECT_A)).toEqual([
        { configurationId: 'cfg-defang', consumerTarget: 'claude-code' },
      ]);
      expect(await resolvedConfiguration(PROJECT_A)).toBe('cfg-defang');
    }
  );

  it('a user-scoped attachment (no projectId) does not replace anything', async () => {
    expect((await attach({ configurationId: 'cfg-sam' })).status).toBe(201);

    expect(attachmentsFor(null)).toEqual([
      { configurationId: 'cfg-ec', consumerTarget: 'claude-code' },
      { configurationId: 'cfg-sam', consumerTarget: 'claude-code' },
    ]);
    expect(attachmentsFor(PROJECT_A)).toEqual([
      { configurationId: 'cfg-defang', consumerTarget: 'claude-code' },
    ]);
  });

  it.each([
    ['a missing configurationId', { projectId: PROJECT_A }],
    ['a non-string projectId', { configurationId: 'cfg-sam', projectId: 42 }],
  ])('rejects %s before touching any pin', async (_label, body) => {
    const response = await attach(body);

    expect(response.status).toBe(400);
    expect(await resolvedConfiguration(PROJECT_A)).toBe('cfg-defang');
  });
});
