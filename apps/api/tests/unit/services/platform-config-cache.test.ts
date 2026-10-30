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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuth } from '../../../src/auth';
import type { Env } from '../../../src/env';
import { withRequestScopedD1Bindings } from '../../../src/lib/d1-session';
import { encrypt } from '../../../src/services/encryption';
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
import {
  createCountingD1,
  createEnv,
  createSchema,
  type D1SessionEnv,
  QUERIES_PER_RESOLVE,
} from '../../helpers/platform-config-counting-fixture';

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
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
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
    expect(counterB.platformConfigReads().length).toBeGreaterThan(0);
    expect(counterB.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
    expect(counterA.platformConfigReads().length).toBeGreaterThan(0);
    expect(counterA.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
  });

  it('fails closed without authoritative storage and cannot poison a real binding', async () => {
    const noDb = { BASE_DOMAIN: 'example.com', GITHUB_CLIENT_ID: 'stale' } as Env;
    await expect(resolvePlatformConfig(noDb)).rejects.toThrow('Admin settings are unavailable');
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
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);

    counter.reset();
    await resolvePlatformConfig(env, start + ttl - 1);
    expect(counter.platformConfigReads()).toHaveLength(0);

    counter.reset();
    await resolvePlatformConfig(env, start + ttl);
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
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

    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
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
    // A caller must not receive obsolete OAuth configuration after a completed save.
    expect((await staleRead).github.clientId.value).toBe('new-secret');

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
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
    expect(a).toStrictEqual(b);
    expect(b).toStrictEqual(c);
  });

  it('rejects a non-atomic storage adapter without partially saving', async () => {
    const sqlite = createSchema();
    const { db, counter } = createCountingD1(sqlite);
    // A D1 adapter without batch cannot satisfy the atomic write contract.
    const noBatchDb = {
      prepare: db.prepare.bind(db),
    } as unknown as D1Database;
    const { env } = createEnv();
    const shimEnv = { ...env, DATABASE: noBatchDb } as Env;

    await resolvePlatformConfig(shimEnv);
    counter.reset();

    // Refuse before any partial write; invalidate cached readers after ambiguous errors.
    await expect(
      savePlatformIntegrationConfig(
        shimEnv,
        { googleInfrastructure: { clientId: 'infra-client', clientSecret: 'infra-secret' } },
        'admin-user'
      )
    ).rejects.toThrow(/Admin settings are unavailable/);

    counter.reset();
    await resolvePlatformConfig(shimEnv);
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
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

/**
 * The per-isolate cache is keyed on the D1 binding OBJECT. The Worker `fetch` entry point now
 * hands every request a fresh request-scoped D1 session facade (`lib/d1-session.ts`), so if the
 * key were `env.DATABASE` itself the cache would miss on EVERY request and pay the 14-query
 * read below each time — turning a latency fix into a 14-round-trip regression on every
 * authenticated request. `resolvePlatformConfig` therefore keys on
 * `resolveD1BindingIdentity(env.DATABASE)`.
 */
describe('platform config cache survives request-scoped D1 session facades', () => {
  it('hits the cache across two requests that each get their own session facade', async () => {
    const { env, counter } = createEnv();

    const firstRequestEnv = withRequestScopedD1Bindings(env as unknown as D1SessionEnv) as Env;
    const secondRequestEnv = withRequestScopedD1Bindings(env as unknown as D1SessionEnv) as Env;
    // Liveness: these really are distinct facades, not the same object handed back twice.
    expect(firstRequestEnv.DATABASE).not.toBe(secondRequestEnv.DATABASE);
    expect(firstRequestEnv.DATABASE).not.toBe(env.DATABASE);

    const first = await resolvePlatformConfig(firstRequestEnv);
    expect(first.github.clientId.value).toBe('env-gh-client');
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);

    counter.reset();
    const second = await resolvePlatformConfig(secondRequestEnv);

    expect(second.github.clientId.value).toBe('env-gh-client');
    expect(counter.platformConfigReads()).toHaveLength(0);
  });

  it('a facade and the raw binding share one cache entry', async () => {
    const { env, counter } = createEnv();

    await resolvePlatformConfig(env);
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);

    counter.reset();
    const scoped = withRequestScopedD1Bindings(env as unknown as D1SessionEnv) as Env;
    const second = await resolvePlatformConfig(scoped);

    // Value first: "zero queries" is also satisfied by a cache that hands back undefined.
    expect(second.github.clientId.value).toBe('env-gh-client');
    expect(counter.platformConfigReads()).toHaveLength(0);
  });

  it('still reads through the session facade on a cold miss', async () => {
    const { env, counter } = createEnv();
    const scoped = withRequestScopedD1Bindings(env as unknown as D1SessionEnv) as Env;

    const config = await resolvePlatformConfig(scoped);

    // The counting adapter only records statements issued through its own `prepare`, and the
    // facade routes `prepare` through the session — so a non-zero count here also proves the
    // session path reaches the same engine.
    expect(config.github.clientId.value).toBe('env-gh-client');
    expect(counter.platformConfigReads().length).toBeGreaterThan(0);
    expect(counter.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
  });

  it('does not share a cache entry across two DIFFERENT databases', async () => {
    const { env: envA } = createEnv();
    const { env: envB, counter: counterB } = createEnv({ GITHUB_CLIENT_ID: 'other-gh-client' });

    await resolvePlatformConfig(
      withRequestScopedD1Bindings(envA as unknown as D1SessionEnv) as Env
    );
    counterB.reset();

    const b = await resolvePlatformConfig(
      withRequestScopedD1Bindings(envB as unknown as D1SessionEnv) as Env
    );

    expect(b.github.clientId.value).toBe('other-gh-client');
    expect(counterB.platformConfigReads().length).toBeGreaterThan(0);
    expect(counterB.platformConfigReads().length).toBeLessThanOrEqual(QUERIES_PER_RESOLVE);
  });
});

it('evicts a hung legacy-config read and never publishes its late stale snapshot', async () => {
  vi.useFakeTimers();
  try {
    const { env, counter } = createEnv();
    await env.DATABASE.prepare(
      "INSERT INTO platform_settings (key,value,updated_at,updated_by) VALUES ('integration.github.appSlug','old','now','admin')"
    ).run();
    await env.DATABASE.prepare(
      "INSERT INTO platform_settings (key,value,updated_at,updated_by) VALUES ('performance.configReadTimeoutMs','100','now','admin')"
    ).run();
    await resolvePlatformConfig(env);
    __resetPlatformConfigCacheForTest();
    const gate = counter.stall();
    const stalled = resolvePlatformConfig(env);
    const failure = expect(stalled).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(101);
    await failure;
    gate.disarm();
    await env.DATABASE.prepare(
      "UPDATE platform_settings SET value='fresh' WHERE key='integration.github.appSlug'"
    ).run();
    expect((await resolvePlatformConfig(env)).github.appSlug.value).toBe('fresh');
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await resolvePlatformConfig(env)).github.appSlug.value).toBe('fresh');
  } finally {
    vi.useRealTimers();
  }
});
