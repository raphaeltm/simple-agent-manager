import {
  DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT,
  DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT,
} from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getTokenUsage } from './ai-token-budget';
import { getPlatformCloudCredential } from './platform-credentials';

export interface TrialStatus {
  available: boolean;
  agentType: 'opencode' | null;
  hasInfraCredential: boolean;
  hasAgentCredential: boolean;
  dailyTokenBudget: { input: number; output: number } | null;
  dailyTokenUsage: { input: number; output: number } | null;
}

/**
 * Check whether the platform trial is available for the current user.
 * Trial requires: (1) a platform cloud credential exists, and (2) the AI proxy is enabled.
 */
export async function getTrialStatus(
  db: ReturnType<typeof drizzle>,
  userId: string,
  env: Env,
): Promise<TrialStatus> {
  const aiProxyEnabled = (env.AI_PROXY_ENABLED ?? 'true') !== 'false';

  // Check for platform cloud credential. Decryption can fail with a DOMException
  // (OperationError) if the encryption key is mismatched between environments.
  // Let config errors (missing key) propagate — outer handler returns available: false.
  let hasInfraCredential = false;
  const encryptionKey = getCredentialEncryptionKey(env);
  try {
    const platformCloud = await getPlatformCloudCredential(db, encryptionKey);
    hasInfraCredential = platformCloud !== null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'OperationError') {
      // Decryption failure — credential row exists but can't be decrypted.
      // Still counts as "infra available" since provisioning uses a different
      // code path that handles its own decryption.
      hasInfraCredential = true;
    } else {
      throw err; // D1 failures, network errors — propagate to outer handler
    }
  }

  // The AI proxy itself serves as the agent credential (no separate platform agent credential needed)
  const hasAgentCredential = aiProxyEnabled;

  const available = hasInfraCredential && hasAgentCredential;

  if (!available) {
    return {
      available: false,
      agentType: null,
      hasInfraCredential,
      hasAgentCredential,
      dailyTokenBudget: null,
      dailyTokenUsage: null,
    };
  }

  // Fetch current daily usage
  const usage = await getTokenUsage(env.KV, userId);

  const inputLimit = parseInt(env.AI_PROXY_DAILY_INPUT_TOKEN_LIMIT ?? '', 10) || DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT;
  const outputLimit = parseInt(env.AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT ?? '', 10) || DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT;

  return {
    available: true,
    agentType: 'opencode',
    hasInfraCredential,
    hasAgentCredential,
    dailyTokenBudget: { input: inputLimit, output: outputLimit },
    dailyTokenUsage: { input: usage.inputTokens, output: usage.outputTokens },
  };
}
