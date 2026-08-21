/**
 * Auth-preamble D1 round-trip budget (`.claude/rules/60-request-io-and-bundle-budgets.md`).
 *
 * These tests are the discriminating guard for the "cache the auth preamble" fix. They count
 * REAL D1 statement executions against a real SQLite engine rather than asserting on mock call
 * arguments, so they fail if either half of the fix regresses:
 *
 *  - if `createAuth` goes back to awaiting three independent `get*OAuthConfig` helpers, the cold
 *    isolate count returns to 42 (3 x 14);
 *  - if the per-isolate cache is removed, the warm isolate count returns to 14.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../../src/auth';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { encrypt, generateEncryptionKey } from '../../../src/services/encryption';
import {
  __resetPlatformConfigCacheForTest,
  getGitHubAppConfig,
  getGitHubOAuthConfig,
  getGitHubWebhookSecret,
  getGitLabOAuthConfig,
  getGoogleInfraOAuthConfig,
  getGoogleLoginOAuthConfig,
  resolvePlatformConfig,
  resolvePlatformConfigCacheMs,
  savePlatformIntegrationConfig,
  selectGitHubAppConfig,
  selectGitHubOAuthConfig,
  selectGitHubWebhookSecret,
  selectGitLabOAuthConfig,
  selectGoogleInfraOAuthConfig,
  selectGoogleLoginOAuthConfig,
} from '../../../src/services/platform-config';
import {
  isSignupApprovalRequired,
  setSignupApprovalConfig,
} from '../../../src/services/signup-approval';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

/**
 * The exact number of D1 round-trips one `resolvePlatformConfig` costs: 8 `platform_settings`
 * reads + 6 `platform_credentials` reads.
 */
const QUERIES_PER_RESOLVE = 14;

interface QueryCounter {
  /** Every executed statement's SQL, in execution order. */
  executed: string[];
  /** Executions that read the platform config tables — the metric under budget. */
  platformConfigReads(): string[];
  reset(): void;
  /**
   * Stall every subsequent statement execution. `disarm()` lets later executions through while
   * keeping already-waiting ones blocked; `release()` unblocks those. Used to interleave a slow
   * in-flight read with a config write.
   */
  stall(): { disarm: () => void; release: () => void };
}

type AnyStatement = Record<string, unknown>;

/**
 * Wraps the shared `createSqliteD1` boundary adapter — a real SQL engine, drift-proof against
 * the drizzle schema — and records every executed statement's SQL. Delegating rather than
 * hand-rolling a shim keeps `.raw()` working for the drizzle-backed signup-approval reads.
 */
function createCountingD1(sqlite: Database.Database): { db: D1Database; counter: QueryCounter } {
  const inner = createSqliteD1(sqlite) as unknown as AnyStatement;
  const executed: string[] = [];
  let stallGate: Promise<void> | null = null;

  function wrapStatement(sql: string, statement: AnyStatement): AnyStatement {
    const wrapped: AnyStatement = { ...statement };

    for (const method of ['run', 'runSync', 'all', 'first', 'raw'] as const) {
      const original = statement[method];
      if (typeof original !== 'function') continue;
      const invoke = (...args: unknown[]) => {
        executed.push(sql);
        return (original as (...a: unknown[]) => unknown).apply(statement, args);
      };
      // `runSync` must stay synchronous (batch() calls it inside a SQLite transaction).
      wrapped[method] =
        method === 'runSync'
          ? invoke
          : async (...args: unknown[]) => {
              // Capture the gate synchronously at call time so every statement of a single
              // `Promise.all` burst is governed by the same one, then read the CURRENT data and
              // stall only the RETURN. That is what makes the caller's snapshot genuinely stale:
              // it read pre-write values but completes after the write landed.
              const gate = stallGate;
              const result = await invoke(...args);
              if (gate) await gate;
              return result;
            };
    }

    const originalBind = statement.bind;
    if (typeof originalBind === 'function') {
      wrapped.bind = (...params: unknown[]) =>
        wrapStatement(
          sql,
          (originalBind as (...a: unknown[]) => AnyStatement).apply(statement, params)
        );
    }

    return wrapped;
  }

  const db = {
    ...inner,
    prepare: (sql: string) =>
      wrapStatement(sql, (inner.prepare as (s: string) => AnyStatement)(sql)),
  } as unknown as D1Database;

  const counter: QueryCounter = {
    executed,
    platformConfigReads: () =>
      executed.filter(
        (sql) =>
          /^\s*SELECT/i.test(sql) &&
          (sql.includes('platform_settings') || sql.includes('platform_credentials'))
      ),
    reset: () => {
      executed.length = 0;
    },
    stall: () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      stallGate = gate;
      return {
        // Stop stalling NEW executions while leaving already-waiting ones blocked.
        disarm: () => {
          if (stallGate === gate) stallGate = null;
        },
        release,
      };
    },
  };

  return { db, counter };
}

