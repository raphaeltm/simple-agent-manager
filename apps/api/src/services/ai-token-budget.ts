// Moved to @simple-agent-manager/ai-proxy (worker modularization W5). Re-exported so the
// worker's existing importers are unchanged.
import {
  checkAiUsageGate as checkAiUsageGateWithPorts,
  resolveMonthlyCostCeilingUsd as resolveCeiling,
} from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import { aiProxyPorts } from './ai-proxy-ports';

export {
  type AiProviderUsageAttribution,
  consumeFeatureTokenBudget,
  deleteUserBudgetSettings,
  effectiveMonthlyCostCapUsd,
  getAdminAiAllowance,
  getAiBudgetLimits,
  getFeatureTokenBudget,
  getProviderUsage,
  getTokenUsage,
  getUserBudgetSettings,
  incrementProviderUsage,
  incrementTokenUsage,
  releaseFeatureTokenBudget,
  resolveEffectiveLimits,
  resolvePlatformDailyTokenLimits,
  saveUserBudgetSettings,
  validateBudgetUpdate,
} from '@simple-agent-manager/ai-proxy';

/**
 * Every pre-request AI usage limit, with the installation-wide monthly ceiling bound to this
 * worker's admin settings. Every worker caller goes through here, so none can leave the ceiling
 * out (rule 61); the ceiling is read only where SAM meters spend itself.
 */
export function checkAiUsageGate(kv: KVNamespace, userId: string, env: Env) {
  return checkAiUsageGateWithPorts(kv, userId, env, aiProxyPorts(env));
}

/** The installation ceiling where it applies (null with an AI Gateway, or when unset). */
export function resolveMonthlyCostCeilingUsd(env: Env): Promise<number | null> {
  return resolveCeiling(env, aiProxyPorts(env));
}
