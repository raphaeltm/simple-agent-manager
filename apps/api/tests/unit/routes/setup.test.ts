import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { setupRoutes } from '../../../src/routes/setup';
import { generateEncryptionKey } from '../../../src/services/encryption';

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
});
