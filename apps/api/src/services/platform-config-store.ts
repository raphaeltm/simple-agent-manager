import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt } from './encryption';
import type { ResolvedPlatformValue } from './platform-config-types';

/*
 * Storage layer for the platform integration config: the `platform_settings` /
 * `platform_credentials` reads and writes, the runtime-key <-> environment-key maps, and the
 * small env helpers they share. Deliberately cache-unaware — the per-isolate cache and its
 * invalidation live in `platform-config-core.ts` alongside the writers that must invalidate it.
 */

export const SETUP_COMPLETED_SETTING_KEY = 'setup.completed';
export const INTEGRATION_CREDENTIAL_TYPE = 'platform-integration';

export const SETTING_KEYS = {
  githubClientId: 'integration.github.clientId',
  githubAppId: 'integration.github.appId',
  githubAppSlug: 'integration.github.appSlug',
  googleClientId: 'integration.google.clientId',
  googleInfrastructureClientId: 'integration.googleInfrastructure.clientId',
  gitlabHost: 'integration.gitlab.host',
  gitlabClientId: 'integration.gitlab.clientId',
} as const;

export const SECRET_KINDS = {
  githubClientSecret: 'github.clientSecret',
  githubAppPrivateKey: 'github.appPrivateKey',
  githubWebhookSecret: 'github.webhookSecret',
  googleClientSecret: 'google.clientSecret',
  googleInfrastructureClientSecret: 'googleInfrastructure.clientSecret',
  gitlabClientSecret: 'gitlab.clientSecret',
} as const;

export const ENV_KEYS = {
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

function envValue(env: Env, key: keyof Env): string | null {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function positiveIntegerEnv(env: Env, key: keyof Env, fallback: number): number {
  const parsed = Number.parseInt(envValue(env, key) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unset(): ResolvedPlatformValue {
  return { value: null, source: 'unset', updatedAt: null, updatedBy: null };
}

export async function readSetting(env: Env, key: string): Promise<ResolvedPlatformValue> {
  const prepared = env.DATABASE?.prepare?.(
    'SELECT value, updated_at AS updatedAt, updated_by AS updatedBy FROM platform_settings WHERE key = ?'
  );
  const statement = prepared && typeof prepared.bind === 'function' ? prepared.bind(key) : null;
  if (!statement || typeof statement.first !== 'function') {
    return unset();
  }

  const row = await statement.first<{
    value: string;
    updatedAt: string;
    updatedBy: string | null;
  }>();

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

export async function writeSetting(
  env: Env,
  key: string,
  value: string,
  updatedBy: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  )
    .bind(key, value, now, updatedBy)
    .run();
}

export async function resolveSetting(
  env: Env,
  settingKey: string,
  environmentKey: keyof Env
): Promise<ResolvedPlatformValue> {
  const runtime = await readSetting(env, settingKey);
  if (runtime.source === 'runtime') {
    return runtime;
  }

  const fallback = envValue(env, environmentKey);
  return fallback
    ? { value: fallback, source: 'environment', updatedAt: null, updatedBy: null }
    : unset();
}

export async function resolveSecret(
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
  const statement =
    prepared && typeof prepared.bind === 'function'
      ? prepared.bind(INTEGRATION_CREDENTIAL_TYPE, provider, kind)
      : null;

  const rows =
    typeof statement?.all === 'function'
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
  return fallback
    ? { value: fallback, source: 'environment', updatedAt: null, updatedBy: null }
    : unset();
}

export function creatorId(env: Env, updatedBy?: string): string {
  return updatedBy || env.TRIAL_ANONYMOUS_USER_ID || TRIAL_ANONYMOUS_USER_ID;
}

export function trimOptional(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
