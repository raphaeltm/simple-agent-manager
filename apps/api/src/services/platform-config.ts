import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { decrypt, encrypt } from './encryption';
import type {
  IntegrationStatus,
  PlatformConfigSource,
  PlatformConfigStatus,
  PlatformIntegrationInput,
  ResolvedPlatformConfig,
  ResolvedPlatformValue,
} from './platform-config-types';

export type {
  IntegrationStatus,
  PlatformConfigSource,
  PlatformConfigStatus,
  PlatformIntegrationInput,
  ResolvedPlatformConfig,
  ResolvedPlatformValue,
} from './platform-config-types';

export const SETUP_COMPLETED_SETTING_KEY = 'setup.completed';
const INTEGRATION_CREDENTIAL_TYPE = 'platform-integration';

const SETTING_KEYS = {
  githubClientId: 'integration.github.clientId',
  githubAppId: 'integration.github.appId',
  githubAppSlug: 'integration.github.appSlug',
  googleClientId: 'integration.google.clientId',
  googleInfrastructureClientId: 'integration.googleInfrastructure.clientId',
  gitlabHost: 'integration.gitlab.host',
  gitlabClientId: 'integration.gitlab.clientId',
} as const;

const SECRET_KINDS = {
  githubClientSecret: 'github.clientSecret',
  githubAppPrivateKey: 'github.appPrivateKey',
  githubWebhookSecret: 'github.webhookSecret',
  googleClientSecret: 'google.clientSecret',
  googleInfrastructureClientSecret: 'googleInfrastructure.clientSecret',
  gitlabClientSecret: 'gitlab.clientSecret',
} as const;

const ENV_KEYS = {
  githubClientId: 'GITHUB_CLIENT_ID',
  githubClientSecret: 'GITHUB_CLIENT_SECRET',
  githubAppId: 'GITHUB_APP_ID',
  githubAppPrivateKey: 'GITHUB_APP_PRIVATE_KEY',
  githubAppSlug: 'GITHUB_APP_SLUG',
  githubWebhookSecret: 'GITHUB_WEBHOOK_SECRET',
  // Login Google OAuth client (BetterAuth social sign-in). Distinct from the
  // infra/GCP Google client (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) — different
  // OAuth app, redirect URI (/api/auth/callback/google), and scopes.
  googleClientId: 'GOOGLE_LOGIN_CLIENT_ID',
  googleClientSecret: 'GOOGLE_LOGIN_CLIENT_SECRET',
  googleInfrastructureClientId: 'GOOGLE_CLIENT_ID',
  googleInfrastructureClientSecret: 'GOOGLE_CLIENT_SECRET',
  gitlabHost: 'GITLAB_HOST',
  gitlabClientId: 'GITLAB_CLIENT_ID',
  gitlabClientSecret: 'GITLAB_CLIENT_SECRET',
} as const;

const DEFAULT_SETUP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_SETUP_RATE_LIMIT_MAX_ATTEMPTS = 10;

