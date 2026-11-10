/**
 * AI proxy passthrough routes — URL-path-based workspace auth.
 *
 * These routes embed the workspace callback token in the URL path instead of
 * auth headers, so protocol auth headers can be reserved for upstream provider
 * credentials that are resolved server-side.
 *
 * Routes:
 *   POST /ai/proxy/:wstoken/anthropic/v1/messages
 *   POST /ai/proxy/:wstoken/anthropic/v1/messages/count_tokens
 *   POST /ai/proxy/:wstoken/openai/v1/chat/completions
 *
 * The wstoken is verified as a workspace callback token to extract userId,
 * workspaceId, and projectId. Upstream provider credentials are never accepted
 * from, or returned to, tenant workspaces. The upstream URL can be user-chosen, so
 * every upstream request goes through `fetchProxyUpstream` (guarded fetch).
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  attachUpstreamTokenUsageAccounting,
  estimateInputTokensFromMessages,
  optionalExecutionContext,
} from '../services/ai-token-usage-accounting';
import { copyCredentialLimitHeaders } from '../services/credential-limit-events';
import { anthropicError, credentialErrorHeaders, openaiError } from './ai-proxy-passthrough-errors';
import {
  addAnthropicRequestHeaders,
  anthropicProxyOptions,
  buildJsonUpstreamHeaders,
  buildUpstreamAuthHeaders,
  fetchProxyUpstream,
  joinUpstreamUrl,
  openaiProxyOptions,
  prepareProxyRequest,
  retryAfterSeconds,
  upstreamFetchErrorMeta,
} from './ai-proxy-passthrough-prepare';
import { schedulePassthroughLimitHeaders } from './ai-proxy-passthrough-telemetry';
import { resolveProxyUpstream } from './ai-proxy-passthrough-upstream';

const aiProxyPassthroughRoutes = new Hono<{ Bindings: Env }>();

// =============================================================================
// Anthropic Passthrough: POST /:wstoken/anthropic/v1/messages
// =============================================================================

aiProxyPassthroughRoutes.post('/:wstoken/anthropic/v1/messages', async (c) => {
  const prepared = await prepareProxyRequest(
    c,
    anthropicProxyOptions('ai-proxy-passthrough.anthropic.messages', (ctx, resetAt) => {
      ctx.header('Retry-After', retryAfterSeconds(resetAt));
      return anthropicError(
        'Rate limit exceeded. Please try again later.',
        'rate_limit_error',
        429
      );
    })
  );
  if (!prepared.ok) return prepared.response;

  const { userId, workspaceId, body, modelId, upstream } = prepared.value;
  const isStreaming = body.stream === true;

  // Direct BYO upstreams are not Cloudflare AI Gateway endpoints. Do not send
  // cf-aig-metadata here: Cloudflare documents that metadata appears in Gateway
  // logs, and forwarding it to third-party providers would leak SAM identifiers.
  // https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
  const upstreamHeaders = addAnthropicRequestHeaders(buildJsonUpstreamHeaders(upstream), c);

  log.info('ai_proxy_passthrough.anthropic.forward', {
    userId,
    workspaceId,
    modelId,
    stream: isStreaming,
    agentType: upstream.agentType,
  });

  // Anthropic and Anthropic-compatible providers treat the configured base URL
  // as the prefix before /v1/messages.
  // https://docs.anthropic.com/en/api/messages
  const upstreamUrl = joinUpstreamUrl(upstream.baseUrl, 'v1/messages');

  try {
    const upstreamResponse = await fetchProxyUpstream(upstreamUrl, upstreamHeaders, body);

    log.info('ai_proxy_passthrough.anthropic.response', {
      userId,
      workspaceId,
      modelId,
      status: upstreamResponse.status,
    });

    if (!upstreamResponse.ok) {
      log.error('ai_proxy_passthrough.anthropic.upstream_error', {
        status: upstreamResponse.status,
        userId,
        workspaceId,
        modelId,
      });
      schedulePassthroughLimitHeaders(c, {
        env: c.env,
        headers: upstreamResponse.headers,
        prepared: prepared.value,
        provider: 'anthropic',
        source: 'ai-proxy-passthrough.anthropic.messages',
        responseStatus: upstreamResponse.status,
      });
      return anthropicError(
        `AI inference failed (${upstreamResponse.status}). Please try again.`,
        'api_error',
        upstreamResponse.status,
        credentialErrorHeaders(upstreamResponse.headers)
      );
    }

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    copyCredentialLimitHeaders(upstreamResponse.headers, responseHeaders);
    if (isStreaming) responseHeaders.set('Cache-Control', 'no-cache');
    schedulePassthroughLimitHeaders(c, {
      env: c.env,
      headers: upstreamResponse.headers,
      prepared: prepared.value,
      provider: 'anthropic',
      source: 'ai-proxy-passthrough.anthropic.messages',
      responseStatus: upstreamResponse.status,
    });

    return attachUpstreamTokenUsageAccounting(upstreamResponse, {
      env: c.env,
      userId,
      format: 'anthropic',
      fallbackInputTokens: estimateInputTokensFromMessages(body.messages),
      provider: upstream.provider,
      executionCtx: optionalExecutionContext(() => c.executionCtx),
      headers: responseHeaders,
    });
  } catch (err) {
    log.error('ai_proxy_passthrough.anthropic.fetch_error', {
      userId,
      workspaceId,
      modelId,
      ...upstreamFetchErrorMeta(err),
    });
    return anthropicError('Failed to reach upstream API. Please try again.', 'api_error', 502);
  }
});

// =============================================================================
// Anthropic Passthrough: POST /:wstoken/anthropic/v1/messages/count_tokens
// =============================================================================

aiProxyPassthroughRoutes.post('/:wstoken/anthropic/v1/messages/count_tokens', async (c) => {
  const prepared = await prepareProxyRequest(
    c,
    anthropicProxyOptions('ai-proxy-passthrough.anthropic.count_tokens', () =>
      anthropicError('Rate limit exceeded.', 'rate_limit_error', 429)
    )
  );
  if (!prepared.ok) return prepared.response;

  const { userId, workspaceId, body, modelId, upstream } = prepared.value;

  const upstreamHeaders = addAnthropicRequestHeaders(buildJsonUpstreamHeaders(upstream), c);
  const countTokensUrl = joinUpstreamUrl(upstream.baseUrl, 'v1/messages/count_tokens');

  try {
    const upstreamResponse = await fetchProxyUpstream(countTokensUrl, upstreamHeaders, body);

    if (!upstreamResponse.ok) {
      log.error('ai_proxy_passthrough.anthropic.count_tokens_error', {
        userId,
        workspaceId,
        modelId,
        status: upstreamResponse.status,
      });
      schedulePassthroughLimitHeaders(c, {
        env: c.env,
        headers: upstreamResponse.headers,
        prepared: prepared.value,
        provider: 'anthropic',
        source: 'ai-proxy-passthrough.anthropic.count_tokens',
        responseStatus: upstreamResponse.status,
      });
      return anthropicError(
        `Token counting failed (${upstreamResponse.status}).`,
        'api_error',
        upstreamResponse.status,
        credentialErrorHeaders(upstreamResponse.headers)
      );
    }

    const responseText = await upstreamResponse.text();
    const responseHeaders = new Headers({
      'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json',
    });
    copyCredentialLimitHeaders(upstreamResponse.headers, responseHeaders);
    schedulePassthroughLimitHeaders(c, {
      env: c.env,
      headers: upstreamResponse.headers,
      prepared: prepared.value,
      provider: 'anthropic',
      source: 'ai-proxy-passthrough.anthropic.count_tokens',
      responseStatus: upstreamResponse.status,
    });
    return new Response(responseText, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    log.error('ai_proxy_passthrough.anthropic.count_tokens_fetch_error', {
      userId,
      ...upstreamFetchErrorMeta(err),
    });
    return anthropicError('Failed to reach upstream API.', 'api_error', 502);
  }
});

// =============================================================================
// OpenAI Passthrough: POST /:wstoken/openai/v1/chat/completions
// =============================================================================

aiProxyPassthroughRoutes.post('/:wstoken/openai/v1/chat/completions', async (c) => {
  const prepared = await prepareProxyRequest(
    c,
    openaiProxyOptions('ai-proxy-passthrough.openai.chat_completions')
  );
  if (!prepared.ok) return prepared.response;

  const { userId, workspaceId, body, modelId, upstream } = prepared.value;

  // OpenAI-compatible providers use an OpenAI-style base URL and chat
  // completions path; the API key is sent as a Bearer token.
  // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/
  const upstreamUrl = joinUpstreamUrl(upstream.baseUrl, 'chat/completions');
  const upstreamHeaders = buildJsonUpstreamHeaders(upstream);

  log.info('ai_proxy_passthrough.openai.forward', {
    userId,
    workspaceId,
    modelId,
    stream: !!body.stream,
  });

  try {
    const upstreamResponse = await fetchProxyUpstream(upstreamUrl, upstreamHeaders, body);

    log.info('ai_proxy_passthrough.openai.response', {
      userId,
      workspaceId,
      modelId,
      status: upstreamResponse.status,
    });

    if (!upstreamResponse.ok) {
      log.error('ai_proxy_passthrough.openai.upstream_error', {
        status: upstreamResponse.status,
        userId,
        workspaceId,
        modelId,
      });
      schedulePassthroughLimitHeaders(c, {
        env: c.env,
        headers: upstreamResponse.headers,
        prepared: prepared.value,
        provider: 'openai',
        source: 'ai-proxy-passthrough.openai.chat_completions',
        responseStatus: upstreamResponse.status,
      });
      return openaiError(
        `AI inference failed (${upstreamResponse.status}). Please try again.`,
        'server_error',
        upstreamResponse.status,
        credentialErrorHeaders(upstreamResponse.headers)
      );
    }

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    copyCredentialLimitHeaders(upstreamResponse.headers, responseHeaders);
    if (body.stream) {
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('Connection', 'keep-alive');
      responseHeaders.set('X-Accel-Buffering', 'no');
    }
    schedulePassthroughLimitHeaders(c, {
      env: c.env,
      headers: upstreamResponse.headers,
      prepared: prepared.value,
      provider: 'openai',
      source: 'ai-proxy-passthrough.openai.chat_completions',
      responseStatus: upstreamResponse.status,
    });

    return attachUpstreamTokenUsageAccounting(upstreamResponse, {
      env: c.env,
      userId,
      format: 'openai',
      fallbackInputTokens: estimateInputTokensFromMessages(body.messages),
      provider: upstream.provider,
      executionCtx: optionalExecutionContext(() => c.executionCtx),
      headers: responseHeaders,
    });
  } catch (err) {
    log.error('ai_proxy_passthrough.openai.fetch_error', {
      userId,
      workspaceId,
      modelId,
      ...upstreamFetchErrorMeta(err),
    });
    return openaiError('Failed to reach upstream API. Please try again.', 'server_error', 502);
  }
});

export {
  aiProxyPassthroughRoutes,
  buildUpstreamAuthHeaders,
  joinUpstreamUrl,
  resolveProxyUpstream,
};
