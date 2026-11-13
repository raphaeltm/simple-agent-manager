import type { MastraModelConfig } from '@mastra/core/llm';
import { priceModelUsageUsd } from '@simple-agent-manager/ai-proxy';
import { incrementModelUsage } from '@simple-agent-manager/ai-proxy';
import type { PlatformAIModel, SamConfig } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { resolveUpstreamAuth } from '../../../services/ai-billing';
import { incrementProviderUsage, incrementTokenUsage } from '../../../services/ai-token-budget';
import { estimateTokensFromText } from '../../../services/ai-token-usage-accounting';
import {
  type ChatCompletionsTarget,
  chatTargetHeaders,
  fetchChatTarget,
  LlmUnavailableError,
  resolveCloudflareWorkersAiTarget,
  resolveOpenAICompatibleTarget,
} from '../../../services/llm-chat-target';
import {
  aiGatewayOnlyHeaders,
  hasLocalAiCostMetering,
} from '../../../services/platform-capabilities';
import { buildAnthropicGatewayUrl } from '../agent-loop-helpers';

/** Provider ID of the OpenAI-compatible Workers AI route; also its providerOptions key. */
const WORKERS_AI_PROVIDER_ID = 'sam-workers-ai';
/** Provider ID of an admin-configured OpenAI-compatible endpoint (no provider options). */
const OPENAI_COMPATIBLE_PROVIDER_ID = 'sam-openai-compatible';

/**
 * The language model for one private turn, routed through the SAM AI Gateway.
 * `sessionAffinity` keeps a conversation on one Workers AI instance so the repeated
 * instructions/tools/history prefix hits the prefix cache (billed at the cached rate).
 */
export async function resolveOperatorModel(
  env: Env,
  modelId: string,
  headers: { metadata: string; sessionAffinity: string }
): Promise<MastraModelConfig> {
  const { ModelRouterLanguageModel, ModelsDevGateway } = await import('@mastra/core/llm');
  // An admin-configured OpenAI-compatible endpoint replaces the model route for the agent.
  const endpoint = await resolveOpenAICompatibleTarget(env, 'agent', modelId);
  if (endpoint) return openAICompatibleEndpointModel(endpoint, headers);
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
      headers: {
        ...auth.headers,
        ...aiGatewayOnlyHeaders(env, { 'cf-aig-metadata': headers.metadata }),
      },
    });
  }
  if (modelId.startsWith('@cf/') || modelId.startsWith('@hf/')) {
    const target = resolveCloudflareWorkersAiTarget(env, modelId);
    if (!target) throw new LlmUnavailableError('agent');
    return new ModelRouterLanguageModel({
      providerId: WORKERS_AI_PROVIDER_ID,
      modelId,
      url: target.baseUrl,
      apiKey: env.CF_API_TOKEN,
      headers: chatHeadersWithoutAuth(target, headers),
      api: 'chat',
    });
  }
  throw new Error('Unsupported SAM model provider');
}

/**
 * The chat model for an admin-configured endpoint. This is what `ModelRouterLanguageModel` builds
 * for a `url` config (the same @ai-sdk/openai-compatible version, `chatModel`, structured
 * outputs on), built directly because the router has no `fetch` option: every request, including
 * each redirect hop, must go through the endpoint's guarded fetch (`fetchChatTarget`).
 */
async function openAICompatibleEndpointModel(
  endpoint: ChatCompletionsTarget,
  headers: { metadata: string; sessionAffinity: string }
): Promise<MastraModelConfig> {
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  return createOpenAICompatible({
    name: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseURL: endpoint.baseUrl,
    apiKey: endpoint.apiKey ?? undefined,
    headers: chatHeadersWithoutAuth(endpoint, headers),
    supportsStructuredOutputs: true,
    fetch: (input, init) =>
      fetchChatTarget(endpoint, init ?? {}, input instanceof Request ? input.url : String(input)),
  }).chatModel(endpoint.model);
}

/** The router sets Authorization from apiKey; gateway attribution goes to Cloudflare only. */
function chatHeadersWithoutAuth(
  target: ChatCompletionsTarget,
  headers: { metadata: string; sessionAffinity: string }
): Record<string, string> {
  const all = chatTargetHeaders(target, {
    'cf-aig-metadata': headers.metadata,
    'x-session-affinity': headers.sessionAffinity,
  });
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => name !== 'Authorization' && name !== 'Content-Type')
  );
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
  const input = reportedInput ?? estimateTokensFromText(step.request.body);
  const output =
    reportedOutput ??
    estimateTokensFromText(
      `${step.text}${step.reasoningText ?? ''}${JSON.stringify(step.toolCalls)}`
    );
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
  const anthropic = config.model.startsWith('claude-');
  const costUsd = priceModelUsageUsd(catalogModel, {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
  });
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
    costUsd
  );
  if (hasLocalAiCostMetering(env)) {
    await incrementModelUsage(
      env,
      userId,
      config.model,
      anthropic ? 'anthropic' : 'workers-ai',
      input,
      output,
      costUsd
    );
  }
}
