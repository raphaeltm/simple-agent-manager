import { DEFAULT_GCP_API_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';
import type { PlatformIntegrationInput, ResolvedPlatformConfig } from './platform-config';

const log = createModuleLogger('platform-config-validation');

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface PlatformConfigValidationResult {
  ok: boolean;
  errors: string[];
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateIntegerString(value: string, field: string, errors: string[]): void {
  if (!/^\d+$/.test(value.trim())) {
    errors.push(`${field} must be a numeric id`);
  }
}

function validateSlug(value: string, errors: string[]): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/i.test(value.trim())) {
    errors.push('GitHub App slug must be a valid GitHub app slug');
  }
}

function validatePem(value: string, errors: string[]): void {
  const normalized = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  if (!normalized.includes('-----BEGIN') || !normalized.includes('PRIVATE KEY-----')) {
    errors.push('GitHub App private key must be a PEM private key');
  }
}

function validateOAuthClientId(value: string, provider: 'GitHub' | 'Google' | 'Google infrastructure' | 'GitLab', errors: string[]): void {
  if (value.trim().length < 6) {
    errors.push(`${provider} OAuth client id is too short`);
  }
}

function validateSecret(value: string, provider: 'GitHub' | 'Google' | 'Google infrastructure' | 'GitLab', errors: string[]): void {
  if (value.trim().length < 8) {
    errors.push(`${provider} OAuth client secret is too short`);
  }
}

function validateGitLabHost(value: string, errors: string[]): void {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    errors.push('GitLab host must be a valid URL');
    return;
  }

  const localhostHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const isLocalHttp = url.protocol === 'http:' && localhostHosts.includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    errors.push('GitLab host must use HTTPS unless it points to localhost');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    errors.push('GitLab host must not include credentials, a path, query string, or fragment');
  }
}

async function pingGitHubOAuth(clientId: string, clientSecret: string): Promise<string | null> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SAM-Setup',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: 'sam-setup-validation',
    }),
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (body?.error === 'incorrect_client_credentials') {
    return 'GitHub OAuth client id/secret were rejected';
  }
  return null;
}

async function pingGoogleOAuth(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  timeoutMs: number,
): Promise<string | null> {
  const response = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: 'sam-setup-validation',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  }, timeoutMs);
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (body?.error === 'invalid_client' || body?.error === 'unauthorized_client') {
    return 'Google OAuth client id/secret were rejected';
  }
  return null;
}

export async function validatePlatformIntegrationInput(
  env: Env,
  input: PlatformIntegrationInput
): Promise<PlatformConfigValidationResult> {
  const errors: string[] = [];
  const github = input.github ?? {};
  const google = input.google ?? {};
  const googleInfrastructure = input.googleInfrastructure ?? {};
  const gitlab = input.gitlab ?? {};
  const googleOAuthTimeoutMs = getTimeoutMs(
    env.GCP_API_TIMEOUT_MS,
    DEFAULT_GCP_API_TIMEOUT_MS,
  );

  if (present(github.clientId)) validateOAuthClientId(github.clientId, 'GitHub', errors);
  if (present(github.clientSecret)) validateSecret(github.clientSecret, 'GitHub', errors);
  if (present(github.appId)) validateIntegerString(github.appId, 'GitHub App id', errors);
  if (present(github.appSlug)) validateSlug(github.appSlug, errors);
  if (present(github.appPrivateKey)) validatePem(github.appPrivateKey, errors);
  if (present(github.webhookSecret) && github.webhookSecret.trim().length < 16) {
    errors.push('GitHub webhook secret must be at least 16 characters');
  }

  if (present(google.clientId)) validateOAuthClientId(google.clientId, 'Google', errors);
  if (present(google.clientSecret)) validateSecret(google.clientSecret, 'Google', errors);

  const infrastructureClientId = present(googleInfrastructure.clientId)
    ? googleInfrastructure.clientId
    : null;
  const infrastructureClientSecret = present(googleInfrastructure.clientSecret)
    ? googleInfrastructure.clientSecret
    : null;
  const hasInfrastructureClientId = infrastructureClientId !== null;
  const hasInfrastructureClientSecret = infrastructureClientSecret !== null;
  if (googleInfrastructure.remove && (hasInfrastructureClientId || hasInfrastructureClientSecret)) {
    errors.push('Google infrastructure OAuth removal cannot include replacement values');
  } else if (!googleInfrastructure.remove && hasInfrastructureClientId !== hasInfrastructureClientSecret) {
    errors.push('Google infrastructure OAuth client id and secret must be provided together');
  }
  if (infrastructureClientId !== null) {
    validateOAuthClientId(infrastructureClientId, 'Google infrastructure', errors);
  }
  if (infrastructureClientSecret !== null) {
    validateSecret(infrastructureClientSecret, 'Google infrastructure', errors);
  }

  if (present(gitlab.host)) validateGitLabHost(gitlab.host, errors);
  if (present(gitlab.clientId)) validateOAuthClientId(gitlab.clientId, 'GitLab', errors);
  if (present(gitlab.clientSecret)) validateSecret(gitlab.clientSecret, 'GitLab', errors);

  if (present(github.clientId) && present(github.clientSecret)) {
    try {
      const error = await pingGitHubOAuth(github.clientId, github.clientSecret);
      if (error) errors.push(error);
    } catch (err) {
      log.warn('github_oauth_validation_ping_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (present(google.clientId) && present(google.clientSecret)) {
    try {
      const error = await pingGoogleOAuth(
        google.clientId,
        google.clientSecret,
        `https://api.${env.BASE_DOMAIN}/api/auth/callback/google`,
        googleOAuthTimeoutMs,
      );
      if (error) errors.push(error);
    } catch (err) {
      log.warn('google_oauth_validation_ping_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (infrastructureClientId !== null && infrastructureClientSecret !== null) {
    try {
      const error = await pingGoogleOAuth(
        infrastructureClientId,
        infrastructureClientSecret,
        `https://api.${env.BASE_DOMAIN}/auth/google/callback`,
        googleOAuthTimeoutMs,
      );
      if (error) errors.push(error.replace('Google OAuth', 'Google infrastructure OAuth'));
    } catch (err) {
      log.warn('google_infrastructure_oauth_validation_ping_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateSetupCanComplete(config: ResolvedPlatformConfig): PlatformConfigValidationResult {
  const hasGitHub = Boolean(config.github.clientId.value && config.github.clientSecret.value);
  const hasGoogle = Boolean(config.google.clientId.value && config.google.clientSecret.value);
  const hasGitLab = Boolean(config.gitlab.host.value && config.gitlab.clientId.value && config.gitlab.clientSecret.value);
  if (!hasGitHub && !hasGoogle && !hasGitLab) {
    return {
      ok: false,
      errors: ['Configure at least one login provider before completing setup'],
    };
  }
  return { ok: true, errors: [] };
}
