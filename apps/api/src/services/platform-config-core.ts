import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { encrypt } from './encryption';
import {
  creatorId,
  ENV_KEYS,
  INTEGRATION_CREDENTIAL_TYPE,
  readSetting,
  resolveSecret,
  resolveSetting,
  SECRET_KINDS,
  SETTING_KEYS,
  SETUP_COMPLETED_SETTING_KEY,
  trimOptional,
  writeSetting,
} from './platform-config-store';
import type {
  PlatformIntegrationInput,
  ResolvedPlatformConfig,
  ResolvedPlatformValue,
} from './platform-config-types';

/*
 * Core of the platform integration config: the per-isolate read cache, the resolver it fronts,
 * and the write path.
 *
 * The writers live here ON PURPOSE. `invalidatePlatformConfigCache` is module-private so that
 * every mutation of the data behind `ResolvedPlatformConfig` provably drops the cache in the same
 * file that owns it (see `.claude/rules/44-dual-write-migration-enumerate-writers.md`). Splitting
 * the write path into its own module would require exporting the invalidator and would lose that
 * guarantee, so this file sits above the 500-line advisory threshold by design.
 */

/**
 * Per-isolate cache TTL for the resolved platform config, in milliseconds.
 *
 * `resolvePlatformConfig` costs 14 D1 round-trips and sits on the auth preamble of every
 * authenticated request (`createAuth`), so it is exactly the "stable config" case the
 * per-isolate cache in `.claude/rules/60-request-io-and-bundle-budgets.md` exists for.
 * Platform OAuth config changes at most a handful of times in a deployment's lifetime.
 */
const DEFAULT_PLATFORM_CONFIG_CACHE_MS = 60_000;

export async function savePlatformIntegrationConfig(
  env: Env,
  input: PlatformIntegrationInput,
  updatedBy?: string
): Promise<ResolvedPlatformConfig> {
  const by = creatorId(env, updatedBy);
  const statements = await buildPlatformIntegrationStatements(
    env,
    input,
    by,
    new Date().toISOString()
  );
  if (statements.length === 0) return resolvePlatformConfig(env);
  try {
    if (typeof env.DATABASE.batch !== 'function') {
      if (input.googleInfrastructure) {
        throw new Error('Atomic infrastructure OAuth configuration is unavailable');
      }
      for (const statement of statements) await statement.run();
    } else {
      await env.DATABASE.batch(statements);
    }
  } finally {
    // `finally`, not the success path: the non-batch loop above can apply some statements and
    // then throw, so a failed save may still have changed the store.
    invalidatePlatformConfigCache();
  }
  return resolvePlatformConfig(env);
}

function settingStatement(
  env: Env,
  key: string,
  value: string,
  updatedBy: string,
  now: string
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, value, now, updatedBy);
}

function deleteSettingStatement(env: Env, key: string): D1PreparedStatement {
  return env.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?').bind(key);
}

