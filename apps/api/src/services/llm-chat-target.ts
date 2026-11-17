/** Worker settings adapter. Protocol targets and guarded fetch live in packages/ai-proxy. */
import {
  type ChatCompletionsTarget,
  chatTarget,
  LlmUnavailableError,
} from '@simple-agent-manager/ai-proxy';
import { classifyHost } from '@simple-agent-manager/worker-core';

import type { Env } from '../env';
import { DEFAULT_CONFIG_READ_TIMEOUT_MS } from './config-read-deadline';
import { withDeadline } from './fetch-timeout';
import {
  LLM_PURPOSE_MODEL_SETTING,
  type LlmPurpose,
  normalizeLlmBaseUrl,
} from './llm-endpoint-settings';
import { resolveLlmEndpointSettings } from './llm-endpoint-snapshot';
import { outboundMaxRedirectsValue } from './outbound-fetch-settings';
import {
  hasCloudflareAccountApi,
  resolveAiGatewayId,
  resolveLlmEndpointCapability,
} from './platform-capabilities';

export type { LlmPurpose } from './llm-endpoint-settings';
export {
  type ChatCompletionsTarget,
  chatTargetHeaders,
  fetchChatTarget,
  isCloudflareChatTarget,
  LlmUnavailableError,
} from '@simple-agent-manager/ai-proxy';

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The capability reads the shared per-isolate settings snapshot, never the key on the default path. */
export async function resolveOpenAICompatibleTarget(
  env: Env,
  purpose: LlmPurpose,
  requestedModel: string | null = null
): Promise<ChatCompletionsTarget | null> {
  if (!(await resolveLlmEndpointCapability(env))) return null;
  try {
    // Re-read the URL with its key/model under the same mutation generation.
    const details = await resolveLlmEndpointSettings(env, [
      'llm.openAICompatible.baseUrl',
      'llm.openAICompatible.apiKey',
      'llm.openAICompatible.model',
      LLM_PURPOSE_MODEL_SETTING[purpose],
      'llm.openAICompatible.allowPrivateNetwork',
      'outbound.maxRedirects',
    ]);
    const [baseUrl, key, fallbackModel, purposeModel, privateNetwork, redirects] = details.map(
      (d) => d.value
    );
    if (baseUrl === null) return null; // Admin reset the endpoint between the gate and batch.
    if (typeof baseUrl !== 'string') throw new LlmUnavailableError(purpose, 'settings_unreadable');
    const model = nonempty(purposeModel) ?? nonempty(fallbackModel) ?? requestedModel;
    // An explicitly configured route must never silently fall back to another provider.
    if (!model) throw new LlmUnavailableError(purpose, 'not_configured');
    const normalized = normalizeLlmBaseUrl(baseUrl);
    if (privateNetwork !== true && classifyHost(new URL(normalized).hostname) === 'private') {
      throw new LlmUnavailableError(purpose, 'private_network_not_allowed');
    }
    return {
      ...chatTarget('openai-compatible', normalized, nonempty(key), model, privateNetwork === true),
      maxRedirects: outboundMaxRedirectsValue(redirects),
    };
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    throw new LlmUnavailableError(purpose, 'settings_unreadable');
  }
}

export function resolveCloudflareWorkersAiTarget(
  env: Pick<Env, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>,
  model: string
): ChatCompletionsTarget | null {
  const gatewayId = resolveAiGatewayId(env);
  if (gatewayId)
    return chatTarget(
      'cloudflare-gateway',
      `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1`,
      env.CF_API_TOKEN,
      model
    );
  if (hasCloudflareAccountApi(env))
    return chatTarget(
      'cloudflare-api',
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
      env.CF_API_TOKEN,
      model
    );
  return null;
}

export async function resolveWorkersAiChatTarget(env: Env, purpose: LlmPurpose, model: string) {
  return (
    (await resolveOpenAICompatibleTarget(env, purpose, model)) ??
    resolveCloudflareWorkersAiTarget(env, model)
  );
}

/** Allocate at most a quarter of the caller's budget to settings, preserving time for inference. */
export async function resolveWorkersAiChatTargetWithin(
  env: Env,
  purpose: LlmPurpose,
  model: string,
  timeoutMs: number
) {
  try {
    return await withDeadline(
      () => resolveWorkersAiChatTarget(env, purpose, model),
      Math.max(1, Math.min(DEFAULT_CONFIG_READ_TIMEOUT_MS, timeoutMs / 4))
    );
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    throw new LlmUnavailableError(purpose, 'settings_unreadable');
  }
}
