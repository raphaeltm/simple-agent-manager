import type { GcpCredential, GcpOidcCredential } from '@simple-agent-manager/shared';
import {
  DEFAULT_GCP_API_TIMEOUT_MS,
  DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL,
  DEFAULT_GCP_SA_IMPERSONATION_SCOPES,
  DEFAULT_GCP_SA_TOKEN_LIFETIME_SECONDS,
  DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_EXPIRY_SKEW_SECONDS,
  DEFAULT_GCP_STS_SCOPE,
  DEFAULT_GCP_STS_TOKEN_URL,
  DEFAULT_GCP_TOKEN_CACHE_TTL_SECONDS,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { GcpApiError } from './gcp-errors';
import {
  exchangeGcpServiceAccountAccessToken,
  type GcpAccessTokenResult,
} from './gcp-service-account';
import { signIdentityToken } from './jwt';

interface StsTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SaTokenResponse {
  accessToken: string;
  expireTime: string;
}

const stsTokenResponseSchema = v.object({
  access_token: v.string(),
  token_type: v.string(),
  expires_in: v.number(),
});

const saTokenResponseSchema = v.object({
  accessToken: v.string(),
  expireTime: v.string(),
});

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cacheKeyComponent(value: string): string {
  return encodeURIComponent(value);
}

function legacyCredentialCacheIdentity(credential: GcpCredential): string {
  if (credential.authType === 'service-account-key') {
    return `service-account-key:${credential.privateKeyId}`;
  }
  return `workload-identity:${credential.gcpProjectNumber}:${credential.wifPoolId}:${credential.wifProviderId}`;
}

function credentialCacheIdentity(credential: GcpCredential): string {
  if (credential.authType === 'service-account-key') {
    return legacyCredentialCacheIdentity(credential);
  }
  return `${legacyCredentialCacheIdentity(credential)}:${credential.serviceAccountEmail}`;
}

function gcpAccessTokenCachePrefix(
  userId: string,
  credential: GcpCredential,
  identity = credentialCacheIdentity(credential),
): string {
  return `gcp-token:v3:${cacheKeyComponent(userId)}:${cacheKeyComponent(credential.gcpProjectId)}:${cacheKeyComponent(identity)}:`;
}

export function getGcpAccessTokenCacheKey(
  userId: string,
  projectId: string,
  credential: GcpCredential,
): string {
  return `${gcpAccessTokenCachePrefix(userId, credential)}${cacheKeyComponent(projectId)}`;
}

/** Clear every project-scoped derivative token for one resolved credential identity. */
export async function clearGcpAccessTokenCache(
  env: Env,
  userId: string,
  credential: GcpCredential,
): Promise<void> {
  const prefixes = new Set([
    gcpAccessTokenCachePrefix(userId, credential),
    gcpAccessTokenCachePrefix(userId, credential, legacyCredentialCacheIdentity(credential)),
  ]);
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await env.KV.list({ prefix, ...(cursor ? { cursor } : {}) });
      await Promise.all(page.keys.map((key) => env.KV.delete(key.name)));
      if (page.list_complete) break;
      cursor = page.cursor;
    } while (cursor);
  }

  await Promise.all([
    env.KV.delete(
      `gcp-token:v2:${userId}:${credential.gcpProjectId}:${legacyCredentialCacheIdentity(credential)}`,
    ),
    env.KV.delete(`gcp-token:${userId}:${credential.gcpProjectId}`),
  ]);
}

/**
 * Get a short-lived GCP access token for either WIF or a service-account key.
 * Only the derivative access token is cached; the source credential remains in
 * encrypted D1 storage.
 */