async function secretUpsertStatement(
  env: Env,
  provider: string,
  kind: string,
  label: string,
  value: string,
  updatedBy: string,
  now: string
): Promise<D1PreparedStatement> {
  const encrypted = await encrypt(value, getCredentialEncryptionKey(env));
  const existing = await env.DATABASE.prepare(
    `SELECT id FROM platform_credentials
     WHERE credential_type = ? AND provider = ? AND credential_kind = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(INTEGRATION_CREDENTIAL_TYPE, provider, kind)
    .first<{ id: string }>();

  if (existing) {
    return env.DATABASE.prepare(
      `UPDATE platform_credentials
       SET label = ?, encrypted_token = ?, iv = ?, is_enabled = 1, updated_by = ?, updated_at = ?
       WHERE id = ?`
    ).bind(label, encrypted.ciphertext, encrypted.iv, updatedBy, now, existing.id);
  }

  return env.DATABASE.prepare(
    `INSERT INTO platform_credentials
       (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).bind(
    ulid(),
    INTEGRATION_CREDENTIAL_TYPE,
    provider,
    kind,
    label,
    encrypted.ciphertext,
    encrypted.iv,
    updatedBy,
    now,
    updatedBy,
    now
  );
}

async function buildPlatformIntegrationStatements(
  env: Env,
  input: PlatformIntegrationInput,
  updatedBy: string,
  now: string
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  const github = input.github ?? {};
  const google = input.google ?? {};
  const googleInfrastructure = input.googleInfrastructure ?? {};
  const gitlab = input.gitlab ?? {};
  const feedback = input.feedback ?? {};

  const githubClientId = trimOptional(github.clientId);
  if (githubClientId)
    statements.push(
      settingStatement(env, SETTING_KEYS.githubClientId, githubClientId, updatedBy, now)
    );

  const githubAppId = trimOptional(github.appId);
  if (githubAppId)
    statements.push(settingStatement(env, SETTING_KEYS.githubAppId, githubAppId, updatedBy, now));

  const githubAppSlug = trimOptional(github.appSlug);
  if (githubAppSlug)
    statements.push(
      settingStatement(env, SETTING_KEYS.githubAppSlug, githubAppSlug, updatedBy, now)
    );

  const googleClientId = trimOptional(google.clientId);
  if (googleClientId)
    statements.push(
      settingStatement(env, SETTING_KEYS.googleClientId, googleClientId, updatedBy, now)
    );

  if (googleInfrastructure.remove) {
    statements.push(
      env.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?').bind(
        SETTING_KEYS.googleInfrastructureClientId
      ),
      env.DATABASE.prepare(
        'DELETE FROM platform_credentials WHERE credential_type = ? AND provider = ? AND credential_kind = ?'
      ).bind(
        INTEGRATION_CREDENTIAL_TYPE,
        'google-infrastructure',
        SECRET_KINDS.googleInfrastructureClientSecret
      )
    );
  } else {
    const clientId = trimOptional(googleInfrastructure.clientId);
    if (clientId) {
      statements.push(
        settingStatement(env, SETTING_KEYS.googleInfrastructureClientId, clientId, updatedBy, now)
      );
    }
  }

  const gitlabHost = trimOptional(gitlab.host);
  if (gitlabHost)
    statements.push(settingStatement(env, SETTING_KEYS.gitlabHost, gitlabHost, updatedBy, now));

  const gitlabClientId = trimOptional(gitlab.clientId);
  if (gitlabClientId)
    statements.push(
      settingStatement(env, SETTING_KEYS.gitlabClientId, gitlabClientId, updatedBy, now)
    );

  if (feedback.remove) {
    statements.push(deleteSettingStatement(env, SETTING_KEYS.feedbackProjectId));
  } else {
    const feedbackProjectId = trimOptional(feedback.projectId);
    if (feedbackProjectId) {
      statements.push(
        settingStatement(env, SETTING_KEYS.feedbackProjectId, feedbackProjectId, updatedBy, now)
      );
    }
  }

  const githubClientSecret = trimOptional(github.clientSecret);
  if (githubClientSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'github',
        SECRET_KINDS.githubClientSecret,
        'GitHub OAuth client secret',
        githubClientSecret,
        updatedBy,
        now
      )
    );
  }

  const githubAppPrivateKey = trimOptional(github.appPrivateKey);
  if (githubAppPrivateKey) {
    statements.push(
      await secretUpsertStatement(
        env,
        'github',
        SECRET_KINDS.githubAppPrivateKey,
        'GitHub App private key',
        githubAppPrivateKey,
        updatedBy,
        now
      )
    );
  }

  const githubWebhookSecret = trimOptional(github.webhookSecret);
  if (githubWebhookSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'github',
        SECRET_KINDS.githubWebhookSecret,
        'GitHub webhook secret',
        githubWebhookSecret,
        updatedBy,
        now
      )
    );
  }

  const googleClientSecret = trimOptional(google.clientSecret);
  if (googleClientSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'google',
        SECRET_KINDS.googleClientSecret,
        'Google OAuth client secret',
        googleClientSecret,
        updatedBy,
        now
      )
    );
  }

  if (!googleInfrastructure.remove) {
    const clientSecret = trimOptional(googleInfrastructure.clientSecret);
    if (clientSecret) {
      statements.push(
        await secretUpsertStatement(
          env,
          'google-infrastructure',
          SECRET_KINDS.googleInfrastructureClientSecret,
          'Google infrastructure OAuth client secret',
          clientSecret,
          updatedBy,
          now
        )
      );
    }
  }

  const gitlabClientSecret = trimOptional(gitlab.clientSecret);
  if (gitlabClientSecret) {
    statements.push(
      await secretUpsertStatement(
        env,
        'gitlab',
        SECRET_KINDS.gitlabClientSecret,
        'GitLab client secret',
        gitlabClientSecret,
        updatedBy,
        now
      )
    );
  }

  return statements;
}

