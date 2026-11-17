import { guardedFetch } from '@simple-agent-manager/worker-core';

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
  /** Redirect hops the guarded fetch follows (`outbound.maxRedirects`). Only for `openai-compatible`. */
  maxRedirects?: number;
}

/**
 * No endpoint can serve this call. `not_configured` is a designed state (nothing is set up here);
 * `settings_unreadable` means the endpoint settings could not be read, so the call was refused
 * rather than sent to a provider the admin may have opted out of.
 */
export type LlmUnavailableReason =
  'not_configured' | 'settings_unreadable' | 'private_network_not_allowed';

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
    readonly purpose: string,
    readonly reason: LlmUnavailableReason = 'not_configured'
  ) {
    super(LLM_UNAVAILABLE_MESSAGES[reason]);
    this.name = 'LlmUnavailableError';
  }
}

export function isCloudflareChatTarget(target: ChatCompletionsTarget): boolean {
  return target.kind !== 'openai-compatible';
}

export function chatTarget(
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
  // eslint-disable-next-line sam/no-unguarded-outbound-fetch -- Cloudflare chooses the fixed Workers AI endpoint for this target
  if (isCloudflareChatTarget(target)) return fetch(url, init);
  return guardedFetch(url, init, {
    allowPrivateNetwork: target.allowPrivateNetwork,
    maxRedirects: target.maxRedirects,
  });
}

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
