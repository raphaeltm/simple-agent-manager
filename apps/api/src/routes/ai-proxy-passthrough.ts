/**
 * AI proxy passthrough routes — URL-path-based workspace auth.
 *
 * These routes embed the workspace callback token in the URL path instead of
 * auth headers, freeing auth headers for the user's own API credentials.
 * This enables universal usage tracking: even users with their own API keys
 * route through AI Gateway for analytics, rate limiting, and budget enforcement.
 *
 * Routes:
 *   POST /ai/proxy/:wstoken/anthropic/v1/messages
 *   POST /ai/proxy/:wstoken/anthropic/v1/messages/count_tokens
 *   POST /ai/proxy/:wstoken/openai/v1/chat/completions
 *
 * The wstoken is verified as a workspace callback token to extract userId,
 * workspaceId, projectId for analytics metadata. The user's credential from
 * the request's auth headers is forwarded to the upstream provider.
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
  isAnthropicModel,
  verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import { checkTokenBudget } from '../services/ai-token-budget';

const aiProxyPassthroughRoutes = new Hono<{ Bindings: Env }>();

// =============================================================================
// Error Helpers
// =============================================================================

function anthropicError(message: string, type: string, status: number): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function openaiError(message: string, type: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: { message, type } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

// =============================================================================
// Shared: verify workspace token from URL path + rate limit + budget
// =============================================================================

interface PassthroughAuthResult {
  userId: string;
  workspaceId: string;
  projectId: string | null;
  trialId?: string;
}

async function verifyPassthroughAuth(
  wstoken: string,
  env: Env,
): Promise<PassthroughAuthResult> {
  const db = drizzle(env.DATABASE, { schema });
  return verifyAIProxyAuth(wstoken, env, db);
}

async function checkPassthroughRateLimit(
  env: Env,
  userId: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const rpmLimit = parseInt(env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds = parseInt(env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);

  const result = await checkRateLimit(env.KV, rateLimitKey, rpmLimit, windowSeconds);
  return { ...result, allowed: result.allowed };
}

// =============================================================================
// Anthropic Passthrough: POST /:wstoken/anthropic/v1/messages
// =============================================================================

aiProxyPassthroughRoutes.post('/:wstoken/anthropic/v1/messages', async (c) => {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return anthropicError('AI proxy is disabled', 'api_error', 503);
  }

  const wstoken = c.req.param('wstoken');

  // --- Auth: verify workspace token from URL path ---
  let auth: PassthroughAuthResult;
  try {
    auth = await verifyPassthroughAuth(wstoken, c.env);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      const errType = err.statusCode === 403 ? 'permission_error' : 'authentication_error';
      return anthropicError(err.message, errType, err.statusCode);
    }
    return anthropicError('Invalid or expired workspace token', 'authentication_error', 401);
  }

  const { userId, workspaceId, projectId, trialId } = auth;

  // --- Rate limit ---
  const { allowed, remaining, resetAt } = await checkPassthroughRateLimit(c.env, userId);
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());
  if (!allowed) {
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

  const modelId = body.model as string | undefined;
  if (!modelId) {
    return anthropicError('model is required', 'invalid_request_error', 400);
  }
  if (!isAnthropicModel(modelId)) {
    return anthropicError(
      `Model '${modelId}' is not supported. Only Anthropic models (claude-*) are accepted.`,
      'invalid_request_error', 400,
    );
  }

  // --- Check daily token budget ---
  const budgetCheck = await checkTokenBudget(c.env.KV, userId, c.env);
  if (!budgetCheck.allowed) {
    return anthropicError('Daily token budget exceeded. Resets at midnight UTC.', 'rate_limit_error', 429);
  }

  // --- Extract user's credential from request headers (passthrough) ---
  // The user's API key is in x-api-key or Authorization: Bearer — forward it upstream.
  const userApiKey = c.req.header('x-api-key');
  const userAuthHeader = c.req.header('Authorization');
  if (!userApiKey && !userAuthHeader) {
    return anthropicError(
      'Missing upstream credential. Provide x-api-key or Authorization header with your API key.',
      'authentication_error', 401,
    );
  }

  // --- Build metadata for AI Gateway analytics ---
  const isStreaming = body.stream === true;
  const aigMetadata = buildAIGatewayMetadata({
    userId, workspaceId, projectId, trialId, modelId,
    stream: isStreaming,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
  });

  // --- Build upstream headers: forward user's credential + inject analytics ---
  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };

  // Forward the user's auth credential to upstream
  if (userApiKey) {
    upstreamHeaders['x-api-key'] = userApiKey;
  }
  if (userAuthHeader) {
    upstreamHeaders['Authorization'] = userAuthHeader;
  }

  // Forward Anthropic-specific headers
  const anthropicVersion = c.req.header('anthropic-version');
  upstreamHeaders['anthropic-version'] = anthropicVersion || '2023-06-01';
  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) {
    upstreamHeaders['anthropic-beta'] = anthropicBeta;
  }

  log.info('ai_proxy_passthrough.anthropic.forward', {
    userId, workspaceId, modelId, stream: isStreaming,
    hasUserApiKey: !!userApiKey,
    hasUserAuthHeader: !!userAuthHeader,
  });

  // --- Forward to AI Gateway ---
  const gatewayUrl = buildAnthropicGatewayUrl(c.env);

  try {
    const upstreamResponse = await fetch(gatewayUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    log.info('ai_proxy_passthrough.anthropic.response', {
      userId, workspaceId, modelId, status: upstreamResponse.status,
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      log.error('ai_proxy_passthrough.anthropic.upstream_error', {
        status: upstreamResponse.status,
        body: errorText.slice(0, 500),
      });
      return anthropicError(
        `AI inference failed (${upstreamResponse.status}). Please try again.`,
        'api_error', upstreamResponse.status,
      );
    }

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    if (isStreaming) responseHeaders.set('Cache-Control', 'no-cache');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    log.error('ai_proxy_passthrough.anthropic.fetch_error', {
      userId, workspaceId, modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return anthropicError('Failed to reach upstream API. Please try again.', 'api_error', 502);
  }
});

// =============================================================================
// Anthropic Passthrough: POST /:wstoken/anthropic/v1/messages/count_tokens
// =============================================================================

aiProxyPassthroughRoutes.post('/:wstoken/anthropic/v1/messages/count_tokens', async (c) => {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return anthropicError('AI proxy is disabled', 'api_error', 503);
  }

  const wstoken = c.req.param('wstoken');

  let auth: PassthroughAuthResult;
  try {
    auth = await verifyPassthroughAuth(wstoken, c.env);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      const errType = err.statusCode === 403 ? 'permission_error' : 'authentication_error';
      return anthropicError(err.message, errType, err.statusCode);
    }
    return anthropicError('Invalid or expired workspace token', 'authentication_error', 401);
  }

  const { userId, workspaceId, projectId, trialId } = auth;

  const { allowed, remaining, resetAt } = await checkPassthroughRateLimit(c.env, userId);
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());
  if (!allowed) {
    return anthropicError('Rate limit exceeded.', 'rate_limit_error', 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return anthropicError('Invalid JSON in request body', 'invalid_request_error', 400);
  }

  const modelId = body.model as string | undefined;
  if (!modelId || !isAnthropicModel(modelId)) {
    return anthropicError('model is required and must be an Anthropic model (claude-*)', 'invalid_request_error', 400);
  }

  const budgetCheck = await checkTokenBudget(c.env.KV, userId, c.env);
  if (!budgetCheck.allowed) {
    return anthropicError('Daily token budget exceeded.', 'rate_limit_error', 429);
  }

  const userApiKey = c.req.header('x-api-key');
  const userAuthHeader = c.req.header('Authorization');
  if (!userApiKey && !userAuthHeader) {
    return anthropicError('Missing upstream credential.', 'authentication_error', 401);
  }

  const aigMetadata = buildAIGatewayMetadata({
    userId, workspaceId, projectId, trialId, modelId, stream: false, hasTools: false,
  });

  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };
  if (userApiKey) upstreamHeaders['x-api-key'] = userApiKey;
  if (userAuthHeader) upstreamHeaders['Authorization'] = userAuthHeader;

  const anthropicVersion = c.req.header('anthropic-version');
  upstreamHeaders['anthropic-version'] = anthropicVersion || '2023-06-01';
  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) upstreamHeaders['anthropic-beta'] = anthropicBeta;

  const countTokensUrl = buildAnthropicCountTokensUrl(c.env);

  try {
    const upstreamResponse = await fetch(countTokensUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      log.error('ai_proxy_passthrough.anthropic.count_tokens_error', {
        userId, status: upstreamResponse.status, body: errorText.slice(0, 500),
      });
      return anthropicError(`Token counting failed (${upstreamResponse.status}).`, 'api_error', upstreamResponse.status);
    }

    const responseText = await upstreamResponse.text();
    return new Response(responseText, {
      status: 200,
      headers: { 'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    log.error('ai_proxy_passthrough.anthropic.count_tokens_fetch_error', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return anthropicError('Failed to reach upstream API.', 'api_error', 502);
  }
});

// =============================================================================
// OpenAI Passthrough: POST /:wstoken/openai/v1/chat/completions
// =============================================================================

aiProxyPassthroughRoutes.post('/:wstoken/openai/v1/chat/completions', async (c) => {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return openaiError('AI proxy is disabled', 'service_unavailable', 503);
  }

  const wstoken = c.req.param('wstoken');

  let auth: PassthroughAuthResult;
  try {
    auth = await verifyPassthroughAuth(wstoken, c.env);
  } catch (err) {
    if (err instanceof AIProxyAuthError) {
      return openaiError(err.message, 'invalid_request_error', err.statusCode);
    }
    return openaiError('Invalid or expired workspace token', 'invalid_request_error', 401);
  }

  const { userId, workspaceId, projectId, trialId } = auth;

  const { allowed, remaining, resetAt } = await checkPassthroughRateLimit(c.env, userId);
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());
  if (!allowed) {
    const retryAfter = resetAt - Math.floor(Date.now() / 1000);
    c.header('Retry-After', Math.max(1, retryAfter).toString());
    return openaiError('Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return openaiError('Invalid JSON body', 'invalid_request_error', 400);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return openaiError('messages array is required', 'invalid_request_error', 400);
  }

  const modelId = body.model as string | undefined;
  if (!modelId) {
    return openaiError('model is required', 'invalid_request_error', 400);
  }

  const budgetCheck = await checkTokenBudget(c.env.KV, userId, c.env);
  if (!budgetCheck.allowed) {
    return openaiError('Daily token budget exceeded.', 'rate_limit_error', 429);
  }

  // Extract user's credential from Authorization header (passthrough)
  const userAuthHeader = c.req.header('Authorization');
  if (!userAuthHeader) {
    return openaiError('Missing Authorization header with your API key.', 'invalid_request_error', 401);
  }

  const aigMetadata = buildAIGatewayMetadata({
    userId, workspaceId, projectId, trialId, modelId,
    stream: !!body.stream,
    hasTools: !!body.tools,
  });

  // Build the upstream OpenAI Gateway URL
  const gatewayId = c.env.AI_GATEWAY_ID;
  let gatewayUrl: string;
  if (gatewayId) {
    gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${c.env.CF_ACCOUNT_ID}/${gatewayId}/openai/v1/chat/completions`;
  } else {
    gatewayUrl = 'https://api.openai.com/v1/chat/completions';
  }

  const upstreamHeaders: Record<string, string> = {
    'Authorization': userAuthHeader,
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };

  log.info('ai_proxy_passthrough.openai.forward', {
    userId, workspaceId, modelId, stream: !!body.stream,
  });

  try {
    const upstreamResponse = await fetch(gatewayUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    log.info('ai_proxy_passthrough.openai.response', {
      userId, workspaceId, modelId, status: upstreamResponse.status,
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      log.error('ai_proxy_passthrough.openai.upstream_error', {
        status: upstreamResponse.status,
        body: errorText.slice(0, 500),
      });
      return openaiError(
        `AI inference failed (${upstreamResponse.status}). Please try again.`,
        'server_error', upstreamResponse.status,
      );
    }

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    if (body.stream) {
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('Connection', 'keep-alive');
      responseHeaders.set('X-Accel-Buffering', 'no');
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    log.error('ai_proxy_passthrough.openai.fetch_error', {
      userId, workspaceId, modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return openaiError('Failed to reach upstream API. Please try again.', 'server_error', 502);
  }
});

export { aiProxyPassthroughRoutes };
