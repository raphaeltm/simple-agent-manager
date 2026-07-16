import type { GcpServiceAccountKeyCredential } from '@simple-agent-manager/shared';
import {
  DEFAULT_GCP_API_TIMEOUT_MS,
  DEFAULT_GCP_COMPUTE_API_BASE_URL,
  DEFAULT_GCP_SERVICE_ACCOUNT_ASSERTION_LIFETIME_SECONDS,
  DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL,
  DEFAULT_GCP_STS_SCOPE,
  GCP_CREDENTIAL_VERSION,
} from '@simple-agent-manager/shared';
import { importPKCS8, SignJWT } from 'jose';
import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { GcpApiError } from './gcp-errors';

const serviceAccountTokenResponseSchema = v.object({
  access_token: v.string(),
  token_type: v.string(),
  expires_in: v.number(),
});

const SERVICE_ACCOUNT_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/;
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

interface ServiceAccountJson {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
}

export interface GcpAccessTokenResult {
  accessToken: string;
  expiresInSeconds: number;
}

function requiredString(record: Record<string, unknown>, key: keyof ServiceAccountJson): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Service-account JSON is missing ${key}`);
  }
  return value;
}

function apiTimeoutMs(env: Env): number {
  const parsed = Number.parseInt(env.GCP_API_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GCP_API_TIMEOUT_MS;
}

/**
 * Parse and cryptographically validate an uploaded Google service-account JSON.
 * Endpoint fields such as token_uri are intentionally ignored.
 */
export async function parseGcpServiceAccountJson(
  jsonText: string,
  defaultZone: string,
): Promise<GcpServiceAccountKeyCredential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Service-account JSON is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Service-account JSON must contain an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'service_account') {
    throw new Error('Credential type must be service_account');
  }

  const projectId = requiredString(record, 'project_id');
  if (!GCP_PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error('Service-account JSON contains an invalid project_id');
  }
  const clientEmail = requiredString(record, 'client_email');
  if (!SERVICE_ACCOUNT_EMAIL_PATTERN.test(clientEmail)) {
    throw new Error('Service-account JSON contains an invalid client_email');
  }
  const privateKeyId = requiredString(record, 'private_key_id');
  const privateKey = requiredString(record, 'private_key');
  if (!defaultZone.trim()) {
    throw new Error('A default GCP zone is required');
  }

  try {
    await importPKCS8(privateKey, 'RS256');
  } catch {
    throw new Error('Service-account private_key must be a usable PKCS#8 RSA key');
  }

  return {
    version: GCP_CREDENTIAL_VERSION,
    provider: 'gcp',
    authType: 'service-account-key',
    gcpProjectId: projectId,
    serviceAccountEmail: clientEmail,
    privateKeyId,
    privateKey,
    defaultZone: defaultZone.trim(),
  };
}

/** Exchange a signed service-account JWT at Google's fixed OAuth endpoint. */
export async function exchangeGcpServiceAccountAccessToken(
  credential: GcpServiceAccountKeyCredential,
  env: Env,
): Promise<GcpAccessTokenResult> {
  let privateKey: CryptoKey;
  try {
    privateKey = await importPKCS8(credential.privateKey, 'RS256');
  } catch {
    throw new GcpApiError({
      step: 'service_account_key',
      message: 'Stored service-account private key is invalid',
      statusCode: 400,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: DEFAULT_GCP_STS_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: credential.privateKeyId })
    .setIssuer(credential.serviceAccountEmail)
    .setAudience(DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + DEFAULT_GCP_SERVICE_ACCOUNT_ASSERTION_LIFETIME_SECONDS)
    .sign(privateKey);

  const response = await fetchWithTimeout(
    DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    },
    apiTimeoutMs(env),
  );

  if (!response.ok) {
    throw new GcpApiError({
      step: 'service_account_token',
      message: `Google rejected the service-account credential (${response.status})`,
      statusCode: response.status,
    });
  }

  const token = await readResponseJson(
    response,
    serviceAccountTokenResponseSchema,
    'gcp.service_account.token_response',
  );
  return {
    accessToken: token.access_token,
    expiresInSeconds: token.expires_in,
  };
}

/**
 * Verify that a service-account token can read the selected Compute zone. This
 * catches revoked keys, disabled APIs, wrong projects, and missing Compute IAM
 * before a working stored credential is replaced.
 */
export async function verifyGcpServiceAccountAccess(
  credential: GcpServiceAccountKeyCredential,
  accessToken: string,
  env: Env,
): Promise<void> {
  const url = `${DEFAULT_GCP_COMPUTE_API_BASE_URL}/projects/${encodeURIComponent(credential.gcpProjectId)}/zones/${encodeURIComponent(credential.defaultZone)}`;
  const response = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    apiTimeoutMs(env),
  );
  if (!response.ok) {
    throw new GcpApiError({
      step: 'service_account_compute_verify',
      message: `Service account cannot access the selected Compute zone (${response.status})`,
      statusCode: response.status,
    });
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
