// Public entry of @simple-agent-manager/ai-proxy. Named re-exports of what the worker uses.
export {
  createAnthropicToOpenAIStream,
  translateRequestToAnthropic,
  translateResponseToOpenAI,
} from './ai-anthropic-translate';
export {
  resolveBillingMode,
  resolveUnifiedBillingToken,
  resolveUpstreamAuth,
  type UpstreamAuth,
} from './ai-billing';
export {
  aggregateByDay,
  aggregateByModel,
  aggregateByProvider,
  type AIGatewayLogEntry,
  type GatewayPaginationOptions,
  type GatewayPeriod,
  getGatewayPeriodBounds,
  getPeriodLabel,
  iterateGatewayLogs,
  parseGatewayPeriod,
  resolveGatewayPagination,
  type UsageByDay,
  type UsageByModel,
  type UsageByProvider,
} from './ai-gateway-logs';
export { checkModelTierAllowance, describeModelTierDenial } from './ai-model-tier-gate';
export {
  MAX_MONTHLY_COST_CACHE_TTL_SECONDS,
  type MonthlyCostCronResult,
  resolveMonthlyCostCacheTtlSeconds,
  runMonthlyCostAggregation,
} from './ai-monthly-cost-cron';
export {
  buildAIGatewayMetadata,
  buildAnthropicCountTokensUrl,
  buildAnthropicGatewayUrl,
  buildWorkersAIGatewayUrl,
  fetchWorkersAIChatCompletion,
  isAnthropicModel,
  readSafeGatewayErrorDiagnostic,
  WorkersAIGatewayError,
} from './ai-proxy-shared';
export {
  type AiProviderUsageAttribution,
  buildBudgetKey,
  buildBudgetSettingsKey,
  buildFeatureBudgetKey,
  buildMonthlyCostCacheKey,
  buildProviderUsageKey,
  checkAiUsageGate,
  checkMonthlyCostCap,
  checkTokenBudget,
  consumeFeatureTokenBudget,
  deleteUserBudgetSettings,
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
} from './ai-token-budget';
export { AiTokenBudgetCounter } from './ai-token-budget-counter';
export {
  attachTokenUsageAccounting,
  attachUpstreamTokenUsageAccounting,
  collectStreamTokenUsage,
  estimateInputTokensFromMessages,
  extractJsonTokenUsage,
  optionalExecutionContext,
} from './ai-token-usage-accounting';
export { type AiProxyEnv } from './env';
export { type AiProxyPorts, type PlatformAgentKey } from './ports';
