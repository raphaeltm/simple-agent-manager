/**
 * AI proxy billing mode resolution.
 *
 * Determines which upstream authentication to use for AI Gateway requests:
 * - Unified Billing: `cf-aig-authorization: Bearer <token>` (Cloudflare credits)
 *   Token resolution: CF_AIG_TOKEN (explicit) > CF_API_TOKEN (already a Worker secret)
 * - Platform Key: `x-api-key: <stored-api-key>` (admin-managed provider credential)
 * - Auto: try unified first, fall back to platform key if no CF token is available
 */
import {
  AI_PROXY_BILLING_MODE_KV_KEY,
  type BillingMode,
  DEFAULT_AI_PROXY_BILLING_MODE,
  VALID_BILLING_MODES,
} from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getPlatformAgentCredential } from './platform-credentials';

export interface UpstreamAuth {
  /** Headers to send to the upstream AI Gateway endpoint. */
  headers: Record<string, string>;
  /** The resolved billing mode that was used. */
  billingMode: BillingMode;
}

/**
 * Resolve the effective billing mode from KV > env > default.
 */
export async function resolveBillingMode(env: Env): Promise<BillingMode> {
  // Priority: KV (admin-set) > env var > default constant
  const kvValue = await env.KV.get(AI_PROXY_BILLING_MODE_KV_KEY);
  if (kvValue && isValidBillingMode(kvValue)) {
    return kvValue;
  }
  const envValue = env.AI_PROXY_BILLING_MODE;
  if (envValue && isValidBillingMode(envValue)) {
    return envValue;
  }
  return DEFAULT_AI_PROXY_BILLING_MODE;
}

function isValidBillingMode(value: string): value is BillingMode {
  return (VALID_BILLING_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the Cloudflare token for Unified Billing.
 * Prefers the explicit CF_AIG_TOKEN, falls back to CF_API_TOKEN (already a Worker secret).
 */
export function resolveUnifiedBillingToken(env: Env): string | undefined {
  return env.CF_AIG_TOKEN ?? env.CF_API_TOKEN ?? undefined;
}

/**
 * Resolve upstream authentication headers for AI Gateway requests.
 *
 * Resolution order depends on billing mode:
 * - 'unified': Use CF token via cf-aig-authorization header. Error if no token available.
 * - 'platform-key': Use stored platform credential via x-api-key header. Error if missing.
 * - 'auto' (default): Try unified if a CF token exists, else fall back to platform key.
 */
export async function resolveUpstreamAuth(
  env: Env,
  db: ReturnType<typeof drizzle>,
): Promise<UpstreamAuth> {
  const mode = await resolveBillingMode(env);
  const cfToken = resolveUnifiedBillingToken(env);

  if (mode === 'unified') {
    if (!cfToken) {
      throw new Error('Unified Billing enabled but no CF token is configured (set CF_AIG_TOKEN or CF_API_TOKEN)');
    }
    return {
      headers: { 'cf-aig-authorization': `Bearer ${cfToken}` },
      billingMode: 'unified',
    };
  }

  if (mode === 'auto') {
    // Try unified first if a CF token is available
    if (cfToken) {
      return {
        headers: { 'cf-aig-authorization': `Bearer ${cfToken}` },
        billingMode: 'unified',
      };
    }
    // Fall back to platform credential
    return resolvePlatformKeyAuth(env, db);
  }

  // mode === 'platform-key'
  return resolvePlatformKeyAuth(env, db);
}

async function resolvePlatformKeyAuth(
  env: Env,
  db: ReturnType<typeof drizzle>,
): Promise<UpstreamAuth> {
  const encryptionKey = getCredentialEncryptionKey(env);
  const cred = await getPlatformAgentCredential(db, 'claude-code', encryptionKey);
  if (!cred?.credential) {
    throw new Error('No Anthropic API key configured. An admin must add a Claude Code platform credential.');
  }
  return {
    headers: { 'x-api-key': cred.credential },
    billingMode: 'platform-key',
  };
}
