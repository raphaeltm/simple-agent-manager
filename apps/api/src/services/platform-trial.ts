import {
  DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT,
  DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getTokenUsage } from './ai-token-budget';

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

  // Check for platform cloud credential existence (no decryption needed —
  // just verify a row exists). Previous implementation decrypted the credential
  // which could throw if the encryption key was missing or mismatched, causing
  // the trial-status endpoint to fall through to the catch-all error handler
  // and return all-false.
  const platformCloudRows = await db
    .select({ id: schema.platformCredentials.id })
    .from(schema.platformCredentials)
    .where(and(
      eq(schema.platformCredentials.credentialType, 'cloud-provider'),
      eq(schema.platformCredentials.isEnabled, true),
    ))
    .limit(1);
  const hasInfraCredential = platformCloudRows.length > 0;

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
