import { importPKCS8, SignJWT } from 'jose';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { AppError } from '../middleware/error';
import { parseCacheTtlSeconds } from './cache-config';
import { fetchWithTimeout } from './fetch-timeout';
import {
  DEFAULT_GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS,
  DEFAULT_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS,
  installationTokenSchema,
  MAX_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS,
  readGitHubError,
} from './github-app-common';
import { getGitHubAppConfig } from './platform-config';

export async function installationTokenCacheKey(
  installationId: string,
  body: string | undefined
): Promise<string> {
  if (!body) return `github-installation-token:v1:${installationId}:default`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `github-installation-token:v1:${installationId}:${hash}`;
}

/**
 * Decode a private key that may be stored in various formats:
 * - Raw PEM (with actual newlines)
 * - PEM with literal \n escape sequences (common in environment variables)
 * - Base64-encoded PEM
 *
 * Also handles PKCS#1 (BEGIN RSA PRIVATE KEY) → PKCS#8 (BEGIN PRIVATE KEY) conversion,
 * since jose's importPKCS8 only accepts PKCS#8 format, but GitHub App keys are PKCS#1.
 */
export function decodePrivateKey(key: string): string {
  let decoded = key.trim();

  // Handle literal \n escape sequences (common in env vars / GitHub secrets)
  if (decoded.includes('\\n')) {
    decoded = decoded.replace(/\\n/g, '\n');
  }

  // If it looks like PEM now, check and return
  if (decoded.includes('-----BEGIN')) {
    return convertPkcs1ToPkcs8(decoded);
  }

  // Otherwise, try base64 decode
  try {
    const decodedB64 = atob(decoded);
    if (decodedB64.includes('-----BEGIN')) {
      return convertPkcs1ToPkcs8(decodedB64.trim());
    }
  } catch {
    // Not valid base64, fall through
  }

  // Return as-is and let importPKCS8 produce a clear error
  return decoded;
}

/**
 * Convert PKCS#1 RSA private key PEM to PKCS#8 format.
 * GitHub App keys are generated as PKCS#1 (-----BEGIN RSA PRIVATE KEY-----),
 * but jose's importPKCS8 only accepts PKCS#8 (-----BEGIN PRIVATE KEY-----).
 *
 * PKCS#8 wraps the PKCS#1 key with an AlgorithmIdentifier (RSA OID).
 */
export function convertPkcs1ToPkcs8(pem: string): string {
  // If already PKCS#8, return as-is
  if (pem.includes('-----BEGIN PRIVATE KEY-----')) {
    return pem;
  }

  // Only convert PKCS#1 RSA keys
  if (!pem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
    return pem;
  }

  // Extract the base64 body from the PKCS#1 PEM
  const b64Body = pem
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  // Decode the PKCS#1 DER bytes
  const pkcs1Der = Uint8Array.from(atob(b64Body), (c) => c.charCodeAt(0));

  // PKCS#8 header for RSA: SEQUENCE { AlgorithmIdentifier { OID rsaEncryption, NULL }, OCTET STRING { pkcs1Der } }
  // The RSA AlgorithmIdentifier is the fixed bytes: 30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);

  // Build the OCTET STRING wrapping the PKCS#1 key
  const octetString = wrapAsn1(0x04, pkcs1Der);

  // Build the outer SEQUENCE containing algId + octetString
  // We need to add version INTEGER 0 at the start
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const innerContent = concatBytes(version, algId, octetString);
  const pkcs8Der = wrapAsn1(0x30, innerContent);

  // Encode back to PEM
  const b64 = btoa(String.fromCharCode(...pkcs8Der));
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

/** Wrap data in an ASN.1 TLV (Tag-Length-Value) structure */
export function wrapAsn1(tag: number, data: Uint8Array): Uint8Array {
  const length = data.length;
  let header: Uint8Array;

  if (length < 0x80) {
    header = new Uint8Array([tag, length]);
  } else if (length < 0x100) {
    header = new Uint8Array([tag, 0x81, length]);
  } else if (length < 0x10000) {
    header = new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
  } else {
    header = new Uint8Array([
      tag,
      0x83,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff,
    ]);
  }

  return concatBytes(header, data);
}

/** Concatenate multiple Uint8Arrays */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function resolveInstallationTokenRefreshMarginSeconds(env: Env): number {
  const margin = parseCacheTtlSeconds(
    env.GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS,
    DEFAULT_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS
  );
  return Math.min(margin, MAX_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS);
}

export function cachedInstallationTokenIsFresh(
  cached: { token?: string; expiresAt?: string } | null | undefined,
  refreshMarginSeconds: number
): cached is { token: string; expiresAt: string } {
  if (!cached?.token || !cached.expiresAt) return false;
  const expiresAtMs = Date.parse(cached.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - Date.now() > refreshMarginSeconds * 1000;
}

/**
 * Generate a JWT for GitHub App authentication.
 * This JWT is used to authenticate as the GitHub App.
 */
export async function generateAppJWT(env: Env): Promise<string> {
  const config = await getGitHubAppConfig(env);
  if (!config) {
    throw new AppError(
      500,
      'GITHUB_APP_NOT_CONFIGURED',
      'GitHub App credentials are not configured'
    );
  }
  const pemKey = decodePrivateKey(config.privateKey);
  const privateKey = await importPKCS8(pemKey, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60) // 1 minute in the past to account for clock drift
    .setIssuer(config.appId)
    .setExpirationTime(now + 600) // 10 minutes
    .sign(privateKey);
}

/**
 * Get an installation access token for a GitHub App installation.
 * This token is used to access repositories on behalf of the installation.
 */
export async function getInstallationToken(
  installationId: string,
  env: Env,
  options?:
    | Record<string, string>
    | {
        permissions?: Record<string, string>;
        repositoryIds?: number[];
        repositories?: string[];
      }
): Promise<{ token: string; expiresAt: string }> {
  const body = options
    ? JSON.stringify(
        'permissions' in options || 'repositoryIds' in options || 'repositories' in options
          ? {
              ...(options.permissions ? { permissions: options.permissions } : {}),
              ...(options.repositoryIds ? { repository_ids: options.repositoryIds } : {}),
              ...(options.repositories ? { repositories: options.repositories } : {}),
            }
          : { permissions: options }
      )
    : undefined;
  const cacheKey = await installationTokenCacheKey(installationId, body);
  const cached = await env.KV?.get<{ token: string; expiresAt: string }>(cacheKey, 'json');
  if (cachedInstallationTokenIsFresh(cached, resolveInstallationTokenRefreshMarginSeconds(env))) {
    return cached;
  }

  const jwt = await generateAppJWT(env);

  const response = await fetchWithTimeout(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Simple-Agent-Manager',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    }
  );

  if (!response.ok) {
    throw new Error(
      await readGitHubError(response, `Failed to get installation token: ${response.status}`)
    );
  }

  const data = await readResponseJson(
    response,
    installationTokenSchema,
    'github.installation_token'
  );
  const token = {
    token: data.token,
    expiresAt: data.expires_at,
  };
  const cacheTtl = parseCacheTtlSeconds(
    env.GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS,
    DEFAULT_GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS
  );
  if (cacheTtl > 0) {
    await env.KV?.put(cacheKey, JSON.stringify(token), {
      expirationTtl: cacheTtl,
    });
  }
  return token;
}
