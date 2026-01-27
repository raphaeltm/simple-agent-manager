import { SignJWT, importPKCS8 } from 'jose';
import type { Env } from '../index';

/**
 * Generate a JWT for GitHub App authentication.
 * This JWT is used to authenticate as the GitHub App.
 */
export async function generateAppJWT(env: Env): Promise<string> {
  const privateKey = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, 'RS256');
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
  env: Env
): Promise<{ token: string; expiresAt: string }> {
  const jwt = await generateAppJWT(env);

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Cloud-AI-Workspaces',
      },
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message || `Failed to get installation token: ${response.status}`);
  }

  const data = await response.json() as { token: string; expires_at: string };
  return {
    token: data.token,
    expiresAt: data.expires_at,
  };
}

/**
 * Get repositories accessible to an installation.
 */
export async function getInstallationRepositories(
  installationId: string,
  env: Env
): Promise<Array<{ id: number; fullName: string; private: boolean; defaultBranch: string }>> {
  const { token } = await getInstallationToken(installationId, env);

  const response = await fetch(
    'https://api.github.com/installation/repositories',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Cloud-AI-Workspaces',
      },
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message || `Failed to get repositories: ${response.status}`);
  }

  const data = await response.json() as {
    repositories: Array<{
      id: number;
      full_name: string;
      private: boolean;
      default_branch: string;
    }>;
  };

  return data.repositories.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
  }));
}

/**
 * Get all installations for the app.
 */
export async function getAppInstallations(
  env: Env
): Promise<Array<{ id: number; account: { login: string; type: string } }>> {
  const jwt = await generateAppJWT(env);

  const response = await fetch(
    'https://api.github.com/app/installations',
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Cloud-AI-Workspaces',
      },
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message || `Failed to get installations: ${response.status}`);
  }

  const data = await response.json() as Array<{
    id: number;
    account: { login: string; type: string };
  }>;

  return data;
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
