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
  type Dialect,
  HARNESS_CAPABILITIES,
  type HarnessCapability,
  resolveHarnessDialect,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { readRequestJsonRecord } from '../lib/runtime-validation';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import {
  AIProxyAuthError,
  buildAIGatewayMetadata,
  verifyAIProxyAuth,
} from '../services/ai-proxy-shared';
import { checkAiUsageGate } from '../services/ai-token-budget';
import {
  attachUpstreamTokenUsageAccounting,
  estimateInputTokensFromMessages,
  optionalExecutionContext,
} from '../services/ai-token-usage-accounting';
import { resolveForConsumer } from '../services/composable-credentials/resolve';

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

function anthropicUsageGateError(reason: 'daily-token-budget' | 'monthly-cost-cap'): Response {
  if (reason === 'daily-token-budget') {
    return anthropicError('Daily token budget exceeded. Resets at midnight UTC.', 'rate_limit_error', 429);
  }

  return anthropicError('Monthly cost cap exceeded. Adjust your cap in Settings > Usage.', 'rate_limit_error', 429);
}

function openaiUsageGateError(reason: 'daily-token-budget' | 'monthly-cost-cap'): Response {
  if (reason === 'daily-token-budget') {
    return openaiError('Daily token budget exceeded.', 'rate_limit_error', 429);
  }

  return openaiError('Monthly cost cap exceeded. Adjust your cap in Settings > Usage.', 'rate_limit_error', 429);
}

// =============================================================================
// Shared: verify workspace token from URL path + rate limit + budget
// =============================================================================

interface PassthroughAuthResult {
  userId: string;
  workspaceId: string;
  projectId: string | null;
  chatSessionId?: string | null;
  trialId?: string;
  agentType?: string | null;
}

interface ResolvedProxyUpstream {
  agentType: string;
  dialect: Dialect;
  capability: HarnessCapability;
  apiKey: string;
  baseUrl: string;
}

type ResolvedCredentialSecret = NonNullable<
  NonNullable<Awaited<ReturnType<typeof resolveForConsumer>>>['credential']
>['secret'];

async function verifyPassthroughAuth(
  wstoken: string,
  env: Env,
): Promise<PassthroughAuthResult> {
  const db = drizzle(env.DATABASE, { schema });
  return verifyAIProxyAuth(wstoken, env, db);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start++;
  return value.slice(start);
}

function joinUpstreamUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
}

