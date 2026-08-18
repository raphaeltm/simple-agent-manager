import type { Env } from '../env';
import { resolvePlatformConfig } from './platform-config-core';
import type { ResolvedPlatformConfig } from './platform-config-types';

/*
 * Selectors below are pure projections of an already-resolved config. Callers that need more
 * than one projection (notably `createAuth`) resolve once and select many, instead of paying
 * `resolvePlatformConfig`'s 13 D1 round-trips per projection. The `get*` wrappers keep the
 * single-projection call sites unchanged.
 */

export function selectGitHubOAuthConfig(
  config: ResolvedPlatformConfig
): { clientId: string; clientSecret: string } | null {
  if (!config.github.clientId.value || !config.github.clientSecret.value) return null;
  return { clientId: config.github.clientId.value, clientSecret: config.github.clientSecret.value };
}

export async function getGitHubOAuthConfig(
  env: Env
): Promise<{ clientId: string; clientSecret: string } | null> {
  return selectGitHubOAuthConfig(await resolvePlatformConfig(env));
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.origin;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

export function selectGitLabOAuthConfig(config: ResolvedPlatformConfig): {
  host: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
} | null {
  if (
    !config.gitlab.host.value ||
    !config.gitlab.clientId.value ||
    !config.gitlab.clientSecret.value
  )
    return null;
  const host = normalizeBaseUrl(config.gitlab.host.value);
  return {
    host,
    apiBaseUrl: `${host}/api/v4`,
    clientId: config.gitlab.clientId.value,
    clientSecret: config.gitlab.clientSecret.value,
  };
}

export async function getGitLabOAuthConfig(env: Env): Promise<{
  host: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
} | null> {
  return selectGitLabOAuthConfig(await resolvePlatformConfig(env));
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
export function selectGoogleLoginOAuthConfig(
  config: ResolvedPlatformConfig
): { clientId: string; clientSecret: string } | null {
  if (!config.google.clientId.value || !config.google.clientSecret.value) return null;
  return { clientId: config.google.clientId.value, clientSecret: config.google.clientSecret.value };
}

export async function getGoogleLoginOAuthConfig(
  env: Env
): Promise<{ clientId: string; clientSecret: string } | null> {
  return selectGoogleLoginOAuthConfig(await resolvePlatformConfig(env));
}

/**
 * Infra/GCP Google OAuth client — used for GCP deployment authorization flows
 * (cloud-platform scope; redirect URIs `/auth/google/callback` and
 * `/api/deployment/gcp/callback`). Reads GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
 * from the independent runtime platform store first, then the legacy
 * GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET environment fallback. It never reads
 * or writes the Google login client family.
 */
export function selectGoogleInfraOAuthConfig(
  config: ResolvedPlatformConfig
): { clientId: string; clientSecret: string } | null {
  if (
    !config.googleInfrastructure.clientId.value ||
    !config.googleInfrastructure.clientSecret.value
  ) {
    return null;
  }
  return {
    clientId: config.googleInfrastructure.clientId.value,
    clientSecret: config.googleInfrastructure.clientSecret.value,
  };
}

export async function getGoogleInfraOAuthConfig(
  env: Env
): Promise<{ clientId: string; clientSecret: string } | null> {
  return selectGoogleInfraOAuthConfig(await resolvePlatformConfig(env));
}

export function selectGitHubAppConfig(config: ResolvedPlatformConfig): {
  appId: string;
  privateKey: string;
  slug: string | null;
} | null {
  if (!config.github.appId.value || !config.github.appPrivateKey.value) return null;
  return {
    appId: config.github.appId.value,
    privateKey: config.github.appPrivateKey.value,
    slug: config.github.appSlug.value,
  };
}

export async function getGitHubAppConfig(env: Env): Promise<{
  appId: string;
  privateKey: string;
  slug: string | null;
} | null> {
  return selectGitHubAppConfig(await resolvePlatformConfig(env));
}

export function selectGitHubWebhookSecret(config: ResolvedPlatformConfig): string | null {
  return config.github.webhookSecret.value;
}

export async function getGitHubWebhookSecret(env: Env): Promise<string | null> {
  return selectGitHubWebhookSecret(await resolvePlatformConfig(env));
}

export async function areGitHubTriggersConfigured(env: Env): Promise<boolean> {
  if (env.GITHUB_TRIGGERS_ENABLED === 'false') return false;
  if (env.GITHUB_TRIGGERS_ENABLED === 'true') return true;
  return Boolean(await getGitHubWebhookSecret(env));
}