function envValue(env: Env, key: keyof Env): string | null {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function positiveIntegerEnv(env: Env, key: keyof Env, fallback: number): number {
  const parsed = Number.parseInt(envValue(env, key) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unset(): ResolvedPlatformValue {
  return { value: null, source: 'unset', updatedAt: null, updatedBy: null };
}

async function readSetting(env: Env, key: string): Promise<ResolvedPlatformValue> {
  const prepared = env.DATABASE?.prepare?.(
    'SELECT value, updated_at AS updatedAt, updated_by AS updatedBy FROM platform_settings WHERE key = ?'
  );
  const statement = prepared && typeof prepared.bind === 'function' ? prepared.bind(key) : null;
  if (!statement || typeof statement.first !== 'function') {
    return unset();
  }

  const row = await statement.first<{ value: string; updatedAt: string; updatedBy: string | null }>();

  if (!row || typeof row.value !== 'string' || !row.value.trim()) {
    return unset();
  }
  return {
    value: row.value,
    source: 'runtime',
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

async function writeSetting(env: Env, key: string, value: string, updatedBy: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, value, now, updatedBy).run();
}

async function resolveSetting(
  env: Env,
  settingKey: string,
  environmentKey: keyof Env
): Promise<ResolvedPlatformValue> {
  const runtime = await readSetting(env, settingKey);
  if (runtime.source === 'runtime') {
    return runtime;
  }

  const fallback = envValue(env, environmentKey);
  return fallback ? { value: fallback, source: 'environment', updatedAt: null, updatedBy: null } : unset();
}

async function resolveSecret(
  env: Env,
  provider: string,
  kind: string,
  environmentKey: keyof Env
): Promise<ResolvedPlatformValue> {
  const prepared = env.DATABASE?.prepare?.(
    `SELECT id, encrypted_token AS encryptedToken, iv, updated_at AS updatedAt, COALESCE(updated_by, created_by) AS updatedBy
     FROM platform_credentials
     WHERE credential_type = ? AND provider = ? AND credential_kind = ? AND is_enabled = 1
     ORDER BY updated_at DESC, created_at DESC`
  );
  const statement = prepared && typeof prepared.bind === 'function'
    ? prepared.bind(INTEGRATION_CREDENTIAL_TYPE, provider, kind)
    : null;

  const rows = typeof statement?.all === 'function'
    ? await statement.all<{
        id: string;
        encryptedToken: string;
        iv: string;
        updatedAt: string;
        updatedBy: string | null;
      }>()
    : { results: [] };
  const runtimeRows = rows.results ?? [];
  const encryptionKey = runtimeRows.length > 0 ? getCredentialEncryptionKey(env) : null;
  for (const row of runtimeRows) {
    try {
      if (!encryptionKey) {
        break;
      }
      const value = await decrypt(row.encryptedToken, row.iv, encryptionKey);
      if (value.trim()) {
        return {
          value,
          source: 'runtime',
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        };
      }
    } catch (err) {
      log.error('platform-config.runtime_secret_decrypt_failed', {
        id: row.id,
        provider,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fallback = envValue(env, environmentKey);
  return fallback ? { value: fallback, source: 'environment', updatedAt: null, updatedBy: null } : unset();
}

function creatorId(env: Env, updatedBy?: string): string {
  return updatedBy || env.TRIAL_ANONYMOUS_USER_ID || TRIAL_ANONYMOUS_USER_ID;
}

function trimOptional(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
    new Date().toISOString(),
  );
  if (statements.length === 0) return resolvePlatformConfig(env);
  if (typeof env.DATABASE.batch !== 'function') {
    if (input.googleInfrastructure) {
      throw new Error('Atomic infrastructure OAuth configuration is unavailable');
    }
    for (const statement of statements) await statement.run();
  } else {
    await env.DATABASE.batch(statements);
  }
  return resolvePlatformConfig(env);
}


function settingStatement(env: Env, key: string, value: string, updatedBy: string, now: string): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, value, now, updatedBy);
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
  ).bind(INTEGRATION_CREDENTIAL_TYPE, provider, kind).first<{ id: string }>();

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

  const githubClientId = trimOptional(github.clientId);
  if (githubClientId) statements.push(settingStatement(env, SETTING_KEYS.githubClientId, githubClientId, updatedBy, now));

  const githubAppId = trimOptional(github.appId);
  if (githubAppId) statements.push(settingStatement(env, SETTING_KEYS.githubAppId, githubAppId, updatedBy, now));

  const githubAppSlug = trimOptional(github.appSlug);
  if (githubAppSlug) statements.push(settingStatement(env, SETTING_KEYS.githubAppSlug, githubAppSlug, updatedBy, now));

  const googleClientId = trimOptional(google.clientId);
  if (googleClientId) statements.push(settingStatement(env, SETTING_KEYS.googleClientId, googleClientId, updatedBy, now));

  if (googleInfrastructure.remove) {
    statements.push(
      env.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
        .bind(SETTING_KEYS.googleInfrastructureClientId),
      env.DATABASE.prepare(
        'DELETE FROM platform_credentials WHERE credential_type = ? AND provider = ? AND credential_kind = ?',
      ).bind(
        INTEGRATION_CREDENTIAL_TYPE,
        'google-infrastructure',
        SECRET_KINDS.googleInfrastructureClientSecret,
      ),
    );
  } else {
    const clientId = trimOptional(googleInfrastructure.clientId);
    if (clientId) {
      statements.push(settingStatement(
        env,
        SETTING_KEYS.googleInfrastructureClientId,
        clientId,
        updatedBy,
        now,
      ));
    }
  }

  const gitlabHost = trimOptional(gitlab.host);
  if (gitlabHost) statements.push(settingStatement(env, SETTING_KEYS.gitlabHost, gitlabHost, updatedBy, now));

  const gitlabClientId = trimOptional(gitlab.clientId);
  if (gitlabClientId) statements.push(settingStatement(env, SETTING_KEYS.gitlabClientId, gitlabClientId, updatedBy, now));

  const githubClientSecret = trimOptional(github.clientSecret);
  if (githubClientSecret) {
    statements.push(await secretUpsertStatement(env, 'github', SECRET_KINDS.githubClientSecret, 'GitHub OAuth client secret', githubClientSecret, updatedBy, now));
  }

  const githubAppPrivateKey = trimOptional(github.appPrivateKey);
  if (githubAppPrivateKey) {
    statements.push(await secretUpsertStatement(env, 'github', SECRET_KINDS.githubAppPrivateKey, 'GitHub App private key', githubAppPrivateKey, updatedBy, now));
  }

  const githubWebhookSecret = trimOptional(github.webhookSecret);
  if (githubWebhookSecret) {
    statements.push(await secretUpsertStatement(env, 'github', SECRET_KINDS.githubWebhookSecret, 'GitHub webhook secret', githubWebhookSecret, updatedBy, now));
  }

  const googleClientSecret = trimOptional(google.clientSecret);
  if (googleClientSecret) {
    statements.push(await secretUpsertStatement(env, 'google', SECRET_KINDS.googleClientSecret, 'Google OAuth client secret', googleClientSecret, updatedBy, now));
  }

  if (!googleInfrastructure.remove) {
    const clientSecret = trimOptional(googleInfrastructure.clientSecret);
    if (clientSecret) {
      statements.push(await secretUpsertStatement(
        env,
        'google-infrastructure',
        SECRET_KINDS.googleInfrastructureClientSecret,
        'Google infrastructure OAuth client secret',
        clientSecret,
        updatedBy,
        now,
      ));
    }
  }

  const gitlabClientSecret = trimOptional(gitlab.clientSecret);
  if (gitlabClientSecret) {
    statements.push(await secretUpsertStatement(env, 'gitlab', SECRET_KINDS.gitlabClientSecret, 'GitLab client secret', gitlabClientSecret, updatedBy, now));
  }

  return statements;
}


function runtimePreview(value: string): ResolvedPlatformValue {
  return { value, source: 'runtime', updatedAt: null, updatedBy: null };
}

function overlayPreview(target: ResolvedPlatformValue, value: string | undefined): ResolvedPlatformValue {
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
        googleInfrastructure.clientId,
      ),
      clientSecret: overlayPreview(
        current.googleInfrastructure.clientSecret,
        googleInfrastructure.clientSecret,
      ),
    },
    gitlab: {
      host: overlayPreview(current.gitlab.host, gitlab.host),
      clientId: overlayPreview(current.gitlab.clientId, gitlab.clientId),
      clientSecret: overlayPreview(current.gitlab.clientSecret, gitlab.clientSecret),
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
    await env.DATABASE.batch(statements);
    return resolvePlatformConfig(env);
  }

  // Compatibility for minimal D1 shims that do not implement batch(). Production D1 applies batch transactionally.
  const resolved = await savePlatformIntegrationConfig(env, input, updatedBy);
  await setSetupCompleted(env, updatedBy);
  return resolved;
}

export async function resolvePlatformConfig(env: Env): Promise<ResolvedPlatformConfig> {
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
      ENV_KEYS.googleInfrastructureClientId,
    ),
    resolveSecret(
      env,
      'google-infrastructure',
      SECRET_KINDS.googleInfrastructureClientSecret,
      ENV_KEYS.googleInfrastructureClientSecret,
    ),
    resolveSetting(env, SETTING_KEYS.gitlabHost, ENV_KEYS.gitlabHost),
    resolveSetting(env, SETTING_KEYS.gitlabClientId, ENV_KEYS.gitlabClientId),
    resolveSecret(env, 'gitlab', SECRET_KINDS.gitlabClientSecret, ENV_KEYS.gitlabClientSecret),
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
  };
}

