/**
 * Shared Cloudflare managed container registry credential minting.
 *
 * Used by both the devcontainer-cache service and the deployment
 * registry-credential service. The CF API call is:
 *   POST /accounts/{accountId}/containers/registries/{host}/credentials
 *
 * SECURITY: Never log or persist the returned username/password values.
 * Only audit metadata (who minted, when, for which project) may be stored.
 */
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export const DEFAULT_CLOUDFLARE_REGISTRY_HOST = 'registry.cloudflare.com';

export interface CloudflareRegistryMintConfig {
  accountId: string;
  apiToken: string;
  registryHost: string;
  expirationMinutes: number;
  permissions: Array<'pull' | 'push'>;
  timeoutMs: number;
}

export interface CloudflareRegistryCredentials {
  registry: string;
  username: string;
  password: string;
}

interface CloudflareRegistryCredentialsResponse {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: {
    registry_host?: string;
    username?: string;
    password?: string;
  };
}

/**
 * Mint short-lived Cloudflare managed container registry credentials.
 *
 * @throws Error if the CF API call fails or returns incomplete data
 */
export async function mintCloudflareRegistryCredentials(
  config: CloudflareRegistryMintConfig,
): Promise<CloudflareRegistryCredentials> {
  const url = `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/containers/registries/${config.registryHost}/credentials`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expiration_minutes: config.expirationMinutes,
        permissions: config.permissions,
      }),
    },
    config.timeoutMs,
  );

  const body = await response.json<CloudflareRegistryCredentialsResponse>().catch(() => null);
  if (!response.ok || !body?.result) {
    const message = body?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`Cloudflare registry credential mint failed: ${message}`);
  }

  const registry = (body.result.registry_host || config.registryHost).trim();
  const username = (body.result.username || '').trim();
  const password = body.result.password || '';
  if (!registry || !username || !password) {
    throw new Error('Cloudflare registry credential response was missing registry, username, or password');
  }

  return { registry, username, password };
}

/**
 * Build a mint config from platform env vars.
 * Returns null if required vars (account ID, API token) are missing.
 */
export function buildMintConfigFromEnv(env: {
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CF_API_TIMEOUT_MS?: string;
}, overrides?: {
  registryHost?: string;
  expirationMinutes?: number;
  permissions?: Array<'pull' | 'push'>;
}): CloudflareRegistryMintConfig | null {
  const accountId = (env.CF_ACCOUNT_ID || '').trim();
  const apiToken = (env.CF_API_TOKEN || '').trim();
  if (!accountId || !apiToken) {
    return null;
  }

  return {
    accountId,
    apiToken,
    registryHost: overrides?.registryHost || DEFAULT_CLOUDFLARE_REGISTRY_HOST,
    expirationMinutes: overrides?.expirationMinutes || 60,
    permissions: overrides?.permissions || ['pull', 'push'],
    timeoutMs: getTimeoutMs(env.CF_API_TIMEOUT_MS),
  };
}
