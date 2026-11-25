/**
 * POST /messages/count_tokens on the native Anthropic proxy (`ai-proxy-anthropic.ts`).
 * Split out of that file per .claude/rules/18-file-size-limits.md; registered on the same router.
 */
import type { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { buildAIGatewayMetadata, buildAnthropicCountTokensUrl } from '../services/ai-proxy-shared';
import { globalUpstreamFetch } from '../services/ai-test-upstream';
import { copyCredentialLimitHeaders } from '../services/credential-limit-events';
import { admitAnthropicProxyRequest } from './ai-proxy-anthropic-prelude';
import {
  anthropicError,
  anthropicProviderErrorHeaders,
  scheduleAnthropicPlatformLimitHeaders,
} from './ai-proxy-anthropic-support';

export function registerAnthropicCountTokensRoute(routes: Hono<{ Bindings: Env }>): void {
  // =============================================================================
  // POST /messages/count_tokens — Token counting pass-through
  // =============================================================================

  routes.post('/messages/count_tokens', async (c) => {
    const admission = await admitAnthropicProxyRequest(c, {
      bodyContext: 'ai-proxy-anthropic.count_tokens',
      unsupportedModelMessage: (modelId) =>
        `Model '${modelId}' is not supported. Only Anthropic models (claude-*) are accepted.`,
      upstreamAuthFailureEvent: 'ai_proxy_anthropic.count_tokens_auth_failed',
    });
    if (admission instanceof Response) return admission;
    const { auth, body, modelId, testUpstream, upstreamAuth } = admission;
    const { userId, workspaceId, projectId, chatSessionId } = auth;

    // --- Build metadata for AI Gateway analytics ---
    const aigMetadata = buildAIGatewayMetadata({
      userId,
      workspaceId,
      projectId,
      sessionId: chatSessionId,
      modelId,
      stream: false,
      hasTools: false,
    });

    // --- Build upstream headers ---
    const upstreamHeaders: Record<string, string> = {
      ...upstreamAuth.headers,
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    };

    const anthropicVersion = c.req.header('anthropic-version');
    upstreamHeaders['anthropic-version'] = anthropicVersion || '2023-06-01';

    const anthropicBeta = c.req.header('anthropic-beta');
    if (anthropicBeta) {
      upstreamHeaders['anthropic-beta'] = anthropicBeta;
    }

    const countTokensUrl = buildAnthropicCountTokensUrl(c.env);

    try {
      const upstreamFetch = testUpstream?.fetch ?? globalUpstreamFetch;
      const upstreamResponse = await upstreamFetch(countTokensUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(body),
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        log.error('ai_proxy_anthropic.count_tokens_upstream_error', {
          userId,
          status: upstreamResponse.status,
          body: errorText.slice(0, 500),
        });
        scheduleAnthropicPlatformLimitHeaders(c, {
          env: c.env,
          response: upstreamResponse,
          auth,
          upstreamAuth,
          source: 'ai-proxy-anthropic.count_tokens',
          testUpstream: testUpstream !== null,
        });
        return anthropicError(
          `Token counting failed (${upstreamResponse.status}). Please try again.`,
          'api_error',
          upstreamResponse.status,
          anthropicProviderErrorHeaders(upstreamResponse.headers)
        );
      }

      const responseText = await upstreamResponse.text();
      const responseHeaders = new Headers({
        'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json',
      });
      copyCredentialLimitHeaders(upstreamResponse.headers, responseHeaders);
      scheduleAnthropicPlatformLimitHeaders(c, {
        env: c.env,
        response: upstreamResponse,
        auth,
        upstreamAuth,
        source: 'ai-proxy-anthropic.count_tokens',
        testUpstream: testUpstream !== null,
      });
      return new Response(responseText, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      log.error('ai_proxy_anthropic.count_tokens_error', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return anthropicError('Failed to reach upstream API. Please try again.', 'api_error', 502);
    }
  });
}
