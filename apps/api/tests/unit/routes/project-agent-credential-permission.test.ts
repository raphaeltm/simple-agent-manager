/**
 * Connecting or removing YOUR OWN agent account in a project changes only your runs
 * there, so it needs `task:write` (OWN_AGENT_ACCOUNT_PROJECT_CAPABILITY), not
 * `secret:write`. Real routes and real project-auth against a real SQLite engine:
 * a maintainer can, a viewer and a non-member cannot, and nothing is written on refusal.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/capacity-pool-credential-lifecycle', () => ({
  reconcileCapacityPoolsForCredentialMutation: vi.fn().mockResolvedValue(undefined),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { projectCredentialsRoutes } from '../../../src/routes/projects/credentials';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NOW = '2026-11-01T00:00:00.000Z';
const ME = 'user-me';

let sqlite: Database.Database;
let env: Env;

function app(): Hono<{ Bindings: Env }> {
  const hono = new Hono<{ Bindings: Env }>();
  hono.use('*', async (c, next) => {
    const auth: AuthContext = {
      user: {
        id: ME,
        email: 'me@example.test',
        name: 'Me',
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: 'session-me', expiresAt: new Date('2027-01-01T00:00:00.000Z') },
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
  hono.route('/api/projects', projectCredentialsRoutes);
  return hono;
}

function seedProject(role: string | null): void {
  sqlite
    .prepare(
      `INSERT INTO projects (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status, created_by, created_at, updated_at)
       VALUES ('p1', 'owner', 'P', 'p', 'acme/repo', 'main', 'github', 'active', 'owner', ?, ?)`
    )
    .run(NOW, NOW);
  if (role) {
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
         VALUES ('p1', ?, ?, 'active', ?, ?)`
      )
      .run(ME, role, NOW, NOW);
  }
}

function myProjectCredentials(): number {
  return (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM credentials WHERE user_id = ? AND project_id = 'p1'`)
      .get(ME) as { n: number }
  ).n;
}

async function connect(): Promise<Response> {
  return app().request(
    '/api/projects/p1/credentials',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-api03-' + 'a'.repeat(90),
      }),
    },
    env
  );
}

async function remove(): Promise<Response> {
  return app().request(
    '/api/projects/p1/credentials/claude-code/api-key',
    { method: 'DELETE' },
    env
  );
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  const kv = new Map<string, string>();
  env = {
    DATABASE: createSqliteD1(sqlite),
    ENCRYPTION_KEY,
    KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => void kv.set(key, value)),
      delete: vi.fn(async (key: string) => void kv.delete(key)),
    },
  } as unknown as Env;
});

afterEach(() => sqlite.close());

describe('own agent account in a project needs task:write', () => {
  it('a maintainer (task:write, no secret:write) can connect and remove their own account', async () => {
    seedProject('maintainer');

    const connected = await connect();
    expect(connected.status).toBe(201);
    expect(myProjectCredentials()).toBe(1);

    const removed = await remove();
    expect(removed.status).toBe(200);
    expect(myProjectCredentials()).toBe(0);
  });

  it('a viewer cannot connect or remove, and nothing is written', async () => {
    seedProject('viewer');

    expect((await connect()).status).toBe(403);
    expect(myProjectCredentials()).toBe(0);

    sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, agent_type, credential_kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES ('legacy-1', ?, 'p1', 'anthropic', 'agent-api-key', 'claude-code', 'api-key', 'enc', 'iv', 1, ?, ?)`
      )
      .run(ME, NOW, NOW);
    expect((await remove()).status).toBe(403);
    expect(myProjectCredentials()).toBe(1);
  });

  it('a non-member gets not found', async () => {
    seedProject(null);

    expect((await connect()).status).toBe(404);
    expect((await remove()).status).toBe(404);
    expect(myProjectCredentials()).toBe(0);
  });
});
