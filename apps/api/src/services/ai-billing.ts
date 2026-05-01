/**
 * AI proxy billing mode resolution.
 *
 * Determines which upstream authentication to use for AI Gateway requests:
 * - Unified Billing: `cf-aig-authorization: Bearer <CF_AIG_TOKEN>` (Cloudflare credits)
 * - Platform Key: `x-api-key: <stored-api-key>` (admin-managed provider credential)
 * - Auto: try unified first, fall back to platform key if CF_AIG_TOKEN is absent
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
 * Resolve upstream authentication headers for Anthropic model requests.
 *
 * Resolution order depends on billing mode:
 * - 'unified': Use CF_AIG_TOKEN via cf-aig-authorization header. Error if token missing.
 * - 'platform-key': Use stored platform credential via x-api-key header. Error if missing.
 * - 'auto' (default): Try unified if CF_AIG_TOKEN exists, else fall back to platform key.
 */
export async function resolveUpstreamAuth(
  env: Env,
  db: ReturnType<typeof drizzle>,
): Promise<UpstreamAuth> {
  const mode = await resolveBillingMode(env);

  if (mode === 'unified') {
    if (!env.CF_AIG_TOKEN) {
      throw new Error('Unified Billing enabled but CF_AIG_TOKEN is not configured');
    }
    return {
      headers: { 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}` },
      billingMode: 'unified',
    };
  }

  if (mode === 'auto') {
    // Try unified first if CF_AIG_TOKEN is available
    if (env.CF_AIG_TOKEN) {
      return {
        headers: { 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}` },
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