function runtimePreview(value: string): ResolvedPlatformValue {
  return { value, source: 'runtime', updatedAt: null, updatedBy: null };
}

function overlayPreview(
  target: ResolvedPlatformValue,
  value: string | undefined
): ResolvedPlatformValue {
  const trimmed = trimOptional(value);
  return trimmed ? runtimePreview(trimmed) : target;
}

export async function previewPlatformIntegrationConfig(
  env: Env,
  input: PlatformIntegrationInput
): Promise<ResolvedPlatformConfig> {
  const current = await resolvePlatformConfig(env);
  const github = input.github ?? {};
  const google = input.google ?? {};
  const googleInfrastructure = input.googleInfrastructure ?? {};
  const gitlab = input.gitlab ?? {};
  const feedback = input.feedback ?? {};

  return {
    github: {
      clientId: overlayPreview(current.github.clientId, github.clientId),
      clientSecret: overlayPreview(current.github.clientSecret, github.clientSecret),
      appId: overlayPreview(current.github.appId, github.appId),
      appPrivateKey: overlayPreview(current.github.appPrivateKey, github.appPrivateKey),
      appSlug: overlayPreview(current.github.appSlug, github.appSlug),
      webhookSecret: overlayPreview(current.github.webhookSecret, github.webhookSecret),
    },
    google: {
      clientId: overlayPreview(current.google.clientId, google.clientId),
      clientSecret: overlayPreview(current.google.clientSecret, google.clientSecret),
    },
    googleInfrastructure: {
      clientId: overlayPreview(
        current.googleInfrastructure.clientId,
        googleInfrastructure.clientId
      ),
      clientSecret: overlayPreview(
        current.googleInfrastructure.clientSecret,
        googleInfrastructure.clientSecret
      ),
    },
    gitlab: {
      host: overlayPreview(current.gitlab.host, gitlab.host),
      clientId: overlayPreview(current.gitlab.clientId, gitlab.clientId),
      clientSecret: overlayPreview(current.gitlab.clientSecret, gitlab.clientSecret),
    },
    feedback: {
      projectId: feedback.remove
        ? { value: null, source: 'unset', updatedAt: null, updatedBy: null }
        : overlayPreview(current.feedback.projectId, feedback.projectId),
    },
  };
}

export async function completeSetupWithConfig(
  env: Env,
  input: PlatformIntegrationInput,
  updatedBy?: string
): Promise<ResolvedPlatformConfig> {
  const by = creatorId(env, updatedBy);
  const now = new Date().toISOString();
  const statements = await buildPlatformIntegrationStatements(env, input, by, now);
  statements.push(settingStatement(env, SETUP_COMPLETED_SETTING_KEY, 'true', by, now));

  if (typeof env.DATABASE.batch === 'function') {
    try {
      await env.DATABASE.batch(statements);
    } finally {
      invalidatePlatformConfigCache();
    }
    return resolvePlatformConfig(env);
  }

  // Compatibility for minimal D1 shims that do not implement batch(). Production D1 applies batch transactionally.
  const resolved = await savePlatformIntegrationConfig(env, input, updatedBy);
  await setSetupCompleted(env, updatedBy);
  return resolved;
}

interface PlatformConfigCacheEntry {
  /**
   * The binding this entry was resolved from. A cached value is only ever served back to the
   * same `D1Database` object, so a config resolved from one datastore can never be handed to a
   * caller holding a different one (production isolates have exactly one binding; test suites
   * build a fresh in-memory D1 per case).
   */
  database: D1Database;
  config: ResolvedPlatformConfig;
  /** epoch ms when this entry becomes stale */
  expiresAt: number;
}

/**
 * Module-scoped cache — Workers re-use the isolate across requests within an instance, so this
 * gives the intended "last value for up to TTL" behaviour. Mirrors the established pattern in
 * `services/trial/kill-switch.ts`.
 */
