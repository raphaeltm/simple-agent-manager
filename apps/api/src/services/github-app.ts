import { importPKCS8, SignJWT } from 'jose';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';

const githubErrorSchema = v.object({
  message: v.optional(v.string()),
});

const installationTokenSchema = v.object({
  token: v.string(),
  expires_at: v.string(),
});

const repositorySchema = v.object({
  id: v.number(),
  full_name: v.string(),
  private: v.boolean(),
  default_branch: v.string(),
});

const installationRepositoriesSchema = v.object({
  repositories: v.array(repositorySchema),
  total_count: v.number(),
});

const userInstallationSchema = v.object({
  id: v.number(),
  account: v.object({
    login: v.string(),
    type: v.string(),
  }),
});

const userInstallationsSchema = v.object({
  installations: v.array(userInstallationSchema),
});

const branchSchema = v.object({
  name: v.string(),
});

async function readGitHubError(response: Response, fallback: string): Promise<string> {
  try {
    const error = await readResponseJson(response, githubErrorSchema, 'github.error');
    return error.message || fallback;
  } catch {
    return fallback;
  }
}

export interface UserAccessibleInstallation {
  id: number;
  account: { login: string; type: string };
}

export interface GitHubUserOrganization {
  login: string;
}

interface UserAccessibleInstallationsDiagnostics {
  flow: 'callback' | 'sync';
  userId?: string;
  installationId?: string;
}

interface UserOrganizationDiagnostics {
  flow: 'shared-org-discovery';
  userId: string;
}

interface UserInstallationAccessDiagnostics {
  flow: 'shared-org-discovery';
  userId: string;
  installationId: string;
  accountName?: string;
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
function decodePrivateKey(key: string): string {
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
function convertPkcs1ToPkcs8(pem: string): string {
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
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
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
function wrapAsn1(tag: number, data: Uint8Array): Uint8Array {
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
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Generate a JWT for GitHub App authentication.
 * This JWT is used to authenticate as the GitHub App.
 */
export async function generateAppJWT(env: Env): Promise<string> {
  const pemKey = decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const privateKey = await importPKCS8(pemKey, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60) // 1 minute in the past to account for clock drift
    .setIssuer(env.GITHUB_APP_ID)
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
  extraPermissions?: Record<string, string>,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = await generateAppJWT(env);

  const body = extraPermissions ? JSON.stringify({ permissions: extraPermissions }) : undefined;

  const response = await fetch(
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
    throw new Error(await readGitHubError(response, `Failed to get installation token: ${response.status}`));
  }

  const data = await readResponseJson(response, installationTokenSchema, 'github.installation_token');
  return {
    token: data.token,
    expiresAt: data.expires_at,
  };
}

/**
 * Get repositories accessible to an installation.
 * Fetches all pages to ensure users with many repositories can find all of them.
 */
export async function getInstallationRepositories(
  installationId: string,
  env: Env
): Promise<Array<{ id: number; fullName: string; private: boolean; defaultBranch: string }>> {
  const { token } = await getInstallationToken(installationId, env);

  const allRepos: Array<{ id: number; fullName: string; private: boolean; defaultBranch: string }> = [];
  let page = 1;
  const perPage = 100; // GitHub's max per_page value
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      }
    );

    if (!response.ok) {
      throw new Error(await readGitHubError(response, `Failed to get repositories: ${response.status}`));
    }

    const data = await readResponseJson(response, installationRepositoriesSchema, 'github.installation_repositories');

    const repos = data.repositories.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
    }));

    allRepos.push(...repos);

    // Check if there are more pages
    hasMore = data.repositories.length === perPage;
    page++;

    // Safety limit to prevent infinite loops (10,000 repos max)
    if (allRepos.length >= 10000) {
      log.warn('github_app.repo_safety_limit_reached', { installationId, repoCount: allRepos.length });
      break;
    }
  }

  return allRepos;
}

/**
 * Get GitHub App installations accessible to an authenticated GitHub user.
 * This is the user-context check GitHub recommends before trusting a setup
 * callback's installation_id parameter.
 */
export async function getUserAccessibleInstallations(
  accessToken: string,
  diagnostics?: UserAccessibleInstallationsDiagnostics
): Promise<UserAccessibleInstallation[]> {
  const allInstallations: UserAccessibleInstallation[] = [];
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.github.com/user/installations?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      }
    );

    if (!response.ok) {
      log.warn('github.user_accessible_installations.response', {
        flow: diagnostics?.flow,
        userId: diagnostics?.userId,
        installationId: diagnostics?.installationId,
        page,
        status: response.status,
        ok: false,
        installationCount: 0,
      });
      throw new Error(await readGitHubError(response, `Failed to get user installations: ${response.status}`));
    }

    const data = await readResponseJson(response, userInstallationsSchema, 'github.user_installations');

    log.info('github.user_accessible_installations.response', {
      flow: diagnostics?.flow,
      userId: diagnostics?.userId,
      installationId: diagnostics?.installationId,
      page,
      status: response.status,
      ok: true,
      installationCount: data.installations.length,
    });

    allInstallations.push(...data.installations.map((installation) => ({
      id: installation.id,
      account: installation.account,
    })));

    hasMore = data.installations.length === perPage;
    page++;
  }

  return allInstallations;
}

