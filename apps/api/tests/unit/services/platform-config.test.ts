import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { generateEncryptionKey } from '../../../src/services/encryption';
import {
  getPlatformConfigStatus,
  isSetupCompleted,
  resolvePlatformConfig,
  savePlatformIntegrationConfig,
  verifySetupToken,
} from '../../../src/services/platform-config';

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
    GITHUB_CLIENT_ID: 'env-gh-client',
    GITHUB_CLIENT_SECRET: 'env-gh-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'env-private-key',
    GITHUB_APP_SLUG: 'env-app-slug',
    GITHUB_WEBHOOK_SECRET: 'env-webhook-secret',
    GOOGLE_CLIENT_ID: 'env-google-client',
    GOOGLE_CLIENT_SECRET: 'env-google-secret',
    SETUP_TOKEN: 'setup-token',
    ...overrides,
  } as Env;
}

describe('platform config resolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to environment values when runtime config is absent', async () => {
    const config = await resolvePlatformConfig(createEnv());
    expect(config.github.clientId).toMatchObject({ value: 'env-gh-client', source: 'environment' });
    expect(config.github.clientSecret).toMatchObject({ value: 'env-gh-secret', source: 'environment' });
    expect(config.google.clientId).toMatchObject({ value: 'env-google-client', source: 'environment' });
  });

  it('uses runtime settings and encrypted secrets before environment fallback', async () => {
    const env = createEnv();
    await savePlatformIntegrationConfig(env, {
      github: {
        clientId: 'runtime-gh-client',
        clientSecret: 'runtime-gh-secret',
        appId: '98765',
        appPrivateKey: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        appSlug: 'runtime-app',
        webhookSecret: 'runtime-webhook-secret',
      },
      google: {
        clientId: 'runtime-google-client',
        clientSecret: 'runtime-google-secret',
      },
    }, 'admin-1');

    const config = await resolvePlatformConfig(env);
    expect(config.github.clientId).toMatchObject({ value: 'runtime-gh-client', source: 'runtime' });
    expect(config.github.clientSecret).toMatchObject({ value: 'runtime-gh-secret', source: 'runtime' });
    expect(config.github.appId).toMatchObject({ value: '98765', source: 'runtime' });
    expect(config.google.clientSecret).toMatchObject({ value: 'runtime-google-secret', source: 'runtime' });
  });

  it('skips an undecryptable runtime secret and falls back to env instead of throwing', async () => {
    const env = createEnv();
    await env.DATABASE.prepare(
      `INSERT INTO platform_credentials
       (id, credential_type, provider, credential_kind, label, encrypted_token, iv, created_by)
       VALUES ('bad-1', 'platform-integration', 'github', 'github.clientSecret', 'bad', 'not-base64', 'not-base64', 'system_anonymous_trials')`
    ).run();

    await expect(resolvePlatformConfig(env)).resolves.toMatchObject({
      github: { clientSecret: { value: 'env-gh-secret', source: 'environment' } },
    });
  });

  it('reports effective source labels for admin UI', async () => {
    const env = createEnv({ GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined });
    await savePlatformIntegrationConfig(env, {
      google: { clientId: 'runtime-google-client', clientSecret: 'runtime-google-secret' },
    }, 'admin-1');

    const status = await getPlatformConfigStatus(env);
    expect(status.integrations.githubOAuth).toMatchObject({ configured: false, label: 'not configured' });
    expect(status.integrations.githubApp).toMatchObject({ configured: true, label: 'set via GitHub secret' });
    expect(status.integrations.googleOAuth).toMatchObject({ configured: true, label: 'set here' });
  });

  it('rate-limits setup token attempts atomically via D1 rows', async () => {
    const env = createEnv();
    for (let i = 0; i < 10; i += 1) {
      await expect(verifySetupToken(env, 'wrong', '198.51.100.1')).resolves.toMatchObject({ status: 401 });
    }
    await expect(verifySetupToken(env, 'setup-token', '198.51.100.1')).resolves.toMatchObject({
      ok: false,
      status: 429,
    });
    await expect(verifySetupToken(env, 'setup-token', '198.51.100.2')).resolves.toEqual({ ok: true });
  });

  it('SETUP_FORCE reopens setup even after setup.completed=true', async () => {
    const env = createEnv();
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES ('setup.completed', 'true', 'admin-1')`
    ).run();

    await expect(isSetupCompleted(env)).resolves.toBe(true);
    await expect(isSetupCompleted({ ...env, SETUP_FORCE: 'true' })).resolves.toBe(false);
  });
});