export async function getGitHubOAuthConfig(env: Env): Promise<{ clientId: string; clientSecret: string } | null> {
  const config = await resolvePlatformConfig(env);
  if (!config.github.clientId.value || !config.github.clientSecret.value) return null;
  return { clientId: config.github.clientId.value, clientSecret: config.github.clientSecret.value };
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.origin;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

export async function getGitLabOAuthConfig(env: Env): Promise<{
  host: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
} | null> {
  const config = await resolvePlatformConfig(env);
  if (!config.gitlab.host.value || !config.gitlab.clientId.value || !config.gitlab.clientSecret.value) return null;
  const host = normalizeBaseUrl(config.gitlab.host.value);
  return {
    host,
    apiBaseUrl: `${host}/api/v4`,
    clientId: config.gitlab.clientId.value,
    clientSecret: config.gitlab.clientSecret.value,
  };
}

/**
 * Login Google OAuth client — the BetterAuth "Sign in with Google" social
 * provider. Resolved from the setup-wizard platform store first, then the
 * login-specific GOOGLE_LOGIN_CLIENT_ID/GOOGLE_LOGIN_CLIENT_SECRET env fallback.
 * Its redirect URI is `https://api.{BASE_DOMAIN}/api/auth/callback/google`.
 *
 * This is intentionally SEPARATE from the infra/GCP Google client
 * (getGoogleInfraOAuthConfig) so configuring Google sign-in never rewires GCP
 * infrastructure access — they are different OAuth apps with different redirect
 * URIs and scopes.
 */
export async function getGoogleLoginOAuthConfig(env: Env): Promise<{ clientId: string; clientSecret: string } | null> {
  const config = await resolvePlatformConfig(env);
  if (!config.google.clientId.value || !config.google.clientSecret.value) return null;
  return { clientId: config.google.clientId.value, clientSecret: config.google.clientSecret.value };
}

/**
 * Infra/GCP Google OAuth client — used for GCP deployment authorization flows
 * (cloud-platform scope; redirect URIs `/auth/google/callback` and
 * `/api/deployment/gcp/callback`). Reads GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
 * from the independent runtime platform store first, then the legacy
 * GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET environment fallback. It never reads
 * or writes the Google login client family.
 */
export async function getGoogleInfraOAuthConfig(env: Env): Promise<{ clientId: string; clientSecret: string } | null> {
  const config = await resolvePlatformConfig(env);
  if (!config.googleInfrastructure.clientId.value || !config.googleInfrastructure.clientSecret.value) {
    return null;
  }
  return {
    clientId: config.googleInfrastructure.clientId.value,
    clientSecret: config.googleInfrastructure.clientSecret.value,
  };
}

export async function getGitHubAppConfig(env: Env): Promise<{
  appId: string;
  privateKey: string;
  slug: string | null;
} | null> {
  const config = await resolvePlatformConfig(env);
  if (!config.github.appId.value || !config.github.appPrivateKey.value) return null;
  return {
    appId: config.github.appId.value,
    privateKey: config.github.appPrivateKey.value,
    slug: config.github.appSlug.value,
  };
}

export async function getGitHubWebhookSecret(env: Env): Promise<string | null> {
  const config = await resolvePlatformConfig(env);
  return config.github.webhookSecret.value;
}

export async function areGitHubTriggersConfigured(env: Env): Promise<boolean> {
  if (env.GITHUB_TRIGGERS_ENABLED === 'false') return false;
  if (env.GITHUB_TRIGGERS_ENABLED === 'true') return true;
  return Boolean(await getGitHubWebhookSecret(env));
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

export function isSetupTokenConfigured(env: Env): boolean {
  return Boolean(env.SETUP_TOKEN && env.SETUP_TOKEN.trim());
}

function sourceLabel(source: PlatformConfigSource): string {
  if (source === 'runtime') return 'set here';
  if (source === 'environment') return 'set via environment fallback';
  return 'not configured';
}

function fieldStatus(value: ResolvedPlatformValue): Omit<ResolvedPlatformValue, 'value'> & { configured: boolean } {
  return {
    configured: Boolean(value.value),
    source: value.source,
    updatedAt: value.updatedAt ?? null,
    updatedBy: value.updatedBy ?? null,
  };
}

function integrationStatus(
  fields: Record<string, ResolvedPlatformValue>,
  required: string[]
): IntegrationStatus {
  const configured = required.every((key) => Boolean(fields[key]?.value));
  const sources = required.map((key) => fields[key]?.source ?? 'unset');
  const source: PlatformConfigSource = sources.includes('runtime')
    ? 'runtime'
    : sources.includes('environment')
      ? 'environment'
      : 'unset';
  return {
    configured,
    source,
    label: sourceLabel(source),
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fieldStatus(value)])),
  };
}