/**
 * Fetch organizations for the authenticated GitHub user.
 *
 * This narrows shared installation candidates before SAM considers any
 * organization installation rows already known locally.
 */
export async function getAuthenticatedUserOrganizations(
  accessToken: string,
  diagnostics: UserOrganizationDiagnostics
): Promise<GitHubUserOrganization[]> {
  const allOrganizations: GitHubUserOrganization[] = [];
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.github.com/user/orgs?per_page=${perPage}&page=${page}`,
      {
        headers: githubUserTokenHeaders(accessToken),
      }
    );

    if (!response.ok) {
      log.warn('github.user_organizations.response', {
        flow: diagnostics.flow,
        userId: diagnostics.userId,
        page,
        status: response.status,
        ok: false,
        organizationCount: 0,
      });
      const error = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(error.message || `Failed to get user organizations: ${response.status}`);
    }

    const data = await response.json() as Array<{ login: string }>;

    log.info('github.user_organizations.response', {
      flow: diagnostics.flow,
      userId: diagnostics.userId,
      page,
      status: response.status,
      ok: true,
      organizationCount: data.length,
    });

    allOrganizations.push(...data.map((org) => ({ login: org.login })));
    hasMore = data.length === perPage;
    page++;
  }

  return allOrganizations;
}

/**
 * Verify that a GitHub user token can access a specific app installation.
 *
 * 403/404 mean this user cannot use the installation and are represented as
 * false. Other failures are treated as transient and thrown to the caller.
 */
export async function verifyUserInstallationAccess(
  accessToken: string,
  installationId: string,
  diagnostics: UserInstallationAccessDiagnostics
): Promise<boolean> {
  const response = await fetch(
    `https://api.github.com/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=1`,
    {
      headers: githubUserTokenHeaders(accessToken),
    }
  );

  const details = {
    flow: diagnostics.flow,
    userId: diagnostics.userId,
    installationId: diagnostics.installationId,
    accountName: diagnostics.accountName,
    status: response.status,
    ok: response.ok,
  };
  if (response.ok) {
    log.info('github.user_installation_access.response', details);
  } else {
    log.warn('github.user_installation_access.response', details);
  }

  if (response.ok) {
    return true;
  }

  if (response.status === 403 || response.status === 404) {
    return false;
  }

  const error = await response.json().catch(() => ({})) as { message?: string };
  throw new Error(error.message || `Failed to verify user installation access: ${response.status}`);
}

function githubUserTokenHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Simple-Agent-Manager',
  };
}

const DEFAULT_MAX_BRANCHES_PER_REPO = 5000;

/**
 * List branches for a repository via an installation token.
 * Paginates through all pages to support repos with many branches.
 */
export async function getRepositoryBranches(
  installationId: string,
  owner: string,
  repo: string,
  env: Env,
  defaultBranch?: string
): Promise<Array<{ name: string }>> {
  const { token } = await getInstallationToken(installationId, env);

  const maxBranches = parseInt(env.MAX_BRANCHES_PER_REPO || '', 10) || DEFAULT_MAX_BRANCHES_PER_REPO;
  const allBranches: Array<{ name: string }> = [];
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      }
    );

    if (!response.ok) {
      throw new Error(await readGitHubError(response, `Failed to list branches: ${response.status}`));
    }

    const data = await readResponseJson(response, v.array(branchSchema), 'github.branches');
    allBranches.push(...data.map((b) => ({ name: b.name })));

    hasMore = data.length === perPage;
    page++;

    if (allBranches.length >= maxBranches) {
      log.warn('github_app.branch_safety_limit_reached', { owner, repo, branchCount: allBranches.length, maxBranches });
      break;
    }
  }

  // Ensure default branch is always present and first in the list
  if (defaultBranch) {
    const hasDefault = allBranches.some((b) => b.name === defaultBranch);
    if (!hasDefault) {
      allBranches.unshift({ name: defaultBranch });
    } else {
      // Move default branch to front
      const filtered = allBranches.filter((b) => b.name !== defaultBranch);
      return [{ name: defaultBranch }, ...filtered];
    }
  }

  return allBranches;
}

/**
 * Verify a webhook signature from GitHub.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  const expectedSignature = 'sha256=' + Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return signature === expectedSignature;
}
