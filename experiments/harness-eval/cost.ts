/**
 * Cost computation for eval runs.
 *
 * Workers AI models are treated as Cloudflare-billed (not free) per task requirements.
 * The estimated cost uses Cloudflare's published Workers AI Everywhere pricing
 * ($0.011 per 1M input neurons, $0.011 per 1M output neurons ≈ $0.011/1K tokens).
 * This is an estimate — actual billing depends on the Cloudflare plan.
 *
 * For Unified API models (Anthropic, OpenAI), costs are hardcoded in models.ts
 * (matching PLATFORM_AI_MODELS registry values at time of writing).
 */

import type { ModelConfig, TokenUsage, ScenarioResult, EvalSummary } from './types.js';

/** Estimated Workers AI cost per 1K tokens (input and output).
 * Based on Cloudflare's Workers AI pricing at scale ($0.011 / 1M neurons ≈ $0.000011 / 1K tokens).
 * Override via WORKERS_AI_COST_PER_1K_TOKENS env var for updated pricing. */
const DEFAULT_WORKERS_AI_COST_PER_1K = 0.000011;

/**
 * Compute the USD cost of a single API call.
 */
export function computeCost(model: ModelConfig, usage: TokenUsage): number {
  const inputCost = (usage.prompt_tokens / 1000) * model.costPer1kInput;
  const outputCost = (usage.completion_tokens / 1000) * model.costPer1kOutput;
  return inputCost + outputCost;
}

/**
 * Get the Workers AI estimated cost per 1K tokens.
 * Reads WORKERS_AI_COST_PER_1K_TOKENS env var if set.
 */
export function getWorkersAiCostPer1k(): number {
  const envVal = process.env.WORKERS_AI_COST_PER_1K_TOKENS;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_WORKERS_AI_COST_PER_1K;
}

/**
 * Compute aggregate summary from individual scenario results.
 */
export function computeSummary(results: ScenarioResult[]): EvalSummary {
  const totalScenarios = results.length;
  const passedScenarios = results.filter((r) => r.rubric.pass).length;
  const successRate = totalScenarios > 0 ? passedScenarios / totalScenarios : 0;
  const totalCostUsd = results.reduce((sum, r) => sum + r.costUsd, 0);
  const costPerSuccessUsd = passedScenarios > 0 ? totalCostUsd / passedScenarios : Infinity;
  const avgLatencyMs =
    totalScenarios > 0 ? results.reduce((sum, r) => sum + r.latencyMs, 0) / totalScenarios : 0;

  // Per-model breakdown
  const modelMap = new Map<
    string,
    {
      model: string;
      provider: string;
      runs: ScenarioResult[];
    }
  >();
  for (const r of results) {
    const key = r.model.modelId;
    if (!modelMap.has(key)) {
      modelMap.set(key, { model: r.model.displayName, provider: r.model.provider, runs: [] });
    }
    modelMap.get(key)!.runs.push(r);
  }

  const perModel = Array.from(modelMap.values()).map(({ model, provider, runs }) => {
    const passed = runs.filter((r) => r.rubric.pass).length;
    const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
    const totalTokens = runs.reduce((s, r) => s + r.usage.total_tokens, 0);
    return {
      model,
      provider,
      totalRuns: runs.length,
      passed,
      successRate: runs.length > 0 ? passed / runs.length : 0,
      totalCostUsd: totalCost,
      costPerSuccessUsd: passed > 0 ? totalCost / passed : Infinity,
      avgLatencyMs: runs.length > 0 ? runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length : 0,
      totalTokens,
    };
  });

  return {
    totalScenarios,
    passedScenarios,
    successRate,
    totalCostUsd,
    costPerSuccessUsd,
    avgLatencyMs,
    perModel,
  };
}
