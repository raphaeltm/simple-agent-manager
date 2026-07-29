/**
 * Bootstrap Token Service
 *
 * Manages one-time bootstrap tokens for secure credential delivery to VMs.
 * Tokens are stored in KV with a configurable TTL and are deleted after single use.
 */

import type { BootstrapTokenData } from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { decrypt, encrypt } from './encryption';

/** KV key prefix for bootstrap tokens */
const BOOTSTRAP_PREFIX = 'bootstrap:';

/** Default bootstrap token TTL in seconds. */
const DEFAULT_BOOTSTRAP_TTL = 900;
const LEGACY_CLOCK_SKEW_SECONDS = 60;

interface BootstrapEnv {
  BOOTSTRAP_TOKEN_TTL_SECONDS?: string;
  ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  DATABASE: D1Database;
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

  await registerBootstrapTokenConsume(env.DATABASE, token, nowPlusSeconds(ttl));

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
  const consumeState = await reserveBootstrapTokenConsume(env.DATABASE, token);
  if (consumeState === 'rejected') {
    return null;
  }

  const data = await kv.get<BootstrapTokenData>(key, { type: 'json' });
  if (!data) {
    return null;
  }

  if (consumeState === 'legacy-claim-required') {
    const claimed = await claimLegacyBootstrapTokenConsume(env.DATABASE, token, env);
    if (!claimed) {
      return null;
    }
  }

  // Delete after the D1 consume decision. If payload handling later fails, the D1
  // row remains consumed so ambiguous/failed redemption is fail-closed.
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
}

export async function registerBootstrapTokenConsume(
  db: D1Database,
  token: string,
  expiresAt: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bootstrap_token_consumes (token_hash, created_at, expires_at)
       VALUES (?, ?, ?)`
    )
    .bind(await hashBootstrapToken(token), Date.now(), parseBootstrapExpiry(expiresAt))
    .run();
}

type BootstrapConsumeState = 'consumed' | 'legacy-claim-required' | 'rejected';

async function reserveBootstrapTokenConsume(
  db: D1Database,
  token: string
): Promise<BootstrapConsumeState> {
  const now = Date.now();
  const tokenHash = await hashBootstrapToken(token);

  const updated = await db
    .prepare(
      `UPDATE bootstrap_token_consumes
       SET consumed_at = ?
       WHERE token_hash = ?
         AND consumed_at IS NULL
         AND expires_at > ?`
    )
    .bind(now, tokenHash, now)
    .run();

  if (d1Changes(updated) === 1) {
    return 'consumed';
  }

  const existing = await db
    .prepare('SELECT token_hash FROM bootstrap_token_consumes WHERE token_hash = ?')
    .bind(tokenHash)
    .first('token_hash');

  return existing ? 'rejected' : 'legacy-claim-required';
}

async function claimLegacyBootstrapTokenConsume(
  db: D1Database,
  token: string,
  env: Pick<BootstrapEnv, 'BOOTSTRAP_TOKEN_TTL_SECONDS'>
): Promise<boolean> {
  const now = Date.now();

  // Migration-safe compatibility for unexpired tokens that were written to KV
  // before the D1 ledger existed, or direct legacy producers that only wrote KV.
  // The unique token_hash insert is the atomic cross-isolate claim: one request
  // can create the consumed row, all duplicates fail closed.
  const legacyClaim = await db
    .prepare(
      `INSERT OR IGNORE INTO bootstrap_token_consumes (token_hash, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(await hashBootstrapToken(token), now, nowPlusSecondsMs(getBootstrapTTL(env)), now)
    .run();

  return d1Changes(legacyClaim) === 1;
}

function d1Changes(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
}

async function hashBootstrapToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function nowPlusSeconds(seconds: number): string {
  return new Date(nowPlusSecondsMs(seconds)).toISOString();
}

function nowPlusSecondsMs(seconds: number): number {
  return Date.now() + seconds * 1000;
}

function parseBootstrapExpiry(expiresAt: string): number {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid bootstrap token expiry');
  }
  return parsed;
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