export async function getPlatformConfigStatus(env: Env): Promise<PlatformConfigStatus> {
  const config = await resolvePlatformConfig(env);
  return {
    setupCompleted: await isSetupCompleted(env),
    setupForced: env.SETUP_FORCE === 'true',
    integrations: {
      githubOAuth: integrationStatus(
        { clientId: config.github.clientId, clientSecret: config.github.clientSecret },
        ['clientId', 'clientSecret']
      ),
      githubApp: integrationStatus(
        { appId: config.github.appId, appPrivateKey: config.github.appPrivateKey, appSlug: config.github.appSlug },
        ['appId', 'appPrivateKey']
      ),
      githubWebhook: integrationStatus(
        { webhookSecret: config.github.webhookSecret },
        ['webhookSecret']
      ),
      googleOAuth: integrationStatus(
        { clientId: config.google.clientId, clientSecret: config.google.clientSecret },
        ['clientId', 'clientSecret']
      ),
      googleInfrastructureOAuth: integrationStatus(
        {
          clientId: config.googleInfrastructure.clientId,
          clientSecret: config.googleInfrastructure.clientSecret,
        },
        ['clientId', 'clientSecret']
      ),
      gitlabOAuth: integrationStatus(
        { host: config.gitlab.host, clientId: config.gitlab.clientId, clientSecret: config.gitlab.clientSecret },
        ['host', 'clientId', 'clientSecret']
      ),
    },
  };
}