let platformConfigCache: PlatformConfigCacheEntry | null = null;

/**
 * Bumped by every invalidation. A resolve captures this before its (slow, 14-round-trip) read
 * and may only publish its result if the value is unchanged when the read completes — otherwise
 * a write landed mid-read and this result is already stale. Without the compare-and-set, a slow
 * reader that started BEFORE a config write can finish AFTER it and overwrite the fresh entry
 * with the pre-write snapshot, which would silently reinstate a just-rotated secret for a full
 * TTL. See `.claude/rules/45-durable-object-concurrency-mutex.md` — the same check-then-act
 * across an `await` hazard, here in module scope rather than a Durable Object.
 */
let platformConfigCacheGeneration = 0;

/**
 * The read currently in flight for a given binding, so N concurrent misses on a cold or
 * just-expired isolate collapse into ONE 14-query read instead of N.
 */
let platformConfigInFlight: {
  database: D1Database;
  generation: number;
  promise: Promise<ResolvedPlatformConfig>;
} | null = null;

/** Exported for tests only. */
export function __resetPlatformConfigCacheForTest(): void {
  platformConfigCache = null;
  platformConfigInFlight = null;
  platformConfigCacheGeneration += 1;
}

/**
 * Drops the per-isolate cache. Called after every write that can change a resolved value so the
 * writing isolate observes its own write immediately. Other isolates converge within the TTL.
 *
 * Module-private: every writer of the data behind `ResolvedPlatformConfig` lives in this file
 * (`savePlatformIntegrationConfig`, `completeSetupWithConfig`). If a writer is ever added
 * elsewhere it must export this and call it — see `.claude/rules/44-dual-write-migration-enumerate-writers.md`.
 */
function invalidatePlatformConfigCache(): void {
  platformConfigCache = null;
  // Any read already in flight started before this write, so its result is stale: revoke its
  // right to publish, and make the next caller start a fresh read rather than join it.
  platformConfigInFlight = null;
  platformConfigCacheGeneration += 1;
}

