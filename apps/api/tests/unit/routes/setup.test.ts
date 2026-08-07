import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { setupRoutes } from '../../../src/routes/setup';
import { decrypt, generateEncryptionKey } from '../../../src/services/encryption';

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
        async run() {
          const result = statement.run(...bindings);
          return { meta: { changes: result.changes } };
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      const results: D1Result[] = [];
      try {
        for (const statement of statements) {
          results.push(await statement.run());
        }
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
    SETUP_TOKEN: 'setup-token',
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
  app.route('/api/setup', setupRoutes);
  return app;
}

describe('setup routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
  });

  it('allows token-gated access without session auth while setup is open', async () => {
    const res = await createApp().request(
      '/api/setup/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' },
        body: JSON.stringify({ token: 'setup-token' }),
      },
      createEnv(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('returns 410 once setup.completed is true', async () => {
    const env = createEnv();
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES ('setup.completed', 'true', 'admin-1')`
    ).run();

    const res = await createApp().request(
      '/api/setup/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'setup-token' }),
      },
      env,
    );

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: 'SETUP_CLOSED' });
  });

  it('returns 410 for setup status once setup.completed is true', async () => {
    const env = createEnv();
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES ('setup.completed', 'true', 'admin-1')`
    ).run();

    const res = await createApp().request('/api/setup/status', {}, env);

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: 'SETUP_CLOSED' });
  });

  it('reopens setup when SETUP_FORCE is true', async () => {
    const env = createEnv({ SETUP_FORCE: 'true' });
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES ('setup.completed', 'true', 'admin-1')`
    ).run();

    const res = await createApp().request('/api/setup/status', {}, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      completed: false,
      open: true,
      forced: true,
      tokenConfigured: true,
    });
  });

  it('validates at least one login provider before completing setup', async () => {
    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.10' },
        body: JSON.stringify({ token: 'setup-token', config: { github: { appId: '12345' } } }),
      },
      createEnv(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      message: 'Setup cannot be completed',
      details: { errors: ['Configure at least one login provider before completing setup'] },
    });
  });

  it('completes setup with valid Google login config', async () => {
    const env = createEnv();
    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.11' },
        body: JSON.stringify({
          token: 'setup-token',
          config: {
            google: {
              clientId: 'google-client-id',
              clientSecret: 'google-client-secret',
            },
          },
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ completed: true });

    const row = await env.DATABASE.prepare(
      "SELECT value FROM platform_settings WHERE key = 'setup.completed'"
    ).first<{ value: string }>();
    expect(row?.value).toBe('true');
  });

  it('completes setup with valid GitLab login config', async () => {
    const env = createEnv();
    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.12' },
        body: JSON.stringify({
          token: 'setup-token',
          config: {
            gitlab: {
              host: 'https://gitlab.example.com',
              clientId: 'gitlab-client-id',
              clientSecret: 'gitlab-client-secret',
            },
          },
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      completed: true,
      status: {
        integrations: {
          gitlabOAuth: { configured: true, label: 'set here' },
        },
      },
    });
  });

  it('rejects invalid GitLab host values', async () => {
    const res = await createApp().request(
      '/api/setup/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.13' },
        body: JSON.stringify({
          token: 'setup-token',
          config: {
            gitlab: {
              host: 'http://gitlab.example.com/group',
              clientId: 'gitlab-client-id',
              clientSecret: 'gitlab-client-secret',
            },
          },
        }),
      },
      createEnv(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      details: {
        errors: [
          'GitLab host must use HTTPS unless it points to localhost',
          'GitLab host must not include credentials, a path, query string, or fragment',
        ],
      },
    });
  });

  it('rejects invalid setup token without writing config', async () => {
    const env = createEnv();
    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.14' },
        body: JSON.stringify({
          token: 'wrong-token',
          config: { google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' } },
        }),
      },
      env,
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'UNAUTHORIZED' });
    const written = await env.DATABASE.prepare(
      "SELECT value FROM platform_settings WHERE key = 'integration.google.clientId'"
    ).first<{ value: string }>();
    expect(written).toBeUndefined();
  });

  it('does not persist partial config when setup completion validation fails', async () => {
    const env = createEnv({ GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined });
    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.15' },
        body: JSON.stringify({ token: 'setup-token', config: { github: { appId: '12345' } } }),
      },
      env,
    );

    expect(res.status).toBe(400);
    const appId = await env.DATABASE.prepare(
      "SELECT value FROM platform_settings WHERE key = 'integration.github.appId'"
    ).first<{ value: string }>();
    const completed = await env.DATABASE.prepare(
      "SELECT value FROM platform_settings WHERE key = 'setup.completed'"
    ).first<{ value: string }>();
    expect(appId).toBeUndefined();
    expect(completed).toBeUndefined();
  });


  it('rolls back setup config when the transactional completion write fails', async () => {
    const env = createEnv();
    const originalPrepare = env.DATABASE.prepare.bind(env.DATABASE);
    env.DATABASE.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      const originalBind = statement.bind.bind(statement);
      statement.bind = ((...values: unknown[]) => {
        const bound = originalBind(...values);
        if (values[0] === 'setup.completed') {
          const originalRun = bound.run.bind(bound);
          bound.run = async () => {
            await originalRun();
            throw new Error('forced completion write failure');
          };
        }
        return bound;
      }) as D1PreparedStatement['bind'];
      return statement;
    }) as D1Database['prepare'];

    const res = await createApp().request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.17' },
        body: JSON.stringify({
          token: 'setup-token',
          config: { google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' } },
        }),
      },
      env,
    );

    expect(res.status).toBe(500);
    const clientId = await env.DATABASE.prepare(
      "SELECT value FROM platform_settings WHERE key = 'integration.google.clientId'"
    ).first<{ value: string }>();
    const completed = await env.DATABASE.prepare(
      "SELECT value FROM platform_settings WHERE key = 'setup.completed'"
    ).first<{ value: string }>();
    expect(clientId).toBeUndefined();
    expect(completed).toBeUndefined();
  });

  it('updates the existing platform integration secret row during forced setup completion', async () => {
    const env = createEnv({ SETUP_FORCE: 'true' });
    const app = createApp();

    const first = await app.request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.18' },
        body: JSON.stringify({
          token: 'setup-token',
          config: { google: { clientId: 'google-client-id', clientSecret: 'google-client-secret-1' } },
        }),
      },
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/setup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.19' },
        body: JSON.stringify({
          token: 'setup-token',
          config: { google: { clientId: 'google-client-id', clientSecret: 'google-client-secret-2' } },
        }),
      },
      env,
    );
    expect(second.status).toBe(200);

    const rows = await env.DATABASE.prepare(
      `SELECT encrypted_token AS encryptedToken, iv FROM platform_credentials
       WHERE credential_type = 'platform-integration'
         AND provider = 'google'
         AND credential_kind = 'google.clientSecret'`
    ).all<{ encryptedToken: string; iv: string }>();

    expect(rows.results).toHaveLength(1);
    await expect(decrypt(rows.results[0].encryptedToken, rows.results[0].iv, env.ENCRYPTION_KEY)).resolves.toBe(
      'google-client-secret-2'
    );
  });


  it('treats replayed setup completion as closed without changing public response shape', async () => {
    const env = createEnv();
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.16' },
      body: JSON.stringify({
        token: 'setup-token',
        config: { google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' } },
      }),
    };

    const first = await createApp().request('/api/setup/complete', request, env);
    expect(first.status).toBe(200);

    const second = await createApp().request('/api/setup/complete', request, env);
    expect(second.status).toBe(410);
    await expect(second.json()).resolves.toMatchObject({ error: 'SETUP_CLOSED' });
  });

});
