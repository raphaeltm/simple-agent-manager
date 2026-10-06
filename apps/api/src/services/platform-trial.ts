import type { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getTokenUsage, resolvePlatformDailyTokenLimits } from './ai-token-budget';
import { getPlatformCloudCredential } from './platform-credentials';

export interface TrialStatus {
  available: boolean;
  agentType: 'opencode' | null;
  hasInfraCredential: boolean;
  hasAgentCredential: boolean;
  dailyTokenBudget: { input: number; output: number } | null;
  dailyTokenUsage: { input: number; output: number } | null;
}

export interface PlatformOpencodeAvailability {
  available: boolean;
  hasInfraCredential: boolean;
  hasAgentCredential: boolean;
}

/**
 * Check whether the platform OpenCode path is available.
 * Requires: (1) a platform cloud credential exists, and (2) the AI proxy is enabled.
 */
export async function getPlatformOpencodeAvailability(
  db: ReturnType<typeof drizzle>,
  env: Env
): Promise<PlatformOpencodeAvailability> {
  const aiProxyEnabled = (env.AI_PROXY_ENABLED ?? 'true') !== 'false';

  // This is a user-facing capability signal, so credential decryption failures
  // fail closed instead of advertising platform infrastructure as available.
  const encryptionKey = getCredentialEncryptionKey(env);
  let hasInfraCredential = false;
  try {
    const platformCloud = await getPlatformCloudCredential(db, encryptionKey);
    hasInfraCredential = platformCloud !== null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'OperationError') {
      hasInfraCredential = false;
    } else {
      throw err;
    }
  }

  // The AI proxy itself serves as the agent credential (no separate platform agent credential needed)
  const hasAgentCredential = aiProxyEnabled;

  return {
    available: hasInfraCredential && hasAgentCredential,
    hasInfraCredential,
    hasAgentCredential,
  };
}

/**
 * Check whether the platform trial is available for the current user.
 */
export async function getTrialStatus(
  db: ReturnType<typeof drizzle>,
  userId: string,
  env: Env
): Promise<TrialStatus> {
  const availability = await getPlatformOpencodeAvailability(db, env);

  if (!availability.available) {
    return {
      available: false,
      agentType: null,
      hasInfraCredential: availability.hasInfraCredential,
      hasAgentCredential: availability.hasAgentCredential,
      dailyTokenBudget: null,
      dailyTokenUsage: null,
    };
  }

  // Fetch current daily usage
  const usage = await getTokenUsage(env.KV, userId, env);

  const { dailyInputTokenLimit: inputLimit, dailyOutputTokenLimit: outputLimit } =
    resolvePlatformDailyTokenLimits(env);

  return {
    available: true,
    agentType: 'opencode',
    hasInfraCredential: availability.hasInfraCredential,
    hasAgentCredential: availability.hasAgentCredential,
    dailyTokenBudget: { input: inputLimit, output: outputLimit },
    dailyTokenUsage: { input: usage.inputTokens, output: usage.outputTokens },
  };
}
