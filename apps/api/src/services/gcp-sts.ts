import type { Env } from '../index';
import type { GcpOidcCredential } from '@simple-agent-manager/shared';
import {
  DEFAULT_GCP_TOKEN_CACHE_TTL_SECONDS,
  DEFAULT_GCP_API_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { signIdentityToken } from './jwt';

const GCP_STS_URL = 'https://sts.googleapis.com/v1/token';
const GCP_IAM_CREDENTIALS_URL = 'https://iamcredentials.googleapis.com/v1';

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

  // Step 1: Sign a SAM identity token
  const audience = `//iam.googleapis.com/projects/${credential.gcpProjectNumber}/locations/global/workloadIdentityPools/${credential.wifPoolId}/providers/${credential.wifProviderId}`;

  const identityToken = await signIdentityToken(
    {
      userId,
      projectId,
      audience,
    },
    env,
  );

  // Step 2: Exchange SAM JWT for GCP STS federated token
  const stsBody = {
    audience,
    grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    subjectToken: identityToken,
  };

  const stsResponse = await fetchWithTimeout(GCP_STS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stsBody),
  }, timeoutMs);

  if (!stsResponse.ok) {
    const errorBody = await stsResponse.text();
    throw new Error(`GCP STS token exchange failed (${stsResponse.status}): ${errorBody}`);
  }

  const stsData = (await stsResponse.json()) as StsTokenResponse;

  // Step 3: Impersonate service account for Compute Engine access
  const saUrl = `${GCP_IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${credential.serviceAccountEmail}:generateAccessToken`;

  const saResponse = await fetchWithTimeout(saUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stsData.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      scope: ['https://www.googleapis.com/auth/compute'],
      lifetime: '3600s',
    }),
  }, timeoutMs);

  if (!saResponse.ok) {
    const errorBody = await saResponse.text();
    throw new Error(`GCP SA impersonation failed (${saResponse.status}): ${errorBody}`);
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
