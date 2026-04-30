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
 *
 * Mount point: app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes) in index.ts.
 */
import {
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import {
  AIProxyAuthError,
  buildAIGatewayMetadata,
  buildAnthropicCountTokensUrl,
  buildAnthropicGatewayUrl,
  extractCallbackToken,
  isAnthropicModel,
  resolveAnthropicApiKey,
  verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import { checkTokenBudget } from '../services/ai-token-budget';

const aiProxyAnthropicRoutes = new Hono<{ Bindings: Env }>();

// =============================================================================
// Anthropic Error Format
// =============================================================================

/** Return an Anthropic-format error response. */
function anthropicError(
  message: string,
  type: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

// =============================================================================
// POST /messages — Native Anthropic Messages API pass-through
// =============================================================================

aiProxyAnthropicRoutes.post('/messages', async (c) => {
  // Kill switch
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return anthropicError('AI proxy is disabled', 'api_error', 503);
  }

  // --- Auth: extract token from x-api-key or Authorization: Bearer ---
  const token = extractCallbackToken(
    c.req.header('Authorization'),
    c.req.header('x-api-key'),
  );
  if (!token) {
    return anthropicError(
      'Missing authentication. Provide x-api-key or Authorization: Bearer header.',
      'authentication_error',
      401,
    );
  }

  const db = drizzle(c.env.DATABASE, { schema });
  let auth;
  try {
    auth = await verifyAIProxyAuth(token, c.env, db);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      const errType = err.statusCode === 403 ? 'permission_error' : 'authentication_error';
      return anthropicError(err.message, errType, err.statusCode);
    }
    return anthropicError('Invalid or expired API key', 'authentication_error', 401);
  }

  const { userId, workspaceId, projectId, trialId } = auth;

  // --- Rate limit: per-user RPM (shared key with OpenAI proxy) ---
  const rpmLimit = parseInt(c.env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds = parseInt(c.env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);

  const { allowed: rpmAllowed, remaining, resetAt } = await checkRateLimit(
    c.env.KV,
    rateLimitKey,
    rpmLimit,
    windowSeconds,
  );

  c.header('X-RateLimit-Limit', rpmLimit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());

  if (!rpmAllowed) {
    const retryAfter = resetAt - Math.floor(Date.now() / 1000);
    c.header('Retry-After', Math.max(1, retryAfter).toString());
    return anthropicError('Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
  }

  // --- Parse request body ---
  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return anthropicError('Invalid JSON in request body', 'invalid_request_error', 400);
  }

  // --- Validate model (must be an Anthropic model) ---
  const modelId = body.model as string | undefined;
  if (!modelId) {
    return anthropicError('model is required', 'invalid_request_error', 400);
  }
  if (!isAnthropicModel(modelId)) {
    return anthropicError(
      `Model '${modelId}' is not supported on this endpoint. Only Anthropic models (claude-*) are accepted.`,
      'invalid_request_error',
      400,
    );
  }

  // --- Check daily token budget ---
  const budgetCheck = await checkTokenBudget(c.env.KV, userId, c.env);
  if (!budgetCheck.allowed) {
    return anthropicError('Daily token budget exceeded. Resets at midnight UTC.', 'rate_limit_error', 429);
  }

  // --- Resolve platform Anthropic API key ---
  const anthropicApiKey = await resolveAnthropicApiKey(db, c.env);
  if (!anthropicApiKey) {
    return anthropicError(
      'No Anthropic API key configured. An admin must add a Claude Code platform credential.',
      'api_error',
      503,
    );
  }

  // --- Build metadata for AI Gateway analytics ---
  const isStreaming = body.stream === true;
  const aigMetadata = buildAIGatewayMetadata({
    userId,
    workspaceId,
    projectId,
    trialId,
    modelId,
    stream: isStreaming,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
  });

  // --- Build upstream headers ---
  const upstreamHeaders: Record<string, string> = {
    'x-api-key': anthropicApiKey,
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
    stream: isStreaming,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
  });

  // --- Forward to AI Gateway (native Anthropic format — no translation) ---
  const gatewayUrl = buildAnthropicGatewayUrl(c.env);

  try {
    const upstreamResponse = await fetch(gatewayUrl, {
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
      return anthropicError(
        `AI inference failed (${upstreamResponse.status}). Please try again.`,
        'api_error',
        upstreamResponse.status,
      );
    }

    // --- Pass through response (streaming or non-streaming) ---
    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);

    if (isStreaming) {
      responseHeaders.set('Cache-Control', 'no-cache');
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
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

// =============================================================================
// POST /messages/count_tokens — Token counting pass-through
// =============================================================================

aiProxyAnthropicRoutes.post('/messages/count_tokens', async (c) => {
  // Kill switch
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return anthropicError('AI proxy is disabled', 'api_error', 503);
  }

  // --- Auth ---
  const token = extractCallbackToken(
    c.req.header('Authorization'),
    c.req.header('x-api-key'),
  );
  if (!token) {
    return anthropicError(
      'Missing authentication. Provide x-api-key or Authorization: Bearer header.',
      'authentication_error',
      401,
    );
  }

  const db = drizzle(c.env.DATABASE, { schema });
  let auth;
  try {
    auth = await verifyAIProxyAuth(token, c.env, db);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      const errType = err.statusCode === 403 ? 'permission_error' : 'authentication_error';
      return anthropicError(err.message, errType, err.statusCode);
    }
    return anthropicError('Invalid or expired API key', 'authentication_error', 401);
  }

  const { userId } = auth;

  // --- Rate limit: per-user RPM (shared key with messages endpoint) ---
  const rpmLimit = parseInt(c.env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds = parseInt(c.env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);

  const { allowed: rpmAllowed, remaining, resetAt } = await checkRateLimit(
    c.env.KV,
    rateLimitKey,
    rpmLimit,
    windowSeconds,
  );

  c.header('X-RateLimit-Limit', rpmLimit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());

  if (!rpmAllowed) {
    const retryAfter = resetAt - Math.floor(Date.now() / 1000);
    c.header('Retry-After', Math.max(1, retryAfter).toString());
    return anthropicError('Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
  }

  // --- Parse and validate request body ---
  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return anthropicError('Invalid JSON in request body', 'invalid_request_error', 400);
  }

  const modelId = body.model as string | undefined;
  if (!modelId) {
    return anthropicError('model is required', 'invalid_request_error', 400);
  }
  if (!isAnthropicModel(modelId)) {
    return anthropicError(
      `Model '${modelId}' is not supported. Only Anthropic models (claude-*) are accepted.`,
      'invalid_request_error',
      400,
    );
  }

  // --- Check daily token budget ---
  const budgetCheck = await checkTokenBudget(c.env.KV, userId, c.env);
  if (!budgetCheck.allowed) {
    return anthropicError('Daily token budget exceeded. Resets at midnight UTC.', 'rate_limit_error', 429);
  }

  // --- Resolve platform Anthropic API key ---
  const anthropicApiKey = await resolveAnthropicApiKey(db, c.env);
  if (!anthropicApiKey) {
    return anthropicError(
      'No Anthropic API key configured. An admin must add a Claude Code platform credential.',
      'api_error',
      503,
    );
  }

  // --- Build upstream headers ---
  const upstreamHeaders: Record<string, string> = {
    'x-api-key': anthropicApiKey,
    'Content-Type': 'application/json',
  };

  const anthropicVersion = c.req.header('anthropic-version');
  upstreamHeaders['anthropic-version'] = anthropicVersion || '2023-06-01';

  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) {
    upstreamHeaders['anthropic-beta'] = anthropicBeta;
  }

  const countTokensUrl = buildAnthropicCountTokensUrl(c.env);

  try {
    const upstreamResponse = await fetch(countTokensUrl, {
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
      return anthropicError(
        `Token counting failed (${upstreamResponse.status}). Please try again.`,
        'api_error',
        upstreamResponse.status,
      );
    }

    const responseText = await upstreamResponse.text();
    return new Response(responseText, {
      status: 200,
      headers: { 'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    log.error('ai_proxy_anthropic.count_tokens_error', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return anthropicError('Failed to reach upstream API. Please try again.', 'api_error', 502);
  }
});

export { aiProxyAnthropicRoutes };
