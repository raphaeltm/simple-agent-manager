/**
 * Bootstrap Token Service
 *
 * Manages one-time bootstrap tokens for secure credential delivery to VMs.
 * Tokens are stored in KV with a 15-minute TTL and are deleted after single use.
 */

import type { BootstrapTokenData } from '@simple-agent-manager/shared';

/** KV key prefix for bootstrap tokens */
const BOOTSTRAP_PREFIX = 'bootstrap:';

/** Default bootstrap token TTL in seconds (15 minutes) */
const DEFAULT_BOOTSTRAP_TTL = 900;

/** Get bootstrap TTL from env or use default (per constitution principle XI) */
export function getBootstrapTTL(env?: { BOOTSTRAP_TOKEN_TTL_SECONDS?: string }): number {
  if (env?.BOOTSTRAP_TOKEN_TTL_SECONDS) {
    const ttl = parseInt(env.BOOTSTRAP_TOKEN_TTL_SECONDS, 10);
    if (!isNaN(ttl) && ttl > 0) {
      return ttl;
    }
  }
  return DEFAULT_BOOTSTRAP_TTL;
}

/**
 * Generate a cryptographically secure bootstrap token (UUID v4 format).
 */
export function generateBootstrapToken(): string {
  return crypto.randomUUID();
}

/**
 * Store bootstrap token data in KV with configurable TTL.
 * Token auto-expires after TTL, no cleanup needed.
 *
 * @param kv - Cloudflare KV namespace
 * @param token - Bootstrap token (UUID)
 * @param data - Credential data to store
 * @param env - Environment for reading configurable TTL
 */
export async function storeBootstrapToken(
  kv: KVNamespace,
  token: string,
  data: BootstrapTokenData,
  env?: { BOOTSTRAP_TOKEN_TTL_SECONDS?: string }
): Promise<void> {
  const ttl = getBootstrapTTL(env);
  await kv.put(`${BOOTSTRAP_PREFIX}${token}`, JSON.stringify(data), {
    expirationTtl: ttl,
  });
}

/**
 * Redeem a bootstrap token (get + delete for single-use).
 * Returns null if token doesn't exist or has expired.
 * Token is deleted immediately after retrieval to enforce single-use.
 *
 * @param kv - Cloudflare KV namespace
 * @param token - Bootstrap token to redeem
 * @returns Token data if valid, null otherwise
 */
export async function redeemBootstrapToken(
  kv: KVNamespace,
  token: string
): Promise<BootstrapTokenData | null> {
  const key = `${BOOTSTRAP_PREFIX}${token}`;

  const data = await kv.get<BootstrapTokenData>(key, { type: 'json' });

  if (!data) {
    return null;
  }

  // Delete immediately to enforce single-use
  await kv.delete(key);

  return data;
}
