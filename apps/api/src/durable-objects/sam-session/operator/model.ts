import { ModelRouterLanguageModel, ModelsDevGateway } from '@mastra/core/llm';
import type { PlatformAIModel, SamConfig } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { resolveUpstreamAuth } from '../../../services/ai-billing';
import { buildWorkersAIGatewayUrl } from '../../../services/ai-proxy-shared';
import { incrementProviderUsage, incrementTokenUsage } from '../../../services/ai-token-budget';
import { buildAnthropicGatewayUrl } from '../agent-loop-helpers';

/** Provider ID of the OpenAI-compatible Workers AI route; also its providerOptions key. */
const WORKERS_AI_PROVIDER_ID = 'sam-workers-ai';

/**
 * The language model for one private turn, routed through the SAM AI Gateway.
 * `sessionAffinity` keeps a conversation on one Workers AI instance so the repeated
 * instructions/tools/history prefix hits the prefix cache (billed at the cached rate).
 */
export async function resolveOperatorModel(
  env: Env,
  modelId: string,
  headers: { metadata: string; sessionAffinity: string }
) {
  if (modelId.startsWith('claude-')) {
    const auth = await resolveUpstreamAuth(env, drizzle(env.DATABASE));
    const gateway = new ModelsDevGateway({
      anthropic: {
        name: 'SAM Anthropic gateway',
        gateway: 'models.dev',
        models: [modelId],
        apiKeyEnvVar: '',
        url: buildAnthropicGatewayUrl(env).replace(/\/messages$/, ''),
      },
    });
    return gateway.resolveLanguageModel({
      providerId: 'anthropic',
      modelId,
      apiKey: auth.headers['x-api-key'] ?? '',
      headers: { ...auth.headers, 'cf-aig-metadata': headers.metadata },
    });
  }
  if (modelId.startsWith('@cf/') || modelId.startsWith('@hf/')) {
    return new ModelRouterLanguageModel({
      providerId: WORKERS_AI_PROVIDER_ID,
      modelId,
      url: buildWorkersAIGatewayUrl(env).replace(/\/chat\/completions$/, ''),
      apiKey: env.CF_API_TOKEN,
      headers: {
        'cf-aig-metadata': headers.metadata,
        'x-session-affinity': headers.sessionAffinity,
      },
      api: 'chat',
    });
  }
  throw new Error('Unsupported SAM model provider');
}

/** Model quirks live in one explicit boundary (compare `getTaskTitleModelControls`). */
export function operatorProviderOptions(modelId: string) {
  switch (modelId) {
    case '@cf/zai-org/glm-5.3-flash':
      // Reasoning cannot be disabled on this model; low effort keeps tool turns responsive.
      return { [WORKERS_AI_PROVIDER_ID]: { reasoningEffort: 'low' } };
    default:
      return undefined;
  }
}

interface StepUsageInput {
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  request: { body?: unknown };
  text: string;
  reasoningText: string | undefined;
  toolCalls: unknown[];
}

/** Bytes/3 over-counts typical English token density, so an estimate errs toward the budget. */
function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value ?? '') ?? '');
  return Math.ceil(new TextEncoder().encode(text).byteLength / 3);
}

/**
 * Charge one model step to the user's AI budget. A provider that omits usage (a streamed
 * response without a usage chunk) must not make the step free, so missing counts are
 * estimated from the step's own request and output and the gap is logged.
 */
export async function recordOperatorStepUsage(
  env: Env,
  userId: string,
  config: SamConfig,
  catalogModel: PlatformAIModel,
  step: StepUsageInput
): Promise<void> {
  const reportedInput = step.usage.inputTokens;
  const reportedOutput = step.usage.outputTokens;
  const input = reportedInput ?? estimateTokens(step.request.body);
  const output =
    reportedOutput ??
    estimateTokens(`${step.text}${step.reasoningText ?? ''}${JSON.stringify(step.toolCalls)}`);
  if (reportedInput === undefined || reportedOutput === undefined)
    log.warn('sam.operator.usage_estimated', {
      userId,
      model: config.model,
      inputReported: reportedInput !== undefined,
      outputReported: reportedOutput !== undefined,
      input,
      output,
    });
  const cached = Math.min(input, Math.max(0, step.usage.cachedInputTokens ?? 0));
  const cachedRate = catalogModel.costPer1kCachedInputTokens ?? catalogModel.costPer1kInputTokens;
  const anthropic = config.model.startsWith('claude-');
  await incrementTokenUsage(env.KV, userId, input, output, env);
  await incrementProviderUsage(
    env.KV,
    userId,
    {
      providerId: anthropic ? 'anthropic' : 'workers-ai',
      providerName: anthropic ? 'Anthropic' : 'Cloudflare Workers AI',
      dialect: anthropic ? 'anthropic' : 'openai',
    },
    input,
    output,
    env,
    ((input - cached) * catalogModel.costPer1kInputTokens +
      cached * cachedRate +
      output * catalogModel.costPer1kOutputTokens) /
      1000
  );
}
