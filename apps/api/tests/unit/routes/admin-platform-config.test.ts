import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { generateEncryptionKey } from '../../../src/services/encryption';
import { getGitLabOAuthConfig } from '../../../src/services/platform-config';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: any, next: any) => next(),
  requireApproved: () => async (_c: any, next: any) => next(),
  requireSuperadmin: () => async (c: any, next: any) => {
    if (c.req.header('X-Test-Role') !== 'superadmin') {
      return c.json({ error: 'FORBIDDEN', message: 'Superadmin required' }, 403);
    }
    await next();
  },
  getUserId: () => 'superadmin-1',
}));

const { adminPlatformConfigRoutes } = await import('../../../src/routes/admin-platform-config');

interface SqliteD1Result {
  meta: { changes: number };
  results?: unknown[];
}

function createD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async first<T>() {
          return statement.get(...bindings) as T | null;
        },
        async all<T>() {
          return { results: statement.all(...bindings) as T[] };
        },
        async run(): Promise<SqliteD1Result> {
          const result = statement.run(...bindings);
          return { meta: { changes: result.changes } };
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      const results: D1Result[] = [];
      try {
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  } as unknown as D1Database;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('system_anonymous_trials');
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    );
    CREATE TABLE platform_credentials (
      id TEXT PRIMARY KEY,
      credential_type TEXT NOT NULL,
      provider TEXT,
      agent_type TEXT,
      credential_kind TEXT NOT NULL DEFAULT 'api-key',
      label TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return {
    DATABASE: createD1(sqlite),
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY: generateEncryptionKey(),
    ...overrides,
  } as Env;
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/admin/platform-config', adminPlatformConfigRoutes);
  return app;
}

describe('admin platform config routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('persists GitLab OAuth config through the superadmin runtime config endpoint', async () => {
    const env = createEnv();
    const res = await createApp().request(
      '/api/admin/platform-config',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-Role': 'superadmin',
        },
        body: JSON.stringify({
          config: {
            gitlab: {
              host: 'https://gitlab.admin.example.com/',
              clientId: 'gitlab-admin-client',
              clientSecret: 'gitlab-admin-secret',
            },
          },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: {
        integrations: {
          gitlabOAuth: { configured: true, label: 'set here' },
        },
      },
    });

    const settings = await env.DATABASE.prepare(
      `SELECT key, value FROM platform_settings WHERE key LIKE 'integration.gitlab.%' ORDER BY key`
    ).all<{ key: string; value: string }>();
    expect(settings.results).toEqual([
      { key: 'integration.gitlab.clientId', value: 'gitlab-admin-client' },
      { key: 'integration.gitlab.host', value: 'https://gitlab.admin.example.com/' },
    ]);

    const secretRow = await env.DATABASE.prepare(
      `SELECT provider, credential_kind AS credentialKind, encrypted_token AS encryptedToken, is_enabled AS isEnabled
       FROM platform_credentials
       WHERE credential_type = 'platform-integration' AND provider = 'gitlab'`
    ).first<{
      provider: string;
      credentialKind: string;
      encryptedToken: string;
      isEnabled: number;
    }>();
    expect(secretRow).toMatchObject({
      provider: 'gitlab',
      credentialKind: 'gitlab.clientSecret',
      isEnabled: 1,
    });
    expect(secretRow?.encryptedToken).not.toBe('gitlab-admin-secret');
    expect(secretRow?.encryptedToken).not.toContain('gitlab-admin-secret');

    await expect(getGitLabOAuthConfig(env)).resolves.toEqual({
      host: 'https://gitlab.admin.example.com',
      apiBaseUrl: 'https://gitlab.admin.example.com/api/v4',
      clientId: 'gitlab-admin-client',
      clientSecret: 'gitlab-admin-secret',
    });
  });

  it('stores, rotates, and removes infrastructure OAuth as a superadmin without returning the secret', async () => {
    const env = createEnv({
      GOOGLE_CLIENT_ID: 'env-infra-client',
      GOOGLE_CLIENT_SECRET: 'env-infra-secret',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));

    const save = await createApp().request('/api/admin/platform-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'superadmin' },
      body: JSON.stringify({
        config: {
          googleInfrastructure: {
            clientId: 'runtime-infra-client',
            clientSecret: 'runtime-infra-secret',
          },
        },
      }),
    }, env);

    expect(save.status).toBe(200);
    const saveBody = await save.text();
    expect(saveBody).not.toContain('runtime-infra-secret');
    expect(JSON.parse(saveBody)).toMatchObject({
      status: {
        integrations: {
          googleInfrastructureOAuth: { configured: true, source: 'runtime' },
          googleOAuth: { configured: false },
        },
      },
    });
    const secretRow = await env.DATABASE.prepare(
      `SELECT encrypted_token AS encryptedToken, updated_by AS updatedBy
       FROM platform_credentials
       WHERE provider = 'google-infrastructure'`,
    ).first<{ encryptedToken: string; updatedBy: string }>();
    expect(secretRow?.encryptedToken).not.toContain('runtime-infra-secret');
    expect(secretRow?.updatedBy).toBe('superadmin-1');

    const rotate = await createApp().request('/api/admin/platform-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'superadmin' },
      body: JSON.stringify({
        config: {
          googleInfrastructure: {
            clientId: 'runtime-infra-client-rotated',
            clientSecret: 'runtime-infra-secret-rotated',
          },
        },
      }),
    }, env);
    expect(rotate.status).toBe(200);
    expect(await rotate.text()).not.toContain('runtime-infra-secret-rotated');
    const rotatedRows = await env.DATABASE.prepare(
      `SELECT encrypted_token AS encryptedToken, updated_by AS updatedBy
       FROM platform_credentials
       WHERE provider = 'google-infrastructure'`,
    ).all<{ encryptedToken: string; updatedBy: string }>();
    expect(rotatedRows.results).toHaveLength(1);
    expect(rotatedRows.results[0]?.encryptedToken).not.toBe(secretRow?.encryptedToken);
    expect(rotatedRows.results[0]?.encryptedToken).not.toContain('runtime-infra-secret-rotated');
    expect(rotatedRows.results[0]?.updatedBy).toBe('superadmin-1');

    const remove = await createApp().request('/api/admin/platform-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'superadmin' },
      body: JSON.stringify({ config: { googleInfrastructure: { remove: true } } }),
    }, env);
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({
      status: {
        integrations: {
          googleInfrastructureOAuth: {
            configured: true,
            source: 'environment',
          },
        },
      },
    });
  });

  it('keeps the endpoint behind the superadmin guard', async () => {
    const res = await createApp().request(
      '/api/admin/platform-config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'admin' },
        body: JSON.stringify({ config: { gitlab: { host: 'https://gitlab.example.com' } } }),
      },
      createEnv()
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'FORBIDDEN',
      message: 'Superadmin required',
    });
  });

  it('rejects malformed platform config bodies before persistence', async () => {
    const res = await createApp().request('/api/admin/platform-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'superadmin' },
      body: JSON.stringify({ config: 'not-an-object' }),
    }, createEnv());

    expect(res.status).toBe(400);
  });
});
