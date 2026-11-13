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
  type AiBudgetLimits,
  buildBudgetSettingsKey,
  MONTHLY_COST_CAP_UNAVAILABLE_MESSAGE,
} from './ai-budget-settings';
export {
  ANTHROPIC_CACHE_WRITE_PRICE_MULTIPLIER,
  findPricedModel,
  priceModelUsageUsd,
  type PricedTokenUsage,
} from './ai-cost-pricing';
export {
  aiGatewayOnlyHeaders,
  hasCloudflareAccountApi,
  hasLocalAiCostMetering,
  isMonthlyCostCapAvailable,
  resolveAiGatewayId,
} from './ai-gateway-availability';
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
  type UsageByDay,
  type UsageByModel,
  type UsageByProvider,
} from './ai-gateway-logs';
export { checkModelTierAllowance, describeModelTierDenial } from './ai-model-tier-gate';
export { type AiModelUsageRow, getLocalUsageBreakdown, incrementModelUsage } from './ai-model-usage';
export {
  buildMonthlyCostCacheKey,
  checkMonthlyCostCap,
  getCachedMonthlyCost,
  getLocalMonthlyAiCostUsd,
  type MonthlyCostCapCheck,
} from './ai-monthly-cost-cap';
export { type MonthlyCostCronResult, runMonthlyCostAggregation } from './ai-monthly-cost-cron';
export {
  buildAIGatewayMetadata,
  buildAnthropicCountTokensUrl,
  buildAnthropicGatewayUrl,
  isAnthropicModel,
  readSafeGatewayErrorDiagnostic,
  UPSTREAM_ERROR_BODY_PARSE_MAX_BYTES,
  UPSTREAM_ERROR_REASON_MAX_LENGTH,
  upstreamErrorLogFields,
  type WorkersAIChatMessage,
  WorkersAIGatewayError,
} from './ai-proxy-shared';
export {
  type AiProviderUsageAttribution,
  checkAiUsageGate,
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
  estimateInputTokensFromMessages,
  optionalExecutionContext,
} from './ai-token-usage-accounting';
export { type AiProxyEnv } from './env';
export { type AiProxyPorts } from './ports';