/** Cache TTL in ms. `0` disables caching entirely (every call re-reads D1). */
export function resolvePlatformConfigCacheMs(env: Env): number {
  const configured = Number(env.PLATFORM_CONFIG_CACHE_MS ?? DEFAULT_PLATFORM_CONFIG_CACHE_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_PLATFORM_CONFIG_CACHE_MS;
}

/**
 * Resolves the platform integration config, serving a per-isolate cached copy when one is live.
 *
 * Costs 14 D1 round-trips on a miss; 0 on a hit. Callers that need several projections of the
 * config (`createAuth` needs three) should resolve once and use the `select*` helpers below
 * rather than calling the `get*` wrappers repeatedly.
 *
 * Unlike `services/trial/kill-switch.ts`, a failed read is deliberately NOT cached. That cache
 * stores its fail-closed default on error to throttle retries, which is safe because "trials
 * disabled" is a valid conservative answer. Here the equivalent would be caching "no OAuth
 * configured", which would disable every social login for a full TTL — strictly worse than
 * re-reading. A rejected read therefore propagates and populates nothing.
 */
export async function resolvePlatformConfig(
  env: Env,
  now: number = Date.now()
): Promise<ResolvedPlatformConfig> {
  // A missing binding is NOT a usable cache key: `undefined === undefined` would make every
  // database-less env share one entry. Such an env also resolves purely from `env` values
  // (`readSetting` / `resolveSecret` short-circuit when there is no `prepare`), so there is
  // nothing to save by caching it.
  const database = isCacheableBinding(env.DATABASE) ? env.DATABASE : null;

  const cached = platformConfigCache;
  if (database && cached && cached.database === database && now < cached.expiresAt) {
    return cached.config;
  }

  const ttl = resolvePlatformConfigCacheMs(env);
  if (!database || ttl <= 0) {
    const config = await readPlatformConfigFromStore(env);
    if (cached && cached.database === database) {
      // Caching is off for this binding — do not let a previous entry linger.
      platformConfigCache = null;
    }
    return config;
  }

  // Join a read already in flight for this same binding and generation rather than issuing a
  // second identical 14-query burst.
  const joinable = platformConfigInFlight;
  if (
    joinable &&
    joinable.database === database &&
    joinable.generation === platformConfigCacheGeneration
  ) {
    return joinable.promise;
  }

  const generation = platformConfigCacheGeneration;
  const promise = readPlatformConfigFromStore(env);
  platformConfigInFlight = { database, generation, promise };

  try {
    const config = await promise;
    if (platformConfigCacheGeneration === generation) {
      // No write landed while we were reading, so this result is still current: publish it.
      platformConfigCache = { database, config, expiresAt: now + ttl };
    }
    // If a write DID land, the caller still gets the config it read — it just does not become
    // the shared cached value, so the writer's fresher entry survives.
    return config;
  } finally {
    if (platformConfigInFlight?.promise === promise) {
      platformConfigInFlight = null;
    }
  }
}

function isCacheableBinding(database: D1Database | undefined): database is D1Database {
  return typeof database?.prepare === 'function';
}

async function readPlatformConfigFromStore(env: Env): Promise<ResolvedPlatformConfig> {
  const [
    githubClientId,
    githubClientSecret,
    githubAppId,
    githubAppPrivateKey,
    githubAppSlug,
    githubWebhookSecret,
    googleClientId,
    googleClientSecret,
    googleInfrastructureClientId,
    googleInfrastructureClientSecret,
    gitlabHost,
    gitlabClientId,
    gitlabClientSecret,
    feedbackProjectId,
  ] = await Promise.all([
    resolveSetting(env, SETTING_KEYS.githubClientId, ENV_KEYS.githubClientId),
    resolveSecret(env, 'github', SECRET_KINDS.githubClientSecret, ENV_KEYS.githubClientSecret),
    resolveSetting(env, SETTING_KEYS.githubAppId, ENV_KEYS.githubAppId),
    resolveSecret(env, 'github', SECRET_KINDS.githubAppPrivateKey, ENV_KEYS.githubAppPrivateKey),
    resolveSetting(env, SETTING_KEYS.githubAppSlug, ENV_KEYS.githubAppSlug),
    resolveSecret(env, 'github', SECRET_KINDS.githubWebhookSecret, ENV_KEYS.githubWebhookSecret),
    resolveSetting(env, SETTING_KEYS.googleClientId, ENV_KEYS.googleClientId),
    resolveSecret(env, 'google', SECRET_KINDS.googleClientSecret, ENV_KEYS.googleClientSecret),
    resolveSetting(
      env,
      SETTING_KEYS.googleInfrastructureClientId,
      ENV_KEYS.googleInfrastructureClientId
    ),
    resolveSecret(
      env,
      'google-infrastructure',
      SECRET_KINDS.googleInfrastructureClientSecret,
      ENV_KEYS.googleInfrastructureClientSecret
    ),
    resolveSetting(env, SETTING_KEYS.gitlabHost, ENV_KEYS.gitlabHost),
    resolveSetting(env, SETTING_KEYS.gitlabClientId, ENV_KEYS.gitlabClientId),
    resolveSecret(env, 'gitlab', SECRET_KINDS.gitlabClientSecret, ENV_KEYS.gitlabClientSecret),
    resolveSetting(env, SETTING_KEYS.feedbackProjectId, ENV_KEYS.feedbackProjectId),
  ]);

  return {
    github: {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      appId: githubAppId,
      appPrivateKey: githubAppPrivateKey,
      appSlug: githubAppSlug,
      webhookSecret: githubWebhookSecret,
    },
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    },
    googleInfrastructure: {
      clientId: googleInfrastructureClientId,
      clientSecret: googleInfrastructureClientSecret,
    },
    gitlab: {
      host: gitlabHost,
      clientId: gitlabClientId,
      clientSecret: gitlabClientSecret,
    },
    feedback: {
      projectId: feedbackProjectId,
    },
  };
}

export async function isSetupCompleted(env: Env): Promise<boolean> {
  const forced = env.SETUP_FORCE === 'true';
  if (forced) return false;
  const row = await readSetting(env, SETUP_COMPLETED_SETTING_KEY);
  return row.value === 'true';
}

export async function setSetupCompleted(env: Env, updatedBy?: string): Promise<void> {
  await writeSetting(env, SETUP_COMPLETED_SETTING_KEY, 'true', creatorId(env, updatedBy));
}
