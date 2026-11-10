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
import { resolveD1BindingIdentity } from '../lib/d1-session';
import { log } from '../lib/logger';
import { classifyHost, guardedFetch } from '../lib/network-hosts';
import { resolveAdminSettingDetailsMany } from './admin-settings-resolution';
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
   * The admin opted in to this endpoint being on the private network
   * (`llm.openAICompatible.allowPrivateNetwork`). Only meaningful for `openai-compatible`.
   */
  allowPrivateNetwork: boolean;
}

/**
 * No endpoint can serve this call. `not_configured` is a designed state (nothing is set up here);
 * `settings_unreadable` means the endpoint settings could not be read, so the call was refused
 * rather than sent to a provider the admin may have opted out of.
 */
export type LlmUnavailableReason =
  | 'not_configured'
  | 'settings_unreadable'
  | 'private_network_not_allowed';

const LLM_UNAVAILABLE_MESSAGES: Record<LlmUnavailableReason, string> = {
  not_configured:
    'No language model is available on this installation. Configure an OpenAI-compatible endpoint in admin settings (AI models).',
  settings_unreadable:
    'The language model settings could not be read, so the call was not sent. Try again shortly.',
  private_network_not_allowed:
    'The configured language model endpoint is on a private network address. Turn on llm.openAICompatible.allowPrivateNetwork in admin settings (AI models) to allow it.',
};

export class LlmUnavailableError extends Error {
  constructor(
    readonly purpose: LlmPurpose,
    readonly reason: LlmUnavailableReason = 'not_configured'
  ) {
    super(LLM_UNAVAILABLE_MESSAGES[reason]);
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
  model: string,
  allowPrivateNetwork = false
): ChatCompletionsTarget {
  return { kind, baseUrl, url: `${baseUrl}/chat/completions`, apiKey, model, allowPrivateNetwork };
}

/**
 * Fetch for a chat target's URL (`url` is `target.url` or an AI SDK provider's request URL on the
 * same base). An admin-configured endpoint goes through the guarded fetch: its host and every
 * redirect hop are checked, and a private-network host needs the admin's opt-in. Cloudflare
 * targets are fixed Cloudflare hosts and keep the plain fetch.
 */
export function fetchChatTarget(
  target: ChatCompletionsTarget,
  init: RequestInit,
  url: string = target.url
): Promise<Response> {
  if (isCloudflareChatTarget(target)) return fetch(url, init);
  return guardedFetch(url, init, { allowPrivateNetwork: target.allowPrivateNetwork });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Per D1 binding, whether the last successful read of the base URL found an endpoint. Lets a
 * settings outage keep the Cloudflare route for an installation known to have no endpoint.
 */
const lastEndpointConfigured = new WeakMap<D1Database, boolean>();

function settingsUnreadable(purpose: LlmPurpose, err: unknown): LlmUnavailableError {
  log.error('llm.endpoint_settings_unreadable', {
    purpose,
    error: err instanceof Error ? err.message : String(err),
  });
  return new LlmUnavailableError(purpose, 'settings_unreadable');
}

/**
 * The configured base URL, read alone: it is a plain setting, so an installation without an
 * endpoint never queries the credential table. When the read fails after this isolate has seen
 * an endpoint configured, the call is refused: an admin who pointed SAM at their own endpoint
 * must not have prompts sent to another provider because D1 hiccuped. An isolate that has not
 * yet read the setting resolves it to its default (no endpoint), exactly as before endpoints
 * existed, so a Cloudflare install keeps its route through an outage.
 */
async function readConfiguredBaseUrl(env: Env, purpose: LlmPurpose): Promise<unknown> {
  const db = resolveD1BindingIdentity(env.DATABASE);
  try {
    const [setting] = await resolveAdminSettingDetailsMany(env, ['llm.openAICompatible.baseUrl']);
    const baseUrl = setting?.value ?? null;
    lastEndpointConfigured.set(db, validLlmBaseUrl(baseUrl));
    return baseUrl;
  } catch (err) {
    if (lastEndpointConfigured.get(db) !== true) return null;
    throw settingsUnreadable(purpose, err);
  }
}

/**
 * The admin-configured OpenAI-compatible endpoint for `purpose`, or null when none is set.
 * `requestedModel` is used only when no endpoint model is configured. Once an endpoint is
 * configured, failing to read its key or models throws rather than using another provider.
 */
export async function resolveOpenAICompatibleTarget(
  env: Env,
  purpose: LlmPurpose,
  requestedModel: string | null = null
): Promise<ChatCompletionsTarget | null> {
  const baseUrl = await readConfiguredBaseUrl(env, purpose);
  if (!validLlmBaseUrl(baseUrl)) return null;
  let values: unknown[];
  try {
    const details = await resolveAdminSettingDetailsMany(env, [
      'llm.openAICompatible.apiKey',
      'llm.openAICompatible.model',
      LLM_PURPOSE_MODEL_SETTING[purpose],
      'llm.openAICompatible.allowPrivateNetwork',
    ]);
    values = details.map((detail) => detail.value);
  } catch (err) {
    throw settingsUnreadable(purpose, err);
  }
  const [apiKey, defaultModel, purposeModel, allowPrivate] = values;
  const model = stringValue(purposeModel) ?? stringValue(defaultModel) ?? requestedModel;
  if (!model) return null;
  const normalized = normalizeLlmBaseUrl(String(baseUrl));
  const allowPrivateNetwork = allowPrivate === true;
  // Refused here with a reason the admin can act on, rather than as a fetch error later.
  if (!allowPrivateNetwork && classifyHost(new URL(normalized).hostname) === 'private') {
    throw new LlmUnavailableError(purpose, 'private_network_not_allowed');
  }
  return chatTarget('openai-compatible', normalized, stringValue(apiKey), model, allowPrivateNetwork);
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
