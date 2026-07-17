import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { generateEncryptionKey } from '../../../src/services/encryption';
import {
  getGitLabOAuthConfig,
  getGoogleInfraOAuthConfig,
  getGoogleLoginOAuthConfig,
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
    GITHUB_CLIENT_ID: 'env-gh-client',
    GITHUB_CLIENT_SECRET: 'env-gh-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'env-private-key',
    GITHUB_APP_SLUG: 'env-app-slug',
    GITHUB_WEBHOOK_SECRET: 'env-webhook-secret',
    GITLAB_HOST: 'https://gitlab.example.com/',
    GITLAB_CLIENT_ID: 'env-gitlab-client',
    GITLAB_CLIENT_SECRET: 'env-gitlab-secret',
    // Infra/GCP Google client (kept separate from login).
    GOOGLE_CLIENT_ID: 'env-google-infra-client',
    GOOGLE_CLIENT_SECRET: 'env-google-infra-secret',
    // Login Google client (BetterAuth social sign-in).
    GOOGLE_LOGIN_CLIENT_ID: 'env-google-login-client',
    GOOGLE_LOGIN_CLIENT_SECRET: 'env-google-login-secret',
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
    expect(config.google.clientId).toMatchObject({ value: 'env-google-login-client', source: 'environment' });
    expect(config.gitlab.host).toMatchObject({ value: 'https://gitlab.example.com/', source: 'environment' });
    expect(config.gitlab.clientId).toMatchObject({ value: 'env-gitlab-client', source: 'environment' });
  });

  it('resolves login Google and infra Google from independent env vars', async () => {
    const env = createEnv();

    // Login Google resolves from GOOGLE_LOGIN_* (and the setup-wizard store).
    const login = await getGoogleLoginOAuthConfig(env);
    expect(login).toEqual({ clientId: 'env-google-login-client', clientSecret: 'env-google-login-secret' });

    // Infra/GCP Google resolves from GOOGLE_* directly.
    const infra = await getGoogleInfraOAuthConfig(env);
    expect(infra).toEqual({ clientId: 'env-google-infra-client', clientSecret: 'env-google-infra-secret' });

    // Saving a login Google client via the setup wizard must NOT change infra.
    await savePlatformIntegrationConfig(
      env,
      { google: { clientId: 'runtime-login-client', clientSecret: 'runtime-login-secret' } },
      'admin-1'
    );
    expect(await getGoogleLoginOAuthConfig(env)).toEqual({
      clientId: 'runtime-login-client',
      clientSecret: 'runtime-login-secret',
    });
    // Infra is unaffected by the login-store write.
    expect(await getGoogleInfraOAuthConfig(env)).toEqual({
      clientId: 'env-google-infra-client',
      clientSecret: 'env-google-infra-secret',
    });
  });

  it('resolves runtime infrastructure OAuth before env without changing Google login', async () => {
    const env = createEnv();
    await savePlatformIntegrationConfig(env, {
      googleInfrastructure: {
        clientId: 'runtime-infra-client',
        clientSecret: 'runtime-infra-secret',
      },
    }, 'admin-1');

    await expect(getGoogleInfraOAuthConfig(env)).resolves.toEqual({
      clientId: 'runtime-infra-client',
      clientSecret: 'runtime-infra-secret',
    });
    await expect(getGoogleLoginOAuthConfig(env)).resolves.toEqual({
      clientId: 'env-google-login-client',
      clientSecret: 'env-google-login-secret',
    });
    await expect(getPlatformConfigStatus(env)).resolves.toMatchObject({
      integrations: {
        googleInfrastructureOAuth: {
          configured: true,
          source: 'runtime',
          fields: {
            clientId: { updatedBy: 'admin-1' },
            clientSecret: { updatedBy: 'admin-1' },
          },
        },
      },
    });
  });

  it('atomically removes runtime infrastructure OAuth and reveals env fallback', async () => {
    const env = createEnv();
    await savePlatformIntegrationConfig(env, {
      googleInfrastructure: {
        clientId: 'runtime-infra-client',
        clientSecret: 'runtime-infra-secret',
      },
    }, 'admin-1');

    await savePlatformIntegrationConfig(
      env,
      { googleInfrastructure: { remove: true } },
      'admin-2',
    );

    await expect(getGoogleInfraOAuthConfig(env)).resolves.toEqual({
      clientId: 'env-google-infra-client',
      clientSecret: 'env-google-infra-secret',
    });
    const runtimeSetting = await env.DATABASE.prepare(
      "SELECT value FROM platform_settings WHERE key = 'integration.googleInfrastructure.clientId'",
    ).first();
    const runtimeSecret = await env.DATABASE.prepare(
      "SELECT id FROM platform_credentials WHERE provider = 'google-infrastructure'",
    ).first();
    expect(runtimeSetting).toBeFalsy();
    expect(runtimeSecret).toBeFalsy();
  });

  it('leaves the previous infrastructure pair usable when the atomic batch fails', async () => {
    const env = createEnv();
    await savePlatformIntegrationConfig(env, {
      googleInfrastructure: {
        clientId: 'stable-infra-client',
        clientSecret: 'stable-infra-secret',
      },
    }, 'admin-1');
    await env.DATABASE.prepare(
      `CREATE TRIGGER reject_infrastructure_rotation
       BEFORE UPDATE ON platform_credentials
       WHEN OLD.provider = 'google-infrastructure'
       BEGIN
         SELECT RAISE(ABORT, 'injected batch failure');
       END`,
    ).run();

    await expect(savePlatformIntegrationConfig(env, {
      googleInfrastructure: {
        clientId: 'replacement-client',
        clientSecret: 'replacement-secret',
      },
    }, 'admin-2')).rejects.toThrow('injected batch failure');

    await expect(getGoogleInfraOAuthConfig(env)).resolves.toEqual({
      clientId: 'stable-infra-client',
      clientSecret: 'stable-infra-secret',
    });
  });

  it('returns null for login Google when only infra Google env is set', async () => {
    const env = createEnv({ GOOGLE_LOGIN_CLIENT_ID: undefined, GOOGLE_LOGIN_CLIENT_SECRET: undefined });
    // Infra creds present, but login must not borrow them.
    expect(await getGoogleInfraOAuthConfig(env)).not.toBeNull();
    expect(await getGoogleLoginOAuthConfig(env)).toBeNull();
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
      gitlab: {
        host: 'https://gitlab.runtime.example.com/',
        clientId: 'runtime-gitlab-client',
        clientSecret: 'runtime-gitlab-secret',
      },
    }, 'admin-1');

    const config = await resolvePlatformConfig(env);
    expect(config.github.clientId).toMatchObject({ value: 'runtime-gh-client', source: 'runtime' });
    expect(config.github.clientSecret).toMatchObject({ value: 'runtime-gh-secret', source: 'runtime' });
    expect(config.github.appId).toMatchObject({ value: '98765', source: 'runtime' });
    expect(config.google.clientSecret).toMatchObject({ value: 'runtime-google-secret', source: 'runtime' });
    expect(config.gitlab.host).toMatchObject({ value: 'https://gitlab.runtime.example.com/', source: 'runtime' });
    expect(config.gitlab.clientSecret).toMatchObject({ value: 'runtime-gitlab-secret', source: 'runtime' });

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
    expect(secretRow?.encryptedToken).not.toBe('runtime-gitlab-secret');
    expect(secretRow?.encryptedToken).not.toContain('runtime-gitlab-secret');

    await expect(getGitLabOAuthConfig(env)).resolves.toEqual({
      host: 'https://gitlab.runtime.example.com',
      apiBaseUrl: 'https://gitlab.runtime.example.com/api/v4',
      clientId: 'runtime-gitlab-client',
      clientSecret: 'runtime-gitlab-secret',
    });
  });

  it('returns null GitLab OAuth config when the host is missing', async () => {
    const env = createEnv({ GITLAB_HOST: undefined });
    await expect(getGitLabOAuthConfig(env)).resolves.toBeNull();
  });

  it('returns null GitLab OAuth config when the client id is missing', async () => {
    const env = createEnv({ GITLAB_CLIENT_ID: undefined });
    await expect(getGitLabOAuthConfig(env)).resolves.toBeNull();
  });

  it('returns null GitLab OAuth config when the client secret is missing', async () => {
    const env = createEnv({ GITLAB_CLIENT_SECRET: undefined });
    await expect(getGitLabOAuthConfig(env)).resolves.toBeNull();
  });

  it('normalizes a GitLab host with a path down to its origin', async () => {
    const env = createEnv({ GITLAB_HOST: 'https://gitlab.example.com/some/path?x=1' });
    await expect(getGitLabOAuthConfig(env)).resolves.toMatchObject({
      host: 'https://gitlab.example.com',
      apiBaseUrl: 'https://gitlab.example.com/api/v4',
    });
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
    expect(status.integrations.githubApp).toMatchObject({ configured: true, label: 'set via environment fallback' });
    expect(status.integrations.googleOAuth).toMatchObject({ configured: true, label: 'set here' });
    expect(status.integrations.gitlabOAuth).toMatchObject({ configured: true, label: 'set via environment fallback' });
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

  it('uses configured setup token rate limit values', async () => {
    const env = createEnv({
      SETUP_RATE_LIMIT_MAX_ATTEMPTS: '1',
      SETUP_RATE_LIMIT_WINDOW_SECONDS: '60',
    });

    await expect(verifySetupToken(env, 'wrong', '203.0.113.7')).resolves.toMatchObject({ status: 401 });
    await expect(verifySetupToken(env, 'setup-token', '203.0.113.7')).resolves.toMatchObject({
      ok: false,
      status: 429,
    });
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