async function stableHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export async function verifySetupToken(
  env: Env,
  submittedToken: string,
  identifier: string
): Promise<{ ok: true } | { ok: false; status: 401 | 429; message: string }> {
  const token = env.SETUP_TOKEN?.trim();
  if (!token) {
    return { ok: false, status: 401, message: 'Setup token is not configured' };
  }

  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = positiveIntegerEnv(
    env,
    'SETUP_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_SETUP_RATE_LIMIT_WINDOW_SECONDS
  );
  const maxAttempts = positiveIntegerEnv(env, 'SETUP_RATE_LIMIT_MAX_ATTEMPTS', DEFAULT_SETUP_RATE_LIMIT_MAX_ATTEMPTS);
  const windowStart = now - windowSeconds;
  const key = `setup.rateLimit.${await stableHash(identifier || 'unknown')}`;

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, json_object('windowStart', ?, 'count', 0), CURRENT_TIMESTAMP, ?)`
  ).bind(key, now, creatorId(env)).run();

  const result = await env.DATABASE.prepare(
    `UPDATE platform_settings
     SET value = CASE
       WHEN CAST(json_extract(value, '$.windowStart') AS INTEGER) < ?
         THEN json_object('windowStart', ?, 'count', 1)
       ELSE json_object('windowStart', CAST(json_extract(value, '$.windowStart') AS INTEGER), 'count', CAST(json_extract(value, '$.count') AS INTEGER) + 1)
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE key = ?
       AND (
         CAST(json_extract(value, '$.windowStart') AS INTEGER) < ?
         OR CAST(json_extract(value, '$.count') AS INTEGER) < ?
       )`
  ).bind(windowStart, now, key, windowStart, maxAttempts).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    return { ok: false, status: 429, message: 'Too many setup token attempts. Try again later.' };
  }

  if (!constantTimeEqual(submittedToken.trim(), token)) {
    return { ok: false, status: 401, message: 'Invalid setup token' };
  }

  return { ok: true };
}
