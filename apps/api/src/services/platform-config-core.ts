import type { Env } from '../env';
import { resolveD1BindingIdentity } from '../lib/d1-session';
import {
  commitAdminSettingsStatements,
  resolveAdminSettingDetailsMany,
  validateAdminSettingsChanges,
} from './admin-settings';
import type { AdminSettingName } from './admin-settings-registry';
import { DEFAULT_CONFIG_READ_TIMEOUT_MS } from './config-read-deadline';
import { withDeadline } from './fetch-timeout';
import {
  buildPlatformIntegrationStatements,
  settingStatement,
} from './platform-config-statements';
import {
  creatorId,
  ENV_KEYS,
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
 * file that owns it (see `.claude/rules/44-dual-write-migration-enumerate-writers.md`). Statement construction is split out, but every public writer and invalidation remain together
 * so no writer can forget the cache-generation fence.
 */

/**
 * Per-isolate cache TTL for the resolved platform config, in milliseconds.
 *
 * `resolvePlatformConfig` costs five D1 round-trips for the fields outside Phase 1 and sits on the auth preamble of every
 * authenticated request (`createAuth`), so it is exactly the "stable config" case the
 * per-isolate cache in `.claude/rules/60-request-io-and-bundle-budgets.md` exists for.
 * Platform OAuth config changes at most a handful of times in a deployment's lifetime.
 */
const DEFAULT_PLATFORM_CONFIG_CACHE_MS = 60_000;

/*
 * The writers below return nothing ON PURPOSE. A `ResolvedPlatformConfig` carries every platform
 * secret as plaintext `.value`, and `PUT /api/setup/config` once echoed a writer's result straight
 * into its response body. Callers that need to report state use `getPlatformConfigStatus`, which
 * projects to booleans and source labels.
 */

export async function savePlatformIntegrationConfig(
  env: Env,
  input: PlatformIntegrationInput,
  updatedBy?: string
): Promise<void> {
  const by = creatorId(env, updatedBy);
  const expectedRevision = await validateAdminSettingsChanges(env, integrationChanges(input));
  const statements = await buildPlatformIntegrationStatements(
    env,
    input,
    by,
    new Date().toISOString()
  );
  if (statements.length === 0) return;
  try {
    await commitAdminSettingsStatements(env, {
      statements,
      changes: integrationAuditChanges(input),
      actorUserId: by,
      expectedRevision,
    });
  } finally {
    invalidatePlatformConfigCache();
  }
}

function integrationAuditChanges(
  input: PlatformIntegrationInput
): Array<{ name: AdminSettingName; action: 'set' | 'reset' }> {
  const changes: Array<{ name: AdminSettingName; action: 'set' | 'reset' }> = [];
  for (const provider of ['github', 'google', 'googleInfrastructure', 'gitlab'] as const) {
    const config = input[provider];
    if (!config) continue;
    for (const field of provider === 'gitlab'
      ? ['host', 'clientId', 'clientSecret']
      : ['clientId', 'clientSecret']) {
      const removed = provider === 'googleInfrastructure' && input.googleInfrastructure?.remove;
      if (removed || trimOptional((config as Record<string, string | undefined>)[field])) {
        changes.push({
          name: `integration.${provider}.${field}` as AdminSettingName,
          action: removed ? 'reset' : 'set',
        });
      }
    }
  }
  return changes;
}

function integrationChanges(input: PlatformIntegrationInput) {
  return integrationAuditChanges(input).map((change) => {
    const [, provider, field = ''] = change.name.split('.');
    const config = input[provider as 'github' | 'google' | 'googleInfrastructure' | 'gitlab'];
    return {
      name: change.name,
      value:
        change.action === 'reset'
          ? null
          : trimOptional((config as Record<string, string | undefined>)[field]),
    };
  });
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
): Promise<void> {
  const by = creatorId(env, updatedBy);
  const expectedRevision = await validateAdminSettingsChanges(env, integrationChanges(input));
  const now = new Date().toISOString();
  const statements = await buildPlatformIntegrationStatements(env, input, by, now);
  statements.push(settingStatement(env, SETUP_COMPLETED_SETTING_KEY, 'true', by, now));

  try {
    await commitAdminSettingsStatements(env, {
      statements,
      changes: integrationAuditChanges(input),
      actorUserId: by,
      expectedRevision,
    });
  } finally {
    invalidatePlatformConfigCache();
  }
}

interface PlatformConfigCacheEntry {
  /**
   * The binding this entry was resolved from. A cached value is only ever served back to the
   * same `D1Database` object, so a config resolved from one datastore can never be handed to a
   * caller holding a different one (test suites build a fresh in-memory D1 per case).
   *
   * This is the STABLE per-isolate binding, not whatever `env.DATABASE` happens to be: on the
   * Worker `fetch` path every request carries its own D1 session facade (`lib/d1-session.ts`),
   * so `resolvePlatformConfig` stores and compares `resolveD1BindingIdentity(env.DATABASE)`.
   * Keying on the facade would miss this cache on every request and pay the five-query read.
   */
  database: D1Database;
  config: ResolvedPlatformConfig;
  /** epoch ms when this entry becomes stale */
  expiresAt: number;
}

/**
 * Module-scoped cache — Workers re-use the isolate across requests within an instance, so this
 * gives the intended "last value for up to TTL" behaviour. `services/trial/kill-switch.ts` uses
 * the same module-scope shape but does NOT key on its binding; do not copy that half of it when
 * adding a cache over a binding whose identity can vary per request (see `database` below).
 */
let platformConfigCache: PlatformConfigCacheEntry | null = null;

/**
 * Bumped by every invalidation. A resolve captures this before its (slow, five-round-trip) read
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
 * just-expired isolate collapse into ONE five-query read instead of N.
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
    ? Math.min(configured, DEFAULT_PLATFORM_CONFIG_CACHE_MS)
    : DEFAULT_PLATFORM_CONFIG_CACHE_MS;
}

/**
 * Resolves the platform integration config, serving a per-isolate cached copy when one is live.
 *
 * Costs five D1 round-trips on a miss for the legacy fields; 0 on a hit. Callers that need several projections of the
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
  const fields = (['github', 'google', 'googleInfrastructure', 'gitlab'] as const).flatMap(
    (provider) =>
      (provider === 'gitlab'
        ? ['host', 'clientId', 'clientSecret']
        : ['clientId', 'clientSecret']
      ).map((field) => ({
        provider,
        field,
        name: `integration.${provider}.${field}` as AdminSettingName,
      }))
  );
  const settings = await resolveAdminSettingDetailsMany(env, [
    ...fields.map((item) => item.name),
    'performance.configReadTimeoutMs',
  ]);
  const timeoutMs = Number(settings.at(-1)?.value ?? DEFAULT_CONFIG_READ_TIMEOUT_MS);
  const legacy = await resolveLegacyPlatformConfig(env, now, timeoutMs);
  const config = structuredClone(legacy);
  fields.forEach(({ provider, field }, index) => {
    const setting = settings[index];
    if (!setting) throw new Error('Platform settings are unavailable.');
    let source: ResolvedPlatformValue['source'] = 'environment';
    if (setting.source === 'database') source = 'runtime';
    else if (setting.source === 'default') source = 'unset';
    (config[provider] as unknown as Record<string, ResolvedPlatformValue>)[field] = {
      value: typeof setting.value === 'string' ? setting.value : null,
      source,
      updatedAt: setting.updatedAt,
      updatedBy: setting.updatedBy,
    };
  });
  return config;
}

async function resolveLegacyPlatformConfig(
  env: Env,
  now: number = Date.now(),
  timeoutMs = DEFAULT_CONFIG_READ_TIMEOUT_MS
): Promise<ResolvedPlatformConfig> {
  // A missing binding is NOT a usable cache key: `undefined === undefined` would make every
  // database-less env share one entry. Such an env also resolves purely from `env` values
  // (`readSetting` / `resolveSecret` short-circuit when there is no `prepare`), so there is
  // nothing to save by caching it.
  //
  // The key MUST be the stable per-isolate binding, not `env.DATABASE` itself: the Worker
  // `fetch` entry point hands every request a fresh request-scoped D1 session facade
  // (`lib/d1-session.ts`), and keying on the facade would miss this cache on EVERY request
  // and pay the five-round-trip read below each time. `resolveD1BindingIdentity` unwraps the
  // facade; it returns a raw binding unchanged. Reads still go through `env.DATABASE`, so a
  // cache miss is served by the caller's session.
  const database = isCacheableBinding(env.DATABASE) ? resolveD1BindingIdentity(env.DATABASE) : null;

  const cached = platformConfigCache;
  if (database && cached && cached.database === database && now < cached.expiresAt) {
    return cached.config;
  }

  const ttl = resolvePlatformConfigCacheMs(env);
  if (!database || ttl <= 0) {
    const config = await withDeadline(() => readPlatformConfigFromStore(env), timeoutMs);
    if (cached && cached.database === database) {
      // Caching is off for this binding — do not let a previous entry linger.
      platformConfigCache = null;
    }
    return config;
  }

  // Join a read already in flight for this same binding and generation rather than issuing a
  // second identical five-query burst.
  const joinable = platformConfigInFlight;
  if (
    joinable &&
    joinable.database === database &&
    joinable.generation === platformConfigCacheGeneration
  ) {
    return joinable.promise;
  }

  const generation = platformConfigCacheGeneration;
  const promise = withDeadline(() => readPlatformConfigFromStore(env), timeoutMs);
  platformConfigInFlight = { database, generation, promise };

  try {
    const config = await promise;
    if (platformConfigCacheGeneration === generation) {
      // No write landed while we were reading, so this result is still current: publish it.
      platformConfigCache = { database, config, expiresAt: now + ttl };
    }
    if (platformConfigCacheGeneration !== generation) return resolveLegacyPlatformConfig(env);
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
  // Phase 1 OAuth fields are overlaid by the shared resolver. Read only the
  // app/webhook/feedback fields that remain outside that registry here.
  const [githubAppId, githubAppPrivateKey, githubAppSlug, githubWebhookSecret, feedbackProjectId] =
    await Promise.all([
      resolveSetting(env, SETTING_KEYS.githubAppId, ENV_KEYS.githubAppId),
      resolveSecret(env, 'github', SECRET_KINDS.githubAppPrivateKey, ENV_KEYS.githubAppPrivateKey),
      resolveSetting(env, SETTING_KEYS.githubAppSlug, ENV_KEYS.githubAppSlug),
      resolveSecret(env, 'github', SECRET_KINDS.githubWebhookSecret, ENV_KEYS.githubWebhookSecret),
      resolveSetting(env, SETTING_KEYS.feedbackProjectId, ENV_KEYS.feedbackProjectId),
    ]);
  const empty: ResolvedPlatformValue = {
    value: null,
    source: 'unset',
    updatedAt: null,
    updatedBy: null,
  };

  return {
    github: {
      clientId: { ...empty },
      clientSecret: { ...empty },
      appId: githubAppId,
      appPrivateKey: githubAppPrivateKey,
      appSlug: githubAppSlug,
      webhookSecret: githubWebhookSecret,
    },
    google: {
      clientId: { ...empty },
      clientSecret: { ...empty },
    },
    googleInfrastructure: {
      clientId: { ...empty },
      clientSecret: { ...empty },
    },
    gitlab: {
      host: { ...empty },
      clientId: { ...empty },
      clientSecret: { ...empty },
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
