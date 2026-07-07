import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import type { PlatformIntegrationInput, ResolvedPlatformConfig } from './platform-config';

const log = createModuleLogger('platform-config-validation');

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface PlatformConfigValidationResult {
  ok: boolean;
  errors: string[];
}

function present(value: string | null | undefined): boolean {
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

function validateOAuthClientId(value: string, provider: 'GitHub' | 'Google', errors: string[]): void {
  if (value.trim().length < 6) {
    errors.push(`${provider} OAuth client id is too short`);
  }
}

function validateSecret(value: string, provider: 'GitHub' | 'Google', errors: string[]): void {
  if (value.trim().length < 8) {
    errors.push(`${provider} OAuth client secret is too short`);
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

async function pingGoogleOAuth(clientId: string, clientSecret: string, baseDomain: string): Promise<string | null> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: 'sam-setup-validation',
      redirect_uri: `https://api.${baseDomain}/api/auth/callback/google`,
      grant_type: 'authorization_code',
    }),
  });
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

  if (present(github.clientId)) validateOAuthClientId(github.clientId!, 'GitHub', errors);
  if (present(github.clientSecret)) validateSecret(github.clientSecret!, 'GitHub', errors);
  if (present(github.appId)) validateIntegerString(github.appId!, 'GitHub App id', errors);
  if (present(github.appSlug)) validateSlug(github.appSlug!, errors);
  if (present(github.appPrivateKey)) validatePem(github.appPrivateKey!, errors);
  if (present(github.webhookSecret) && github.webhookSecret!.trim().length < 16) {
    errors.push('GitHub webhook secret must be at least 16 characters');
  }

  if (present(google.clientId)) validateOAuthClientId(google.clientId!, 'Google', errors);
  if (present(google.clientSecret)) validateSecret(google.clientSecret!, 'Google', errors);

  if (present(github.clientId) && present(github.clientSecret)) {
    try {
      const error = await pingGitHubOAuth(github.clientId!, github.clientSecret!);
      if (error) errors.push(error);
    } catch (err) {
      log.warn('github_oauth_validation_ping_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (present(google.clientId) && present(google.clientSecret)) {
    try {
      const error = await pingGoogleOAuth(google.clientId!, google.clientSecret!, env.BASE_DOMAIN);
      if (error) errors.push(error);
    } catch (err) {
      log.warn('google_oauth_validation_ping_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateSetupCanComplete(config: ResolvedPlatformConfig): PlatformConfigValidationResult {
  const hasGitHub = Boolean(config.github.clientId.value && config.github.clientSecret.value);
  const hasGoogle = Boolean(config.google.clientId.value && config.google.clientSecret.value);
  if (!hasGitHub && !hasGoogle) {
    return {
      ok: false,
      errors: ['Configure at least one login provider before completing setup'],
    };
  }
  return { ok: true, errors: [] };
}
