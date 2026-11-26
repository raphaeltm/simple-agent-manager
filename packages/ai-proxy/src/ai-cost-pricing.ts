/**
 * List-price estimate of one model call, from SAM's own price table (`PLATFORM_AI_MODELS`).
 *
 * The spend record where SAM is the only one: the SAM operator model, and the AI proxy on an
 * installation without Cloudflare AI Gateway (`hasLocalAiCostMetering`). With a gateway it only
 * backstops the gateway total (ai-cost-estimate.ts). It misses provider
 * discounts and batch rates and lags provider price changes until the catalog is updated; the
 * provider invoice stays authoritative. Good enough for a per-user cap.
 */
import { PLATFORM_AI_MODELS, type PlatformAIModel } from '@simple-agent-manager/shared';

/**
 * Anthropic bills a 5-minute prompt-cache write at 1.25x the base input price (Anthropic pricing,
 * "Prompt caching"). The catalog carries no write price, so the multiplier lives here.
 */
export const ANTHROPIC_CACHE_WRITE_PRICE_MULTIPLIER = 1.25;

export interface PricedTokenUsage {
  /** Every prompt token, including the cached and cache-write ones below. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens read from the provider's cache (cached-input price). */
  cachedInputTokens?: number;
  /** Prompt tokens written to the provider's cache (input price x the write multiplier). */
  cacheWriteInputTokens?: number;
}

export function findPricedModel(modelId: string): PlatformAIModel | null {
  return PLATFORM_AI_MODELS.find((model) => model.id === modelId) ?? null;
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** USD for one call at catalog list prices. */
export function priceModelUsageUsd(model: PlatformAIModel, usage: PricedTokenUsage): number {
  const input = nonNegative(usage.inputTokens);
  const cached = Math.min(input, nonNegative(usage.cachedInputTokens));
  const cacheWrite = Math.min(input - cached, nonNegative(usage.cacheWriteInputTokens));
  const uncached = input - cached - cacheWrite;
  const cachedRate = model.costPer1kCachedInputTokens ?? model.costPer1kInputTokens;
  return (
    (uncached * model.costPer1kInputTokens +
      cached * cachedRate +
      cacheWrite * model.costPer1kInputTokens * ANTHROPIC_CACHE_WRITE_PRICE_MULTIPLIER +
      nonNegative(usage.outputTokens) * model.costPer1kOutputTokens) /
    1000
  );
}

/**
 * Price one response as the upstream reported it: the catalog model for `costModelId` (null when
 * unset or not in the catalog, which prices $0) and its list-price cost. Anthropic reports cache
 * reads and writes outside `inputTokens`; OpenAI includes them, so only Anthropic adds them back.
 */
export function priceReportedUsage(
  costModelId: string | undefined,
  usage: {
    anthropicFormat: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }
): { model: PlatformAIModel | null; costUsd: number } {
  const model = costModelId ? findPricedModel(costModelId) : null;
  if (!model) return { model: null, costUsd: 0 };
  const { cacheReadTokens: cached, cacheWriteTokens: writes } = usage;
  return {
    model,
    costUsd: priceModelUsageUsd(model, {
      inputTokens: usage.anthropicFormat ? usage.inputTokens + cached + writes : usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: cached,
      cacheWriteInputTokens: writes,
    }),
  };
}
