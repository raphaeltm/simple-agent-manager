/**
 * AI proxy upstream forwarding — sends prepared requests to Workers AI,
 * Anthropic, or OpenAI through Cloudflare AI Gateway, translating Anthropic's
 * Messages API format to/from the OpenAI chat completions format.
 *
 * Split out of ai-proxy.ts per .claude/rules/18-file-size-limits.md — pure
 * extraction, no behavior change.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import {
  createAnthropicToOpenAIStream,
  translateRequestToAnthropic,
  translateResponseToOpenAI,
} from '../services/ai-anthropic-translate';
import type { UpstreamAuth } from '../services/ai-billing';
import { resolveUnifiedBillingToken } from '../services/ai-billing';
import { buildAnthropicGatewayUrl, upstreamErrorLogFields } from '../services/ai-proxy-shared';
import { copyCredentialLimitHeaders } from '../services/credential-limit-events';
import {
  chatTargetHeaders,
  fetchChatTarget,
  isCloudflareChatTarget,
  LlmUnavailableError,
  resolveWorkersAiChatTarget,
  withStreamUsageRequested,
} from '../services/llm-chat-target';
import { aiGatewayOnlyHeaders, resolveAiGatewayId } from '../services/platform-capabilities';

const anthropicContentBlockSchema = v.variant('type', [
  v.object({ type: v.literal('text'), text: v.string() }),
  v.object({ type: v.literal('tool_use'), id: v.string(), name: v.string(), input: v.unknown() }),
]);

const anthropicResponseSchema = v.object({
  id: v.string(),
  type: v.literal('message'),
  role: v.literal('assistant'),
  content: v.array(anthropicContentBlockSchema),
  model: v.string(),
  stop_reason: v.nullable(v.string()),
  usage: v.object({
    input_tokens: v.number(),
    output_tokens: v.number(),
  }),
});

// =============================================================================
// Upstream URL Builders
// =============================================================================

/** Build upstream URL for OpenAI chat completions via AI Gateway. */
function buildOpenAIUrl(env: Env): string {
  const gatewayId = resolveAiGatewayId(env);
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/openai/v1/chat/completions`;
  }
  // Fallback: direct OpenAI API (no gateway monitoring)
  return 'https://api.openai.com/v1/chat/completions';
}

/** Build upstream URL for OpenAI Responses API via AI Gateway. */
function buildOpenAIResponsesUrl(env: Env): string {
  const gatewayId = resolveAiGatewayId(env);
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/openai/v1/responses`;
  }
  return 'https://api.openai.com/v1/responses';
}

// =============================================================================
// Forwarding Functions
// =============================================================================

/**
 * A forwarded Workers AI-route response, and whether its usage may need estimating: an
 * admin-configured OpenAI-compatible endpoint can omit `usage`, Cloudflare's routes report it.
 */
export interface WorkersAiForward {
  response: Response;
  estimateMissingUsage: boolean;
}

