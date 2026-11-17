// Worker implementation of @simple-agent-manager/ai-proxy's ports, bound to one environment.
import type { AiProxyPorts } from '@simple-agent-manager/ai-proxy';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { resolveAdminSetting, resolveAdminSettingDetails } from './admin-settings-resolution';
import { AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING } from './ai-proxy-settings';
import { getPlatformAgentCredential } from './platform-credentials';

/**
 * Bind the AI proxy ports to `env`. Pass `db` when the caller already holds a drizzle handle,
 * so platform-key billing reads through the same connection it always did.
 */
export function aiProxyPorts(env: Env, db?: ReturnType<typeof drizzle>): AiProxyPorts {
  return {
    getPlatformAnthropicKey: async () => {
      const cred = await getPlatformAgentCredential(
        db ?? drizzle(env.DATABASE),
        'claude-code',
        getCredentialEncryptionKey(env)
      );
      return cred ? { credentialId: cred.credentialId, credential: cred.credential } : null;
    },
    externalReadTimeoutMs: async () =>
      Number(await resolveAdminSetting(env, 'performance.externalReadTimeoutMs')),
    monthlyCostCeilingUsd: () => readMonthlyCostCeilingUsd(env),
  };
}

/** The last ceiling this isolate read successfully, served while settings are unreadable. */
let lastKnownCeilingUsd: number | null = null;

/**
 * The per-user monthly ceiling from the per-isolate admin settings snapshot (at most one D1 read
 * per cache TTL, 60 s max, so a changed ceiling applies within that TTL). Unlike
 * `resolveAdminSetting`, which turns an outage into the default (0, no ceiling), an unreadable
 * snapshot serves the last value this isolate read, and throws only on a cold isolate; the caller
 * logs that and applies no ceiling (`resolveMonthlyCostCeilingUsd`).
 */
async function readMonthlyCostCeilingUsd(env: Env): Promise<number> {
  try {
    const { value } = await resolveAdminSettingDetails(
      env,
      AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING
    );
    lastKnownCeilingUsd = Number(value);
    return lastKnownCeilingUsd;
  } catch (err) {
    if (lastKnownCeilingUsd !== null) return lastKnownCeilingUsd;
    throw err;
  }
}

/** Test seam: forget the last-known ceiling between cases. */
export function __resetLastKnownCeilingForTest(): void {
  lastKnownCeilingUsd = null;
}