export async function getGcpAccessToken(
  userId: string,
  projectId: string,
  credential: GcpCredential,
  env: Env,
): Promise<string> {
  const cacheKey = getGcpAccessTokenCacheKey(userId, projectId, credential);
  const cached = await env.KV.get(cacheKey);
  if (cached) return cached;

  const result = credential.authType === 'service-account-key'
    ? await exchangeGcpServiceAccountAccessToken(credential, env)
    : await exchangeGcpWifAccessToken(userId, projectId, credential, env);

  const configuredTtl = positiveInteger(
    env.GCP_TOKEN_CACHE_TTL_SECONDS,
    DEFAULT_GCP_TOKEN_CACHE_TTL_SECONDS,
  );
  const expiryBoundTtl = result.expiresInSeconds - DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_EXPIRY_SKEW_SECONDS;
  const cacheTtl = Math.min(configuredTtl, expiryBoundTtl);
  if (cacheTtl > 0) {
    await env.KV.put(cacheKey, result.accessToken, { expirationTtl: cacheTtl });
  }
  return result.accessToken;
}

async function exchangeGcpWifAccessToken(
  userId: string,
  projectId: string,
  credential: GcpOidcCredential,
  env: Env,
): Promise<GcpAccessTokenResult> {
  const timeoutMs = positiveInteger(env.GCP_API_TIMEOUT_MS, DEFAULT_GCP_API_TIMEOUT_MS);
  const gcpStsUrl = env.GCP_STS_TOKEN_URL || DEFAULT_GCP_STS_TOKEN_URL;
  const gcpIamCredentialsBaseUrl = env.GCP_IAM_CREDENTIALS_BASE_URL || DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL;
  const saTokenLifetime = positiveInteger(
    env.GCP_SA_TOKEN_LIFETIME_SECONDS,
    DEFAULT_GCP_SA_TOKEN_LIFETIME_SECONDS,
  );

  const wifResourcePath = `projects/${credential.gcpProjectNumber}/locations/global/workloadIdentityPools/${credential.wifPoolId}/providers/${credential.wifProviderId}`;
  const jwtAudience = `https://iam.googleapis.com/${wifResourcePath}`;
  const stsAudience = `//iam.googleapis.com/${wifResourcePath}`;
  const identityToken = await signIdentityToken(
    { userId, projectId, audience: jwtAudience },
    env,
  );

  const stsResponse = await fetchWithTimeout(gcpStsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience: stsAudience,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: env.GCP_STS_SCOPE || DEFAULT_GCP_STS_SCOPE,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken: identityToken,
    }),
  }, timeoutMs);

  if (!stsResponse.ok) {
    const errorBody = await stsResponse.text();
    throw new GcpApiError({
      step: 'sts_exchange',
      message: `GCP STS token exchange failed (${stsResponse.status})`,
      statusCode: stsResponse.status,
      rawBody: errorBody,
    });
  }
  const stsData: StsTokenResponse = await readResponseJson(
    stsResponse,
    stsTokenResponseSchema,
    'gcp.sts.token_response',
  );

  const saUrl = `${gcpIamCredentialsBaseUrl}/${credential.serviceAccountEmail}:generateAccessToken`;
  const saResponse = await fetchWithTimeout(saUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stsData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      scope: (env.GCP_SA_IMPERSONATION_SCOPES || DEFAULT_GCP_SA_IMPERSONATION_SCOPES)
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean),
      lifetime: `${saTokenLifetime}s`,
    }),
  }, timeoutMs);

  if (!saResponse.ok) {
    const errorBody = await saResponse.text();
    throw new GcpApiError({
      step: 'sa_impersonation',
      message: `GCP SA impersonation failed (${saResponse.status})`,
      statusCode: saResponse.status,
      rawBody: errorBody,
    });
  }
  const saData: SaTokenResponse = await readResponseJson(
    saResponse,
    saTokenResponseSchema,
    'gcp.iam_credentials.access_token_response',
  );
  const parsedExpiry = Math.floor((Date.parse(saData.expireTime) - Date.now()) / 1000);
  return {
    accessToken: saData.accessToken,
    expiresInSeconds: Number.isFinite(parsedExpiry) && parsedExpiry > 0
      ? parsedExpiry
      : saTokenLifetime,
  };
}

/** Verify the existing WIF path with a full exchange. */
export async function verifyGcpOidcSetup(
  userId: string,
  projectId: string,
  credential: GcpOidcCredential,
  env: Env,
): Promise<boolean> {
  await getGcpAccessToken(userId, projectId, credential, env);
  return true;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
