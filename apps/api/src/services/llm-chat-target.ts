/**
 * Where SAM's own OpenAI-format chat calls go: one resolver for the SAM agent, project agents,
 * task titles, the diagnosis runner and the AI proxy's Workers AI route (rule 24).
 *
 * Order:
 * 1. An admin-configured OpenAI-compatible endpoint (`llm.openAICompatible.*`). Explicit opt-in,
 *    so it wins wherever it is set.
 * 2. Cloudflare AI Gateway's Workers AI route, when the gateway is reachable.
 * 3. Cloudflare's Workers AI REST API, when the account API is configured.
 * 4. Nothing: the caller reports that no model is available here.
 *
 * A Cloudflare deployment with no endpoint configured resolves exactly the URLs it used before.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting, resolveAdminSettingDetailsMany } from './admin-settings-resolution';
import {
  LLM_PURPOSE_MODEL_SETTING,
  type LlmPurpose,
  normalizeLlmBaseUrl,
  validLlmBaseUrl,
} from './llm-endpoint-settings';
import { hasCloudflareAccountApi, resolveAiGatewayId } from './platform-capabilities';

export type { LlmPurpose } from './llm-endpoint-settings';

export interface ChatCompletionsTarget {
  kind: 'openai-compatible' | 'cloudflare-gateway' | 'cloudflare-api';
  /** OpenAI-style base URL, without `/chat/completions`. */
  baseUrl: string;
  /** The chat completions URL. */
  url: string;
  /** Bearer token, or null when the endpoint takes none. */
  apiKey: string | null;
  /** Model id to send. */
  model: string;
  /**
   * Redirect policy for the request. An admin-configured endpoint must not bounce the call (and
   * its prompt) to a host the URL validation never saw; Cloudflare targets keep fetch's default.
   */
  redirect: 'error' | 'follow';
}

/** No endpoint can serve this call on this installation. A designed state, not a fault. */
export class LlmUnavailableError extends Error {
  constructor(readonly purpose: LlmPurpose) {
    super(
      'No language model is available on this installation. Configure an OpenAI-compatible endpoint in admin settings (AI models).'
    );
    this.name = 'LlmUnavailableError';
  }
}

export function isCloudflareChatTarget(target: ChatCompletionsTarget): boolean {
  return target.kind !== 'openai-compatible';
}

function chatTarget(
  kind: ChatCompletionsTarget['kind'],
  baseUrl: string,
  apiKey: string | null,
  model: string
): ChatCompletionsTarget {
  return {
    kind,
    baseUrl,
    url: `${baseUrl}/chat/completions`,
    apiKey,
    model,
    redirect: kind === 'openai-compatible' ? 'error' : 'follow',
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The admin-configured OpenAI-compatible endpoint for `purpose`, or null when none is set.
 * `requestedModel` is used only when no endpoint model is configured.
 *
 * The base URL is read first and alone: it is a plain setting, so an installation without an
 * endpoint never queries the credential table, and a settings outage resolves it to its default
 * (no endpoint), which keeps the Cloudflare route working as before. Once an endpoint IS
 * configured, failing to read its key or models must not silently send the call to another
 * provider, so that throws instead.
 */
export async function resolveOpenAICompatibleTarget(
  env: Env,
  purpose: LlmPurpose,
  requestedModel: string | null = null
): Promise<ChatCompletionsTarget | null> {
  const baseUrl = await resolveAdminSetting(env, 'llm.openAICompatible.baseUrl');
  if (!validLlmBaseUrl(baseUrl)) return null;
  let values: unknown[];
  try {
    const details = await resolveAdminSettingDetailsMany(env, [
      'llm.openAICompatible.apiKey',
      'llm.openAICompatible.model',
      LLM_PURPOSE_MODEL_SETTING[purpose],
    ]);
    values = details.map((detail) => detail.value);
  } catch (err) {
    log.error('llm.endpoint_settings_unreadable', {
      purpose,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new LlmUnavailableError(purpose);
  }
  const [apiKey, defaultModel, purposeModel] = values;
  const model = stringValue(purposeModel) ?? stringValue(defaultModel) ?? requestedModel;
  if (!model) return null;
  return chatTarget(
    'openai-compatible',
    normalizeLlmBaseUrl(String(baseUrl)),
    stringValue(apiKey),
    model
  );
}

/** Cloudflare's Workers AI chat route (gateway first, then REST), or null off Cloudflare. */
export function resolveCloudflareWorkersAiTarget(
  env: Pick<Env, 'AI_GATEWAY_ID' | 'CF_ACCOUNT_ID' | 'CF_API_TOKEN'>,
  model: string
): ChatCompletionsTarget | null {
  const gatewayId = resolveAiGatewayId(env);
  if (gatewayId) {
    return chatTarget(
      'cloudflare-gateway',
      `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1`,
      env.CF_API_TOKEN,
      model
    );
  }
  if (hasCloudflareAccountApi(env)) {
    return chatTarget(
      'cloudflare-api',
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
      env.CF_API_TOKEN,
      model
    );
  }
  return null;
}

/** Target for a call that would use a Workers AI model on Cloudflare. */
export async function resolveWorkersAiChatTarget(
  env: Env,
  purpose: LlmPurpose,
  model: string
): Promise<ChatCompletionsTarget | null> {
  return (
    (await resolveOpenAICompatibleTarget(env, purpose, model)) ??
    resolveCloudflareWorkersAiTarget(env, model)
  );
}

/**
 * Request headers for a chat target. `cf-aig-metadata` carries user and workspace ids for
 * gateway analytics, so it goes to Cloudflare targets only, never to a third-party endpoint.
 */
export function chatTargetHeaders(
  target: ChatCompletionsTarget,
  cloudflareHeaders: Record<string, string> = {}
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
    ...(isCloudflareChatTarget(target) ? cloudflareHeaders : {}),
  };
}
