/**
 * Native Anthropic Messages API proxy — pass-through to Cloudflare AI Gateway.
 *
 * Unlike the OpenAI-compatible ai-proxy.ts which translates formats, this endpoint
 * receives native Anthropic Messages API format and forwards it unchanged. No format
 * translation is needed because AI Gateway natively accepts Anthropic format on its
 * `/anthropic/v1/messages` path.
 *
 * Auth: x-api-key header (workspace callback token) — matches Claude Code's auth format.
 * Rate limit: per-user RPM via KV (shared with OpenAI proxy — same user budget).
 * Token budget: per-user daily limits via KV.
 * Billing: resolves upstream auth via resolveUpstreamAuth() — supports Unified Billing
 * (cf-aig-authorization) and platform API key (x-api-key) modes.
 *
 * Mount point: app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes) in index.ts.
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { proxyRunUsageRecorder } from '../services/agent-run-usage';
import { buildAIGatewayMetadata, buildAnthropicGatewayUrl } from '../services/ai-proxy-shared';
import { globalUpstreamFetch } from '../services/ai-test-upstream';
import {
  attachUpstreamTokenUsageAccounting,
  estimateInputTokensFromMessages,
  optionalExecutionContext,
} from '../services/ai-token-usage-accounting';
import { copyCredentialLimitHeaders } from '../services/credential-limit-events';
import { registerAnthropicCountTokensRoute } from './ai-proxy-anthropic-count-tokens';
import { admitAnthropicProxyRequest } from './ai-proxy-anthropic-prelude';
import {
  anthropicError,
  anthropicProviderErrorHeaders,
  scheduleAnthropicPlatformLimitHeaders,
} from './ai-proxy-anthropic-support';

const aiProxyAnthropicRoutes = new Hono<{ Bindings: Env }>();

// =============================================================================
// POST /messages — Native Anthropic Messages API pass-through
// =============================================================================

aiProxyAnthropicRoutes.post('/messages', async (c) => {
  const admission = await admitAnthropicProxyRequest(c, {
    bodyContext: 'ai-proxy-anthropic.messages',
    unsupportedModelMessage: (modelId) =>
      `Model '${modelId}' is not supported on this endpoint. Only Anthropic models (claude-*) are accepted.`,
    upstreamAuthFailureEvent: 'ai_proxy_anthropic.upstream_auth_failed',
  });
  if (admission instanceof Response) return admission;
  const { auth, body, modelId, testUpstream, upstreamAuth } = admission;
  const { userId, workspaceId, projectId, chatSessionId } = auth;

  // --- Build metadata for AI Gateway analytics ---
  const isStreaming = body.stream === true;
  const aigMetadata = buildAIGatewayMetadata({
    userId,
    workspaceId,
    projectId,
    sessionId: chatSessionId,
    modelId,
    stream: isStreaming,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
  });

  // --- Build upstream headers ---
  const upstreamHeaders: Record<string, string> = {
    ...upstreamAuth.headers,
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };

  // Forward Anthropic-specific headers from the client
  const anthropicVersion = c.req.header('anthropic-version');
  if (anthropicVersion) {
    upstreamHeaders['anthropic-version'] = anthropicVersion;
  } else {
    // Default to a known version if client doesn't specify
    upstreamHeaders['anthropic-version'] = '2023-06-01';
  }

  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) {
    upstreamHeaders['anthropic-beta'] = anthropicBeta;
  }

  log.info('ai_proxy_anthropic.forward', {
    userId,
    workspaceId,
    modelId,
    billingMode: upstreamAuth.billingMode,
    stream: isStreaming,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
  });

  // --- Forward to AI Gateway (native Anthropic format — no translation) ---
  const gatewayUrl = buildAnthropicGatewayUrl(c.env);

  try {
    const upstreamFetch = testUpstream?.fetch ?? globalUpstreamFetch;
    const upstreamResponse = await upstreamFetch(gatewayUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    log.info('ai_proxy_anthropic.response', {
      userId,
      workspaceId,
      modelId,
      status: upstreamResponse.status,
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      log.error('ai_proxy_anthropic.upstream_error', {
        status: upstreamResponse.status,
        body: errorText.slice(0, 500),
      });
      scheduleAnthropicPlatformLimitHeaders(c, {
        env: c.env,
        response: upstreamResponse,
        auth,
        upstreamAuth,
        source: 'ai-proxy-anthropic.messages',
        testUpstream: testUpstream !== null,
      });
      return anthropicError(
        `AI inference failed (${upstreamResponse.status}). Please try again.`,
        'api_error',
        upstreamResponse.status,
        anthropicProviderErrorHeaders(upstreamResponse.headers)
      );
    }

    // --- Pass through response (streaming or non-streaming) ---
    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    copyCredentialLimitHeaders(upstreamResponse.headers, responseHeaders);

    if (isStreaming) {
      responseHeaders.set('Cache-Control', 'no-cache');
    }
    scheduleAnthropicPlatformLimitHeaders(c, {
      env: c.env,
      response: upstreamResponse,
      auth,
      upstreamAuth,
      source: 'ai-proxy-anthropic.messages',
      testUpstream: testUpstream !== null,
    });

    return attachUpstreamTokenUsageAccounting(upstreamResponse, {
      env: c.env,
      userId,
      format: 'anthropic',
      costModelId: modelId,
      fallbackInputTokens: estimateInputTokensFromMessages(body.messages),
      onMeasuredUsage: proxyRunUsageRecorder(c.env, auth, {
        model: modelId,
        credentialReference: upstreamAuth.credentialReference,
        credentialSource: upstreamAuth.credentialSource,
      }),
      executionCtx: optionalExecutionContext(() => c.executionCtx),
      headers: responseHeaders,
    });
  } catch (err) {
    log.error('ai_proxy_anthropic.fetch_error', {
      userId,
      workspaceId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return anthropicError('Failed to reach upstream API. Please try again.', 'api_error', 502);
  }
});

registerAnthropicCountTokensRoute(aiProxyAnthropicRoutes);

export { aiProxyAnthropicRoutes };
