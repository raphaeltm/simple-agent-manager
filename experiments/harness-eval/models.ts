/**
 * Model configurations for the eval suite.
 *
 * All models route through SAM's AI Gateway (gateway ID: "sam").
 * Workers AI models use the /workers-ai/v1/chat/completions path.
 * Unified API models use the /compat/chat/completions path.
 *
 * Cost note: Workers AI models are treated as Cloudflare-billed, not free.
 * We use estimated Cloudflare Workers AI pricing ($0.011/1M neurons).
 */

import type { ModelConfig } from './types.js';
import { getWorkersAiCostPer1k } from './cost.js';

/** Build the set of models to evaluate. */
export function getEvalModels(): ModelConfig[] {
  const waiCost = getWorkersAiCostPer1k();

  return [
    {
      displayName: 'Gemma 4 26B',
      modelId: '@cf/google/gemma-4-26b-a4b-it',
      apiModelId: '@cf/google/gemma-4-26b-a4b-it',
      path: 'workers-ai',
      costPer1kInput: waiCost,
      costPer1kOutput: waiCost,
      provider: 'workers-ai',
    },
    {
      displayName: 'GPT-4.1 Mini',
      modelId: 'gpt-4.1-mini',
      apiModelId: 'openai/gpt-4.1-mini',
      path: 'unified',
      costPer1kInput: 0.0004,
      costPer1kOutput: 0.0016,
      provider: 'openai',
    },
    {
      displayName: 'Claude Haiku 4.5',
      modelId: 'claude-haiku-4-5-20251001',
      apiModelId: 'anthropic/claude-haiku-4-5-20251001',
      path: 'unified',
      costPer1kInput: 0.0008,
      costPer1kOutput: 0.004,
      provider: 'anthropic',
    },
    // GPT-5 Mini: not yet in PLATFORM_AI_MODELS registry.
    // The closest available model is gpt-5.2. Uncomment when gpt-5-mini lands
    // or update the apiModelId to the correct Unified API identifier.
    // {
    //   displayName: 'GPT-5 Mini',
    //   modelId: 'gpt-5-mini',
    //   apiModelId: 'openai/gpt-5-mini',
    //   path: 'unified',
    //   costPer1kInput: 0.002,    // TBD — placeholder
    //   costPer1kOutput: 0.008,   // TBD — placeholder
    //   provider: 'openai',
    // },
  ];
}

/**
 * Build the AI Gateway URL for a model.
 */
export function buildGatewayUrl(
  accountId: string,
  gatewayId: string,
  model: ModelConfig,
): string {
  if (model.path === 'workers-ai') {
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`;
}

/**
 * Build request headers for a model.
 */
export function buildHeaders(model: ModelConfig, authToken: string): Record<string, string> {
  const metadata = JSON.stringify({
    userId: 'harness-eval',
    workspaceId: 'harness-eval',
    projectId: 'harness-eval',
    source: 'harness-eval-suite',
    modelId: model.modelId,
  });

  if (model.path === 'workers-ai') {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'cf-aig-metadata': metadata,
    };
  }
  // Unified API
  return {
    'Content-Type': 'application/json',
    'cf-aig-authorization': `Bearer ${authToken}`,
    'cf-aig-metadata': metadata,
  };
}