function createSchema(): Database.Database {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.users, schema.platformSettings, schema.platformCredentials]);
  return sqlite;
}

function createEnv(overrides: Partial<Env> = {}): { env: Env; counter: QueryCounter } {
  const { db, counter } = createCountingD1(createSchema());
  const env = {
    DATABASE: db,
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
    GOOGLE_CLIENT_ID: 'env-google-infra-client',
    GOOGLE_CLIENT_SECRET: 'env-google-infra-secret',
    GOOGLE_LOGIN_CLIENT_ID: 'env-google-login-client',
    GOOGLE_LOGIN_CLIENT_SECRET: 'env-google-login-secret',
    ...overrides,
  } as Env;
  return { env, counter };
}

beforeEach(() => {
  __resetPlatformConfigCacheForTest();
});

afterEach(() => {
  __resetPlatformConfigCacheForTest();
});

describe('auth preamble D1 round-trip budget', () => {
  it('createAuth resolves the platform config exactly once on a cold isolate', async () => {
    const { env, counter } = createEnv();

    await createAuth(env);

    // Pre-fix this was 39: three sequential `get*OAuthConfig` helpers, each re-resolving.
    expect(counter.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);
  });

  it('createAuth costs zero platform-config queries on a warm isolate', async () => {
    const { env, counter } = createEnv();

    await createAuth(env);
    counter.reset();

    // A second `createAuth` in the same request (e.g. requireAuth then routes/auth.ts) or a
    // subsequent request on the same isolate must not touch D1 for platform config at all.
    await createAuth(env);
    await createAuth(env);

    expect(counter.platformConfigReads()).toHaveLength(0);
  });

  it('still produces identical social providers when served from cache', async () => {
    const { env } = createEnv();

    const cold = await createAuth(env);
    const warm = await createAuth(env);

    expect(Object.keys(warm.options.socialProviders ?? {}).sort()).toEqual(
      Object.keys(cold.options.socialProviders ?? {}).sort()
    );
    expect(Object.keys(warm.options.socialProviders ?? {}).sort()).toEqual([
      'github',
      'gitlab',
      'google',
    ]);
  });

  it('does not cache platform config across different D1 bindings', async () => {
    const { env: envA, counter: counterA } = createEnv({ GITHUB_CLIENT_ID: 'tenant-a-client' });
    const { env: envB, counter: counterB } = createEnv({ GITHUB_CLIENT_ID: 'tenant-b-client' });

    const a = await resolvePlatformConfig(envA);
    counterB.reset();
    const b = await resolvePlatformConfig(envB);

    expect(a.github.clientId.value).toBe('tenant-a-client');
    expect(b.github.clientId.value).toBe('tenant-b-client');
    // The second binding must pay a full resolve rather than inherit the first one's entry.
    expect(counterB.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);
    expect(counterA.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);
  });

  it('never caches an env without a usable D1 binding', async () => {
    // Regression: an earlier revision keyed the cache on `env.DATABASE` alone, so two envs with
    // no binding matched each other (`undefined === undefined`) and the second inherited the
    // first's config. `GET /api/config/login-providers` is called with exactly such envs.
    const noDb = (overrides: Partial<Env>) => ({ BASE_DOMAIN: 'example.com', ...overrides }) as Env;

    const first = await resolvePlatformConfig(noDb({ GITHUB_CLIENT_ID: 'first-client' }));
    const second = await resolvePlatformConfig(noDb({ GITHUB_CLIENT_ID: 'second-client' }));
    const none = await resolvePlatformConfig(noDb({}));

    expect(first.github.clientId.value).toBe('first-client');
    expect(second.github.clientId.value).toBe('second-client');
    expect(none.github.clientId.value).toBeNull();
  });

  it('a database-less env cannot poison a subsequent real binding', async () => {
    await resolvePlatformConfig({ BASE_DOMAIN: 'example.com', GITHUB_CLIENT_ID: 'stale' } as Env);

    const { env } = createEnv({ GITHUB_CLIENT_ID: 'real-client' });
    expect((await resolvePlatformConfig(env)).github.clientId.value).toBe('real-client');
  });
});

