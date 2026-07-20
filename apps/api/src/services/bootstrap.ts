/**
 * Bootstrap Token Service
 *
 * Manages one-time bootstrap tokens for secure credential delivery to VMs.
 * Tokens are stored in KV with a 15-minute TTL and are deleted after single use.
 */

import type { BootstrapTokenData } from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt, encrypt } from './encryption';

/** KV key prefix for bootstrap tokens */
const BOOTSTRAP_PREFIX = 'bootstrap:';
const inFlightRedemptions = new Map<string, Promise<BootstrapTokenData | null>>();

/** Default bootstrap token TTL in seconds (15 minutes) */
const DEFAULT_BOOTSTRAP_TTL = 900;
const LEGACY_CLOCK_SKEW_SECONDS = 60;

interface BootstrapEnv {
  BOOTSTRAP_TOKEN_TTL_SECONDS?: string;
  ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

/** Get bootstrap TTL from env or use default (per constitution principle XI) */
export function getBootstrapTTL(env?: Pick<BootstrapEnv, 'BOOTSTRAP_TOKEN_TTL_SECONDS'>): number {
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
  env: BootstrapEnv
): Promise<void> {
  const ttl = getBootstrapTTL(env);
  const { callbackToken, ...dataWithoutPlaintextCallbackToken } = data;
  if (!callbackToken) {
    throw new Error('Bootstrap callback token is required');
  }

  const encryptedCallbackToken = await encrypt(
    callbackToken,
    getCredentialEncryptionKey(env)
  );
  const storedData: BootstrapTokenData = {
    ...dataWithoutPlaintextCallbackToken,
    encryptedCallbackToken: encryptedCallbackToken.ciphertext,
    callbackTokenIv: encryptedCallbackToken.iv,
  };

  await kv.put(`${BOOTSTRAP_PREFIX}${token}`, JSON.stringify(storedData), {
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
  token: string,
  env: BootstrapEnv
): Promise<BootstrapTokenData | null> {
  const key = `${BOOTSTRAP_PREFIX}${token}`;
  const existing = inFlightRedemptions.get(key);
  if (existing) {
    return null;
  }

  const redemption = (async () => {
    const data = await kv.get<BootstrapTokenData>(key, { type: 'json' });

    if (!data) {
      return null;
    }

    // Delete immediately to enforce single-use before decrypting or returning credentials.
    await kv.delete(key);

    if (data.encryptedCallbackToken && data.callbackTokenIv) {
      const callbackToken = await decrypt(
        data.encryptedCallbackToken,
        data.callbackTokenIv,
        getCredentialEncryptionKey(env)
      );

      return {
        ...data,
        callbackToken,
      };
    }

    // Backward compatibility for bootstrap entries written before callback token encryption.
    // This is intentionally bounded to entries still inside the configured bootstrap TTL
    // plus a small clock-skew allowance; older plaintext records fail closed.
    if (data.callbackToken && isLegacyPlaintextCallbackTokenStillRedeemable(data, env)) {
      log.warn('bootstrap.legacy_plaintext_callback_token_redeemed', {
        workspaceId: data.workspaceId,
        createdAt: data.createdAt,
      });
      return data;
    }

    if (data.callbackToken) {
      log.warn('bootstrap.legacy_plaintext_callback_token_rejected', {
        workspaceId: data.workspaceId,
        createdAt: data.createdAt,
      });
    }

    throw new Error('Bootstrap token data is missing callback token material');
  })();

  inFlightRedemptions.set(key, redemption);
  try {
    return await redemption;
  } finally {
    inFlightRedemptions.delete(key);
  }
}

function isLegacyPlaintextCallbackTokenStillRedeemable(
  data: Pick<BootstrapTokenData, 'createdAt'>,
  env: Pick<BootstrapEnv, 'BOOTSTRAP_TOKEN_TTL_SECONDS'>
): boolean {
  const createdAtMs = Date.parse(data.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  const ageMs = Date.now() - createdAtMs;
  const maxAgeMs = (getBootstrapTTL(env) + LEGACY_CLOCK_SKEW_SECONDS) * 1000;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}
