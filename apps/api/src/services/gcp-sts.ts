import type { Env } from '../index';
import type { GcpOidcCredential } from '@simple-agent-manager/shared';
import {
  DEFAULT_GCP_TOKEN_CACHE_TTL_SECONDS,
  DEFAULT_GCP_API_TIMEOUT_MS,
  DEFAULT_GCP_SA_TOKEN_LIFETIME_SECONDS,
  DEFAULT_GCP_STS_SCOPE,
  DEFAULT_GCP_SA_IMPERSONATION_SCOPES,
  DEFAULT_GCP_STS_TOKEN_URL,
  DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL,
} from '@simple-agent-manager/shared';
import { signIdentityToken } from './jwt';
import { GcpApiError } from './gcp-errors';

interface StsTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SaTokenResponse {
  accessToken: string;
  expireTime: string;
}

/**
 * Get a GCP access token for Compute Engine operations via OIDC token exchange.
 *
 * Flow:
 * 1. Sign a SAM identity JWT (project-scoped, short-lived)
 * 2. Exchange it at GCP STS for a federated access token
 * 3. Use the federated token to impersonate the service account
 * 4. Return the SA access token (cached in KV for efficiency)
 */
export async function getGcpAccessToken(
  userId: string,
  projectId: string,
  credential: GcpOidcCredential,
  env: Env,
): Promise<string> {
  const cacheKey = `gcp-token:${userId}:${projectId}`;
  const cacheTtlSeconds = env.GCP_TOKEN_CACHE_TTL_SECONDS
    ? parseInt(env.GCP_TOKEN_CACHE_TTL_SECONDS, 10)
    : DEFAULT_GCP_TOKEN_CACHE_TTL_SECONDS;

  // Check KV cache first
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return cached;
  }

  const timeoutMs = env.GCP_API_TIMEOUT_MS
    ? parseInt(env.GCP_API_TIMEOUT_MS, 10)
    : DEFAULT_GCP_API_TIMEOUT_MS;
  const gcpStsUrl = env.GCP_STS_TOKEN_URL || DEFAULT_GCP_STS_TOKEN_URL;
  const gcpIamCredentialsBaseUrl = env.GCP_IAM_CREDENTIALS_BASE_URL || DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL;
  const saTokenLifetime = env.GCP_SA_TOKEN_LIFETIME_SECONDS
    ? parseInt(env.GCP_SA_TOKEN_LIFETIME_SECONDS, 10)
    : DEFAULT_GCP_SA_TOKEN_LIFETIME_SECONDS;

  // Step 1: Sign a SAM identity token
  // GCP requires different audience formats for the JWT vs the STS request:
  // - JWT aud claim: https://iam.googleapis.com/... (full HTTPS scheme)
  // - STS audience field: //iam.googleapis.com/... (protocol-relative)
  const wifResourcePath = `projects/${credential.gcpProjectNumber}/locations/global/workloadIdentityPools/${credential.wifPoolId}/providers/${credential.wifProviderId}`;
  const jwtAudience = `https://iam.googleapis.com/${wifResourcePath}`;
  const stsAudience = `//iam.googleapis.com/${wifResourcePath}`;

  const identityToken = await signIdentityToken(
    {
      userId,
      projectId,
      audience: jwtAudience,
    },
    env,
  );

  // Step 2: Exchange SAM JWT for GCP STS federated token
  const stsScope = env.GCP_STS_SCOPE || DEFAULT_GCP_STS_SCOPE;
  const stsBody = {
    audience: stsAudience,
    grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    scope: stsScope,
    subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    subjectToken: identityToken,
  };

  const stsResponse = await fetchWithTimeout(gcpStsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stsBody),
  }, timeoutMs);

  if (!stsResponse.ok) {
    const errorBody = await stsResponse.text();
    throw new GcpApiError({ step: 'sts_exchange', message: `GCP STS token exchange failed (${stsResponse.status})`, statusCode: stsResponse.status, rawBody: errorBody });
  }

  const stsData = (await stsResponse.json()) as StsTokenResponse;

  // Step 3: Impersonate service account for Compute Engine access
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
        .map((s) => s.trim())
        .filter(Boolean),
      lifetime: `${saTokenLifetime}s`,
    }),
  }, timeoutMs);

  if (!saResponse.ok) {
    const errorBody = await saResponse.text();
    throw new GcpApiError({ step: 'sa_impersonation', message: `GCP SA impersonation failed (${saResponse.status})`, statusCode: saResponse.status, rawBody: errorBody });
  }

  const saData = (await saResponse.json()) as SaTokenResponse;

  // Cache the access token in KV
  await env.KV.put(cacheKey, saData.accessToken, {
    expirationTtl: cacheTtlSeconds,
  });

  return saData.accessToken;
}

/**
 * Verify that GCP OIDC setup is working by performing a test token exchange.
 * Returns true if the full exchange succeeds, throws on failure.
 */
export async function verifyGcpOidcSetup(
  userId: string,
  projectId: string,
  credential: GcpOidcCredential,
  env: Env,
): Promise<boolean> {
  // Attempt a full token exchange — if it succeeds, the setup is verified
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
