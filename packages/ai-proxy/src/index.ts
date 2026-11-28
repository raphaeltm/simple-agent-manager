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
  buildCostEstimateWrite,
  type CostEstimateWrite,
  parseGatewayMonthlyCost,
} from './ai-cost-estimate';
export { findPricedModel, priceModelUsageUsd } from './ai-cost-pricing';
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
export { getLocalUsageBreakdown } from './ai-model-usage';
export {
  getGatewayDirectMonthlySpendUsd,
  getLocalMonthlyAiCostUsd,
  type MonthlyCostCapCheck,
  monthlyCostCapMessage,
} from './ai-monthly-cost-cap';
export { type MonthlyCostCronResult, runMonthlyCostAggregation } from './ai-monthly-cost-cron';
export type { WorkersAIChatCompletionOptions, WorkersAIChatMessage } from './ai-proxy-shared';
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
  AI_TEST_UPSTREAM_COST_HEADER,
  AI_TEST_UPSTREAM_GATE_HEADER,
  AI_TEST_UPSTREAM_GATE_VALUE,
  AI_TEST_UPSTREAM_MAX_COST_USD,
} from './ai-test-upstream-contract';
export {
  buildFakeUpstreamResponse,
  FAKE_UPSTREAM_INPUT_TOKENS,
  FAKE_UPSTREAM_TEXT,
  type FakeUsage,
  fakeUsageForCost,
} from './ai-test-upstream-responses';
export {
  type AiProviderUsageAttribution,
  checkAiUsageGate,
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
  MONTHLY_COST_CAP_UNAVAILABLE_MESSAGE,
  type MonthlyCostCeilingPort,
  releaseFeatureTokenBudget,
  resolveEffectiveLimits,
  resolveMonthlyCostCeilingUsd,
  resolvePlatformDailyTokenLimits,
  saveUserBudgetSettings,
  validateBudgetUpdate,
} from './ai-token-budget';
export { AiTokenBudgetCounter } from './ai-token-budget-counter';
export {
  attachTokenUsageAccounting,
  attachUpstreamTokenUsageAccounting,
  estimateInputTokensFromMessages,
  estimateInputTokensFromRequest,
  type MeasuredTokenUsage,
  measuredTokenUsage,
  optionalExecutionContext,
} from './ai-token-usage-accounting';
export { type AiProxyEnv } from './env';
export {
  type ChatCompletionsTarget,
  chatTarget,
  chatTargetHeaders,
  fetchChatTarget,
  isCloudflareChatTarget,
  LlmUnavailableError,
} from './llm-chat-target';
export { type AiProxyPorts } from './ports';
