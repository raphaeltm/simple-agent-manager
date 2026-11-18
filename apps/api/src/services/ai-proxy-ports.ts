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

/**
 * Read the strict admin-settings snapshot (cached for at most 60 seconds). A failed read must
 * remain a failure: defaulting to zero or retaining an older disabled/higher ceiling could spend
 * beyond the operator's current limit. The package maps the failure to a retryable 503.
 */
async function readMonthlyCostCeilingUsd(env: Env): Promise<number> {
  const { value } = await resolveAdminSettingDetails(
    env,
    AI_PROXY_PER_USER_MONTHLY_COST_CEILING_SETTING
  );
  return Number(value);
}