/** Forward request to Workers AI (transparent OpenAI-format pass-through). */
export async function forwardToWorkersAI(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string
): Promise<WorkersAiForward> {
  const forward = (response: Response, estimateMissingUsage = false): WorkersAiForward => ({
    response,
    estimateMissingUsage,
  });
  let target: Awaited<ReturnType<typeof resolveWorkersAiChatTarget>>;
  try {
    target = await resolveWorkersAiChatTarget(env, 'aiProxy', modelId);
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) throw err;
    // The endpoint settings could not be read; the call is refused rather than sent elsewhere.
    return forward(
      new Response(
        JSON.stringify({
          error: { message: err.message, type: 'api_error', code: 'LLM_SETTINGS_UNAVAILABLE' },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )
    );
  }
  if (!target) {
    // No Workers AI on this installation and no OpenAI-compatible endpoint configured.
    return forward(
      new Response(
        JSON.stringify({
          error: {
            message: 'This model route is not available on this installation.',
            type: 'invalid_request_error',
            code: 'FEATURE_UNAVAILABLE',
          },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    );
  }
  const gatewayBody = withStreamUsageRequested(target, { ...body, model: target.model });

  const response = await fetchChatTarget(target, {
    method: 'POST',
    headers: chatTargetHeaders(target, { 'cf-aig-metadata': aigMetadata }),
    body: JSON.stringify(gatewayBody),
  });

  if (!response.ok) {
    log.error('ai_proxy.workers_ai_error', {
      status: response.status,
      target: target.kind,
      ...(await upstreamErrorLogFields(response, !isCloudflareChatTarget(target))),
    });
    const errorHeaders = new Headers({ 'Content-Type': 'application/json' });
    copyCredentialLimitHeaders(response.headers, errorHeaders);
    return forward(
      new Response(
        JSON.stringify({
          error: {
            message: `AI inference failed (${response.status}). Please try again.`,
            type: 'server_error',
          },
        }),
        { status: response.status, headers: errorHeaders }
      )
    );
  }

  // Pass through transparently
  const responseHeaders = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) responseHeaders.set('Content-Type', contentType);
  if (body.stream) {
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return forward(
    new Response(response.body, { status: response.status, headers: responseHeaders }),
    !isCloudflareChatTarget(target)
  );
}

/** Forward request to Anthropic via AI Gateway (with format translation). */
export async function forwardToAnthropic(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
  upstreamAuth: UpstreamAuth
): Promise<Response> {
  // Translate OpenAI format → Anthropic Messages format
  const anthropicRequest = translateRequestToAnthropic(body, modelId);
  const gatewayUrl = buildAnthropicGatewayUrl(env);

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      ...upstreamAuth.headers,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      ...aiGatewayOnlyHeaders(env, { 'cf-aig-metadata': aigMetadata }),
    },
    body: JSON.stringify(anthropicRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.anthropic_error', {
      status: response.status,
      body: errorText.slice(0, 500),
    });
    const errorHeaders = new Headers({ 'Content-Type': 'application/json' });
    copyCredentialLimitHeaders(response.headers, errorHeaders);
    return new Response(
      JSON.stringify({
        error: {
          message: `AI inference failed (${response.status}). Please try again.`,
          type: 'server_error',
        },
      }),
      { status: response.status, headers: errorHeaders }
    );
  }

  // Non-streaming: translate response
  if (!body.stream) {
    const anthropicResponse = await readResponseJson(
      response,
      anthropicResponseSchema,
      'ai-proxy.anthropic_response'
    );
    const openAIResponse = translateResponseToOpenAI(anthropicResponse);
    const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
    copyCredentialLimitHeaders(response.headers, responseHeaders);
    return new Response(JSON.stringify(openAIResponse), {
      status: 200,
      headers: responseHeaders,
    });
  }

  // Streaming: pipe through format translation transform
  if (!response.body) {
    return new Response(
      JSON.stringify({
        error: { message: 'No response body from Anthropic', type: 'server_error' },
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const transformStream = createAnthropicToOpenAIStream(modelId);
  const translatedBody = response.body.pipeThrough(transformStream);

  const responseHeaders = new Headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  copyCredentialLimitHeaders(response.headers, responseHeaders);
  return new Response(translatedBody, { status: 200, headers: responseHeaders });
}

/** Forward request to OpenAI via AI Gateway (OpenAI-native format, no translation needed). */
export async function forwardToOpenAI(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
  openaiApiKey: string
): Promise<Response> {
  const gatewayUrl = buildOpenAIUrl(env);
  const gatewayBody = { ...body, model: modelId };

  // Use cf-aig-authorization for Unified Billing when available, otherwise standard Bearer
  const cfToken = resolveUnifiedBillingToken(env);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...aiGatewayOnlyHeaders(env, { 'cf-aig-metadata': aigMetadata }),
  };
  if (cfToken) {
    headers['cf-aig-authorization'] = `Bearer ${cfToken}`;
  } else {
    headers['Authorization'] = `Bearer ${openaiApiKey}`;
  }

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(gatewayBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.openai_error', {
      status: response.status,
      body: errorText.slice(0, 500),
    });
    const errorHeaders = new Headers({ 'Content-Type': 'application/json' });
    copyCredentialLimitHeaders(response.headers, errorHeaders);
    return new Response(
      JSON.stringify({
        error: {
          message: `AI inference failed (${response.status}). Please try again.`,
          type: 'server_error',
        },
      }),
      { status: response.status, headers: errorHeaders }
    );
  }

  // OpenAI returns OpenAI-compatible format — pass through transparently
  const responseHeaders = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) responseHeaders.set('Content-Type', contentType);
  copyCredentialLimitHeaders(response.headers, responseHeaders);
  if (body.stream) {
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

/** Forward request to OpenAI Responses API via AI Gateway. */
export async function forwardToOpenAIResponses(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
  openaiApiKey: string
): Promise<Response> {
  const gatewayUrl = buildOpenAIResponsesUrl(env);
  const gatewayBody = { ...body, model: modelId };
  const cfToken = resolveUnifiedBillingToken(env);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...aiGatewayOnlyHeaders(env, { 'cf-aig-metadata': aigMetadata }),
  };
  if (cfToken) {
    headers['cf-aig-authorization'] = `Bearer ${cfToken}`;
  } else {
    headers['Authorization'] = `Bearer ${openaiApiKey}`;
  }

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(gatewayBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.openai_responses_error', {
      status: response.status,
      body: errorText.slice(0, 500),
    });
    const errorHeaders = new Headers({ 'Content-Type': 'application/json' });
    copyCredentialLimitHeaders(response.headers, errorHeaders);
    return new Response(
      JSON.stringify({
        error: {
          message: `AI inference failed (${response.status}). Please try again.`,
          type: 'server_error',
        },
      }),
      { status: response.status, headers: errorHeaders }
    );
  }

  const responseHeaders = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) responseHeaders.set('Content-Type', contentType);
  copyCredentialLimitHeaders(response.headers, responseHeaders);
  if (body.stream) {
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');
  }

  return new Response(response.body, { status: response.status, headers: responseHeaders });
}