describe('platform config cache TTL', () => {
  it('serves the cached value inside the TTL and re-resolves after it expires', async () => {
    const { env, counter } = createEnv();
    const ttl = resolvePlatformConfigCacheMs(env);
    const start = 1_000_000;

    await resolvePlatformConfig(env, start);
    expect(counter.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);

    counter.reset();
    await resolvePlatformConfig(env, start + ttl - 1);
    expect(counter.platformConfigReads()).toHaveLength(0);

    counter.reset();
    await resolvePlatformConfig(env, start + ttl);
    expect(counter.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);
  });

  it('defaults to 60s and honours the PLATFORM_CONFIG_CACHE_MS override', () => {
    expect(resolvePlatformConfigCacheMs(createEnv().env)).toBe(60_000);
    expect(resolvePlatformConfigCacheMs(createEnv({ PLATFORM_CONFIG_CACHE_MS: '5000' }).env)).toBe(
      5_000
    );
    // Non-numeric / negative overrides fall back to the default rather than disabling silently.
    expect(resolvePlatformConfigCacheMs(createEnv({ PLATFORM_CONFIG_CACHE_MS: 'abc' }).env)).toBe(
      60_000
    );
    expect(resolvePlatformConfigCacheMs(createEnv({ PLATFORM_CONFIG_CACHE_MS: '-1' }).env)).toBe(
      60_000
    );
  });

  it('never caches when PLATFORM_CONFIG_CACHE_MS is 0', async () => {
    const { env, counter } = createEnv({ PLATFORM_CONFIG_CACHE_MS: '0' });

    await resolvePlatformConfig(env);
    counter.reset();
    await resolvePlatformConfig(env);

    expect(counter.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);
  });
});