function stringSetting(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function routeDialect(routeSegment: string): Dialect {
  return routeSegment === 'anthropic' ? 'anthropic' : 'openai-compatible';
}

function candidateCapabilities(agentType: string | null | undefined, dialect: Dialect): HarnessCapability[] {
  if (agentType) {
    const capability = resolveHarnessDialect(agentType, dialect);
    return capability?.proxyRouteSegment ? [capability] : [];
  }
  return HARNESS_CAPABILITIES.filter(
    (capability) => capability.proxyRouteSegment && capability.dialects.includes(dialect),
  );
}

function resolvedBaseUrl(
  secret: ResolvedCredentialSecret,
  settings: Record<string, unknown>,
): string | null {
  return stringSetting(settings.baseUrl)
    ?? (secret.kind === 'openai-compatible' ? stringSetting(secret.baseUrl) : null);
}

function credentialApiKey(
  secret: ResolvedCredentialSecret,
): string | null {
  switch (secret.kind) {
    case 'api-key':
      return secret.apiKey;
    case 'openai-compatible':
      return secret.apiKey;
    default:
      return null;
  }
}

async function resolveProxyUpstream(input: {
  env: Env;
  userId: string;
  projectId: string | null;
  agentType?: string | null;
  dialect: Dialect;
}): Promise<ResolvedProxyUpstream | null> {
  const db = drizzle(input.env.DATABASE, { schema });
  const encryptionKey = getCredentialEncryptionKey(input.env);
  for (const capability of candidateCapabilities(input.agentType, input.dialect)) {
    const resolved = await resolveForConsumer(
      db,
      input.userId,
      encryptionKey,
      { kind: 'agent', agentType: capability.agentType },
      input.projectId,
    );
    if (!resolved?.credential || resolved.source === 'platform-proxy') continue;
    const secret = resolved.credential.secret;
    const apiKey = credentialApiKey(secret);
    const baseUrl = resolvedBaseUrl(secret, resolved.configuration?.settings ?? {});
    if (!apiKey || !baseUrl || !isHttpsUrl(baseUrl)) continue;
    return {
      agentType: capability.agentType,
      dialect: input.dialect,
      capability,
      apiKey,
      baseUrl,
    };
  }
  return null;
}

function buildUpstreamAuthHeaders(upstream: ResolvedProxyUpstream): Record<string, string> {
  if (upstream.capability.authStyle === 'bearer-token' || upstream.dialect === 'openai-compatible') {
    return { Authorization: `Bearer ${upstream.apiKey}` };
  }
  if (upstream.capability.authStyle === 'api-key' && upstream.dialect === 'anthropic') {
    return { 'x-api-key': upstream.apiKey };
  }
  return {};
}

async function checkPassthroughRateLimit(
  env: Env,
  userId: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number; limit: number }> {
  const rpmLimit = parseInt(env.AI_PROXY_RATE_LIMIT_RPM || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_RPM;
  const windowSeconds = parseInt(env.AI_PROXY_RATE_LIMIT_WINDOW_SECONDS || '', 10) || DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS;
  const windowStart = getCurrentWindowStart(windowSeconds);
  const rateLimitKey = createRateLimitKey('ai-proxy', userId, windowStart);

  const result = await checkRateLimit(env.KV, rateLimitKey, rpmLimit, windowSeconds);
  return { ...result, allowed: result.allowed, limit: rpmLimit };
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

  const { userId, workspaceId, projectId, chatSessionId, trialId } = auth;

  // --- Rate limit ---
  const { allowed, remaining, resetAt, limit } = await checkPassthroughRateLimit(c.env, userId);
  c.header('X-RateLimit-Limit', limit.toString());
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
    body = await readRequestJsonRecord(c.req.raw, 'ai-proxy-passthrough.anthropic.messages');
  } catch {
    return anthropicError('Invalid JSON in request body', 'invalid_request_error', 400);
  }

  const modelId = typeof body.model === 'string' ? body.model : undefined;
  if (!modelId) {
    return anthropicError('model is required', 'invalid_request_error', 400);
  }

  const usageGate = await checkAiUsageGate(c.env.KV, userId, c.env);
  if (!usageGate.allowed) {
    return anthropicUsageGateError(usageGate.reason);
  }

  const upstream = await resolveProxyUpstream({
    env: c.env,
    userId,
    projectId,
    agentType: auth.agentType,
    dialect: 'anthropic',
  });
  if (!upstream) {
    return anthropicError('No compatible upstream credential configured.', 'authentication_error', 401);
  }

  // --- Build metadata for AI Gateway analytics ---
  const isStreaming = body.stream === true;
  const aigMetadata = buildAIGatewayMetadata({
    userId, workspaceId, projectId, sessionId: chatSessionId, trialId, modelId,
    stream: isStreaming,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
  });

  // --- Build upstream headers: forward user's credential + inject analytics ---
  const upstreamHeaders: Record<string, string> = {
    ...buildUpstreamAuthHeaders(upstream),
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };

  // Forward Anthropic-specific headers
  const anthropicVersion = c.req.header('anthropic-version');
  upstreamHeaders['anthropic-version'] = anthropicVersion || '2023-06-01';
  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) {
    upstreamHeaders['anthropic-beta'] = anthropicBeta;
  }

  log.info('ai_proxy_passthrough.anthropic.forward', {
    userId, workspaceId, modelId, stream: isStreaming,
    agentType: upstream.agentType,
  });

  const upstreamUrl = joinUpstreamUrl(upstream.baseUrl, 'v1/messages');

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
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

    return attachUpstreamTokenUsageAccounting(upstreamResponse, {
      env: c.env,
      userId,
      format: 'anthropic',
      fallbackInputTokens: estimateInputTokensFromMessages(body.messages),
      executionCtx: optionalExecutionContext(() => c.executionCtx),
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

  const { userId, workspaceId, projectId, chatSessionId, trialId } = auth;

  const { allowed, remaining, resetAt, limit } = await checkPassthroughRateLimit(c.env, userId);
  c.header('X-RateLimit-Limit', limit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());
  if (!allowed) {
    return anthropicError('Rate limit exceeded.', 'rate_limit_error', 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await readRequestJsonRecord(c.req.raw, 'ai-proxy-passthrough.anthropic.count_tokens');
  } catch {
    return anthropicError('Invalid JSON in request body', 'invalid_request_error', 400);
  }

  const modelId = typeof body.model === 'string' ? body.model : undefined;
  if (!modelId) {
    return anthropicError('model is required', 'invalid_request_error', 400);
  }

  const usageGate = await checkAiUsageGate(c.env.KV, userId, c.env);
  if (!usageGate.allowed) {
    return anthropicUsageGateError(usageGate.reason);
  }

  const upstream = await resolveProxyUpstream({
    env: c.env,
    userId,
    projectId,
    agentType: auth.agentType,
    dialect: 'anthropic',
  });
  if (!upstream) {
    return anthropicError('No compatible upstream credential configured.', 'authentication_error', 401);
  }

  const aigMetadata = buildAIGatewayMetadata({
    userId, workspaceId, projectId, sessionId: chatSessionId, trialId, modelId, stream: false, hasTools: false,
  });

  const upstreamHeaders: Record<string, string> = {
    ...buildUpstreamAuthHeaders(upstream),
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };

  const anthropicVersion = c.req.header('anthropic-version');
  upstreamHeaders['anthropic-version'] = anthropicVersion || '2023-06-01';
  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) upstreamHeaders['anthropic-beta'] = anthropicBeta;

  const countTokensUrl = joinUpstreamUrl(upstream.baseUrl, 'v1/messages/count_tokens');

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

  const { userId, workspaceId, projectId, chatSessionId, trialId } = auth;

  const { allowed, remaining, resetAt, limit } = await checkPassthroughRateLimit(c.env, userId);
  c.header('X-RateLimit-Limit', limit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());
  if (!allowed) {
    const retryAfter = resetAt - Math.floor(Date.now() / 1000);
    c.header('Retry-After', Math.max(1, retryAfter).toString());
    return openaiError('Rate limit exceeded. Please try again later.', 'rate_limit_error', 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await readRequestJsonRecord(c.req.raw, 'ai-proxy-passthrough.openai.chat_completions');
  } catch {
    return openaiError('Invalid JSON body', 'invalid_request_error', 400);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return openaiError('messages array is required', 'invalid_request_error', 400);
  }

  const modelId = typeof body.model === 'string' ? body.model : undefined;
  if (!modelId) {
    return openaiError('model is required', 'invalid_request_error', 400);
  }

  const usageGate = await checkAiUsageGate(c.env.KV, userId, c.env);
  if (!usageGate.allowed) {
    return openaiUsageGateError(usageGate.reason);
  }

  const upstream = await resolveProxyUpstream({
    env: c.env,
    userId,
    projectId,
    agentType: auth.agentType,
    dialect: routeDialect('openai/v1'),
  });
  if (!upstream) {
    return openaiError('No compatible upstream credential configured.', 'invalid_request_error', 401);
  }

  const aigMetadata = buildAIGatewayMetadata({
    userId, workspaceId, projectId, sessionId: chatSessionId, trialId, modelId,
    stream: !!body.stream,
    hasTools: !!body.tools,
  });

  const upstreamUrl = joinUpstreamUrl(upstream.baseUrl, 'chat/completions');

  const upstreamHeaders: Record<string, string> = {
    ...buildUpstreamAuthHeaders(upstream),
    'Content-Type': 'application/json',
    'cf-aig-metadata': aigMetadata,
  };

  log.info('ai_proxy_passthrough.openai.forward', {
    userId, workspaceId, modelId, stream: !!body.stream,
  });

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
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

    return attachUpstreamTokenUsageAccounting(upstreamResponse, {
      env: c.env,
      userId,
      format: 'openai',
      fallbackInputTokens: estimateInputTokensFromMessages(body.messages),
      executionCtx: optionalExecutionContext(() => c.executionCtx),
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

export {
  aiProxyPassthroughRoutes,
  buildUpstreamAuthHeaders,
  joinUpstreamUrl,
  resolveProxyUpstream,
};