describe('platform config cache invalidation', () => {
  it('observes a savePlatformIntegrationConfig write immediately, without waiting for the TTL', async () => {
    const { env } = createEnv();

    const before = await resolvePlatformConfig(env);
    expect(before.github.clientId).toMatchObject({
      value: 'env-gh-client',
      source: 'environment',
    });

    await savePlatformIntegrationConfig(
      env,
      { github: { clientId: 'runtime-gh-client' } },
      'admin-user'
    );

    const after = await resolvePlatformConfig(env);
    expect(after.github.clientId).toMatchObject({
      value: 'runtime-gh-client',
      source: 'runtime',
    });
  });

  it('rebuilds createAuth social providers after a write flips a provider on', async () => {
    // Start with GitLab unconfigured so the provider list is observably different post-write.
    const { env } = createEnv({
      GITLAB_HOST: undefined,
      GITLAB_CLIENT_ID: undefined,
      GITLAB_CLIENT_SECRET: undefined,
    });

    const before = await createAuth(env);
    expect(Object.keys(before.options.socialProviders ?? {})).not.toContain('gitlab');

    await savePlatformIntegrationConfig(
      env,
      {
        gitlab: {
          host: 'https://gitlab.example.com',
          clientId: 'runtime-gitlab-client',
          clientSecret: 'runtime-gitlab-secret',
        },
      },
      'admin-user'
    );

    const after = await createAuth(env);
    expect(Object.keys(after.options.socialProviders ?? {})).toContain('gitlab');
  });

  it('a slow in-flight read cannot clobber the fresher entry a concurrent write published', async () => {
    // Regression (found by review, empirically reproduced): `resolvePlatformConfig` is a
    // check-then-act across an await. A read that starts BEFORE a config write can finish AFTER
    // it and overwrite the writer's fresh cache entry with its own pre-write snapshot — silently
    // reinstating a just-rotated secret for a full TTL. Guarded by a generation compare-and-set.
    const { env, counter } = createEnv();

    // Seed the pre-write value so the stale reader has something distinct to read.
    await savePlatformIntegrationConfig(env, { github: { clientId: 'old-secret' } }, 'admin-user');
    __resetPlatformConfigCacheForTest();

    const gate = counter.stall();
    const staleRead = resolvePlatformConfig(env); // starts, blocks mid-read on the gate
    await Promise.resolve(); // let all 13 statements reach their await
    gate.disarm(); // the write below runs at full speed

    await savePlatformIntegrationConfig(env, { github: { clientId: 'new-secret' } }, 'admin-user');

    gate.release();
    // The stale reader still gets what IT read — that part is correct and unchanged.
    expect((await staleRead).github.clientId.value).toBe('old-secret');

    // ...but it must NOT have become the shared cached value.
    expect((await resolvePlatformConfig(env)).github.clientId.value).toBe('new-secret');
  });

  it('collapses concurrent cold-isolate misses into a single read', async () => {
    const { env, counter } = createEnv();

    const [a, b, c] = await Promise.all([
      resolvePlatformConfig(env),
      resolvePlatformConfig(env),
      resolvePlatformConfig(env),
    ]);

    // Without single-flight this would be 3 x 14 = 42.
    expect(counter.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('drops the cache even when a non-batch save fails part-way through', async () => {
    const sqlite = createSchema();
    const { db, counter } = createCountingD1(sqlite);
    // Minimal D1 shim without batch(), forcing the sequential statement loop.
    const noBatchDb = {
      prepare: db.prepare.bind(db),
    } as unknown as D1Database;
    const { env } = createEnv();
    const shimEnv = { ...env, DATABASE: noBatchDb } as Env;

    await resolvePlatformConfig(shimEnv);
    counter.reset();

    // googleInfrastructure without batch() support throws AFTER the config has been read but
    // before/while statements apply — the cache must not survive it.
    await expect(
      savePlatformIntegrationConfig(
        shimEnv,
        { googleInfrastructure: { clientId: 'infra-client', clientSecret: 'infra-secret' } },
        'admin-user'
      )
    ).rejects.toThrow(/Atomic infrastructure OAuth configuration is unavailable/);

    counter.reset();
    await resolvePlatformConfig(shimEnv);
    expect(counter.platformConfigReads()).toHaveLength(QUERIES_PER_RESOLVE);
  });
});

/**
 * The full account-denial matrix (active/pending/suspended x approval-on/off x
 * user/admin/superadmin) lives in `tests/unit/middleware/require-approved.test.ts` and is
 * unchanged by this work — `middleware/auth.ts` and `services/signup-approval.ts`'s assertion
 * helpers have no diff. What is asserted here is only the property this cache could plausibly
 * break: that the gate's own input is never served stale.
 */
describe('account-denial gates are not affected by the platform config cache', () => {
  it('re-reads the signup-approval gate from D1 on every call, even with platform config cached', async () => {
    const { env, counter } = createEnv();

    // Warm the platform config cache first.
    await createAuth(env);
    expect(await isSignupApprovalRequired(env)).toBe(false);

    // An admin turns approval ON. `.claude/rules/02-quality-gates.md` requires this to bind
    // immediately — a cached gate would keep already-signed-in pending accounts in for the TTL.
    await setSignupApprovalConfig(env, { requireApproval: true, updatedBy: 'admin-user' });

    counter.reset();
    expect(await isSignupApprovalRequired(env)).toBe(true);
    // And it genuinely hit D1 rather than any cache.
    expect(counter.executed.some((sql) => sql.includes('platform_settings'))).toBe(true);

    // Flipping it back off is likewise immediate.
    await setSignupApprovalConfig(env, { requireApproval: false, updatedBy: 'admin-user' });
    expect(await isSignupApprovalRequired(env)).toBe(false);
  });
});

describe('platform config selectors', () => {
  it('produce the same values as the async get* wrappers', async () => {
    const { env } = createEnv();
    const config = await resolvePlatformConfig(env);

    expect(selectGitHubOAuthConfig(config)).toEqual(await getGitHubOAuthConfig(env));
    expect(selectGitLabOAuthConfig(config)).toEqual(await getGitLabOAuthConfig(env));
    expect(selectGoogleLoginOAuthConfig(config)).toEqual(await getGoogleLoginOAuthConfig(env));
    expect(selectGoogleInfraOAuthConfig(config)).toEqual(await getGoogleInfraOAuthConfig(env));
    expect(selectGitHubAppConfig(config)).toEqual(await getGitHubAppConfig(env));
    expect(selectGitHubWebhookSecret(config)).toEqual(await getGitHubWebhookSecret(env));
  });

  it('return null when the underlying values are unset', async () => {
    const { env } = createEnv({
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
      GITLAB_HOST: undefined,
      GITLAB_CLIENT_ID: undefined,
      GITLAB_CLIENT_SECRET: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_LOGIN_CLIENT_ID: undefined,
      GOOGLE_LOGIN_CLIENT_SECRET: undefined,
    });
    const config = await resolvePlatformConfig(env);

    expect(selectGitHubOAuthConfig(config)).toBeNull();
    expect(selectGitLabOAuthConfig(config)).toBeNull();
    expect(selectGoogleLoginOAuthConfig(config)).toBeNull();
    expect(selectGoogleInfraOAuthConfig(config)).toBeNull();
    expect(selectGitHubAppConfig(config)).toBeNull();
    expect(selectGitHubWebhookSecret(config)).toBeNull();
  });

  it('reads runtime-stored secrets through the cache without re-decrypting from D1', async () => {
    const { env, counter } = createEnv();
    const encryptionKey = env.ENCRYPTION_KEY as string;
    const { ciphertext, iv } = await encrypt('runtime-gh-secret', encryptionKey);

    // `createSchemaTables` intentionally omits DEFAULT clauses, so is_enabled / timestamps
    // (which the resolver filters and orders by) must be supplied explicitly.
    await env.DATABASE.prepare(
      `INSERT INTO platform_credentials
       (id, credential_type, provider, credential_kind, label, encrypted_token, iv,
        is_enabled, created_by, created_at, updated_at)
       VALUES (?, 'platform-integration', 'github', 'github.clientSecret', 'gh', ?, ?,
               1, 'admin', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
      .bind('cred-1', ciphertext, iv)
      .run();

    const first = await resolvePlatformConfig(env);
    expect(first.github.clientSecret).toMatchObject({
      value: 'runtime-gh-secret',
      source: 'runtime',
    });

    counter.reset();
    const second = await resolvePlatformConfig(env);
    expect(second.github.clientSecret.value).toBe('runtime-gh-secret');
    expect(counter.platformConfigReads()).toHaveLength(0);
  });
});
