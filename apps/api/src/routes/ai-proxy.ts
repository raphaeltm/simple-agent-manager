/**
 * AI inference proxy — routes to Workers AI or Anthropic via Cloudflare AI Gateway.
 *
 * For Workers AI models (@cf/*): transparent pass-through (OpenAI-compatible format).
 * For Anthropic models (claude-*): translates OpenAI format → Anthropic Messages API,
 * forwards through AI Gateway's /anthropic path, translates response back.
 *
 * Auth: Bearer token in Authorization header (workspace callback token).
 * Rate limit: per-user RPM via KV.
 * Token budget: per-user daily input/output token limits via KV.
 *
 * Mount point: app.route('/ai/v1', aiProxyRoutes) in index.ts.
 */
import {
  DEFAULT_AI_PROXY_ALLOWED_MODELS,
  DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST,
  DEFAULT_AI_PROXY_MODEL,
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import {
  createAnthropicToOpenAIStream,
  translateRequestToAnthropic,
  translateResponseToOpenAI,
} from '../services/ai-anthropic-translate';
import { checkTokenBudget } from '../services/ai-token-budget';
import { verifyCallbackToken } from '../services/jwt';
import { getPlatformAgentCredential } from '../services/platform-credentials';

const aiProxyRoutes = new Hono<{ Bindings: Env }>();

// =============================================================================
// Model Routing
// =============================================================================

/** Check if a model ID is an Anthropic model (requires format translation). */
function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith('claude-');
}

/** Parse allowed models from env or use defaults, normalizing prefixes. */
function getAllowedModels(env: Env): Set<string> {
  const raw = env.AI_PROXY_ALLOWED_MODELS || DEFAULT_AI_PROXY_ALLOWED_MODELS;
  return new Set(raw.split(',').map((m) => m.trim()).filter(Boolean).map((m) => normalizeModelId(m)));
}

/** Normalize model ID: ensure @cf/ prefix for Workers AI models, leave Anthropic models as-is. */
function normalizeModelId(model: string): string {
  let resolved = model;
  // Strip workers-ai/ prefix that OpenCode may prepend
  if (resolved.startsWith('workers-ai/')) {
    resolved = resolved.slice('workers-ai/'.length);
  }
  // Anthropic models don't get the @cf/ prefix
  if (isAnthropicModel(resolved)) {
    return resolved;
  }
  // Add @cf/ prefix if missing — Workers AI requires the full @cf/ path.
  if (!resolved.startsWith('@cf/') && !resolved.startsWith('@hf/')) {
    resolved = `@cf/${resolved}`;
  }
  return resolved;
}

/** Resolve model from request, falling back to default. */
function resolveModelId(model: string | undefined, env: Env): string {
  if (!model) return normalizeModelId(env.AI_PROXY_DEFAULT_MODEL || DEFAULT_AI_PROXY_MODEL);
  return normalizeModelId(model);
}

// =============================================================================
// Upstream URL Builders
// =============================================================================

/** Build upstream URL for Workers AI (OpenAI-compatible). */
function buildWorkersAIUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

/** Build upstream URL for Anthropic Messages API via AI Gateway. */
function buildAnthropicUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages`;
  }
  // Fallback: direct Anthropic API (no gateway monitoring)
  return 'https://api.anthropic.com/v1/messages';
}

// =============================================================================
// Input Token Estimation
// =============================================================================

/**
 * Estimate input tokens from messages (rough: 1 token ~ 4 chars).
 * Handles both string and array content formats.
 */
function estimateInputTokens(messages: Array<{ role: string; content: unknown }>): number {
  const totalChars = messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s: number, p: { type: string; text?: string }) => {
        return s + (p.type === 'text' && p.text ? p.text.length : 0);
      }, 0);
    }
    return sum;
  }, 0);
  return Math.ceil(totalChars / 4);
}

// =============================================================================
// Forwarding Functions
// =============================================================================

/** Forward request to Workers AI (transparent OpenAI-format pass-through). */
async function forwardToWorkersAI(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
): Promise<Response> {
  const gatewayUrl = buildWorkersAIUrl(env);
  const gatewayBody = { ...body, model: modelId };

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    },
    body: JSON.stringify(gatewayBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return new Response(JSON.stringify({
      error: {
        message: `AI Gateway error (${response.status}): ${errorText.slice(0, 200)}`,
        type: 'server_error',
      },
    }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
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

  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

/** Forward request to Anthropic via AI Gateway (with format translation). */
async function forwardToAnthropic(
  env: Env,
  body: Record<string, unknown>,
  modelId: string,
  aigMetadata: string,
  anthropicApiKey: string,
): Promise<Response> {

  // Translate OpenAI format → Anthropic Messages format
  const anthropicRequest = translateRequestToAnthropic(body, modelId);
  const gatewayUrl = buildAnthropicUrl(env);

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    },
    body: JSON.stringify(anthropicRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return new Response(JSON.stringify({
      error: {
        message: `Anthropic API error (${response.status}): ${errorText.slice(0, 200)}`,
        type: 'server_error',
      },
    }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  // Non-streaming: translate response
  if (!body.stream) {
    const anthropicResponse = await response.json() as Record<string, unknown>;
    const openAIResponse = translateResponseToOpenAI(anthropicResponse as never);
    return new Response(JSON.stringify(openAIResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Streaming: pipe through format translation transform
  if (!response.body) {
    return new Response(JSON.stringify({
      error: { message: 'No response body from Anthropic', type: 'server_error' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const transformStream = createAnthropicToOpenAIStream(modelId);
  const translatedBody = response.body.pipeThrough(transformStream);

  return new Response(translatedBody, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// =============================================================================
// Main Route Handler
// =============================================================================

/**
 * POST /chat/completions — Proxy to AI Gateway (Workers AI or Anthropic).
 *
 * Accepts the full OpenAI chat completions format. For Anthropic models,
 * performs format translation transparently.
 */
aiProxyRoutes.post('/chat/completions', async (c) => {
  // Kill switch
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return c.json({ error: { message: 'AI proxy is disabled', type: 'service_unavailable' } }, 503);
  }

  // --- Auth: extract Bearer token from Authorization header ---
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Missing or invalid Authorization header', type: 'invalid_request_error' } }, 401);
  }
  const token = authHeader.slice(7);

  let tokenPayload: { workspace: string; scope?: string };
  try {
    tokenPayload = await verifyCallbackToken(token, c.env);
  } catch {
    return c.json({ error: { message: 'Invalid or expired token', type: 'invalid_request_error' } }, 401);
  }

  // Reject node-scoped tokens — only workspace-scoped tokens allowed
  if (tokenPayload.scope === 'node') {
    return c.json({ error: { message: 'Insufficient token scope', type: 'invalid_request_error' } }, 403);
  }

  const workspaceId = tokenPayload.workspace;

  // --- Resolve workspaceId → userId ---
  const db = drizzle(c.env.DATABASE, { schema });
  const workspace = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();

  if (!workspace?.userId) {
    log.error('ai_proxy.workspace_not_found', { workspaceId });
    return c.json({ error: { message: 'Workspace not found', type: 'invalid_request_error' } }, 404);
  }

  const userId = workspace.userId;

  // --- Rate limit: per-user RPM ---
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
    return c.json(
      { error: { message: 'Rate limit exceeded. Please try again later.', type: 'rate_limit_error' } },
      429,
    );
  }

  // --- Parse request body ---
  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }

  // Minimal validation: messages must be present
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { message: 'messages array is required', type: 'invalid_request_error' } }, 400);
  }

  // --- Resolve and validate model ---
  const modelId = resolveModelId(body.model as string | undefined, c.env);
  const allowedModels = getAllowedModels(c.env);
  if (!allowedModels.has(modelId)) {
    return c.json({
      error: {
        message: `Model '${modelId}' is not available. Allowed models: ${Array.from(allowedModels).join(', ')}`,
        type: 'invalid_request_error',
      },
    }, 400);
  }

  // --- Check daily token budget ---
  const budgetCheck = await checkTokenBudget(c.env.KV, userId, c.env);
  if (!budgetCheck.allowed) {
    return c.json({
      error: {
        message: 'Daily token budget exceeded. Resets at midnight UTC.',
        type: 'rate_limit_error',
        budget: {
          inputTokens: { used: budgetCheck.usage.inputTokens, limit: budgetCheck.inputLimit },
          outputTokens: { used: budgetCheck.usage.outputTokens, limit: budgetCheck.outputLimit },
        },
      },
    }, 429);
  }

  // --- Rough input token estimate for pre-flight check ---
  const estimatedInputTokens = estimateInputTokens(body.messages as Array<{ role: string; content: unknown }>);
  const maxInputPerRequest = parseInt(c.env.AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST || '', 10)
    || DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST;
  if (estimatedInputTokens > maxInputPerRequest) {
    return c.json({
      error: {
        message: `Request too large: estimated ${estimatedInputTokens} input tokens exceeds limit of ${maxInputPerRequest}`,
        type: 'invalid_request_error',
      },
    }, 400);
  }

  // --- Per-user metadata for AI Gateway analytics ---
  const aigMetadata = JSON.stringify({
    userId,
    workspaceId,
    modelId,
    stream: !!body.stream,
    hasTools: !!body.tools,
  });

  const isAnthropic = isAnthropicModel(modelId);

  // For Anthropic models, resolve the API key from platform credentials (admin-managed).
  // The key is stored as a platform credential for agent type 'claude-code' since
  // that's the agent type that uses Anthropic API keys.
  let anthropicApiKey: string | undefined;
  if (isAnthropic) {
    const encryptionKey = getCredentialEncryptionKey(c.env);
    const platformCred = await getPlatformAgentCredential(db, 'claude-code', encryptionKey);
    anthropicApiKey = platformCred?.credential;
    if (!anthropicApiKey) {
      return c.json({
        error: {
          message: 'No Anthropic API key configured. An admin must add a Claude Code platform credential.',
          type: 'server_error',
        },
      }, 503);
    }
  }

  log.info('ai_proxy.forward', {
    userId,
    workspaceId,
    modelId,
    provider: isAnthropic ? 'anthropic' : 'workers-ai',
    messageCount: (body.messages as unknown[]).length,
    hasTools: !!body.tools,
    stream: !!body.stream,
    estimatedInputTokens,
  });

  try {
    const response = isAnthropic
      ? await forwardToAnthropic(c.env, body, modelId, aigMetadata, anthropicApiKey!)
      : await forwardToWorkersAI(c.env, body, modelId, aigMetadata);

    log.info('ai_proxy.response', {
      userId,
      workspaceId,
      modelId,
      provider: isAnthropic ? 'anthropic' : 'workers-ai',
      status: response.status,
    });

    return response;
  } catch (err) {
    log.error('ai_proxy.fetch_error', {
      userId,
      workspaceId,
      modelId,
      provider: isAnthropic ? 'anthropic' : 'workers-ai',
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({
      error: { message: 'Failed to reach upstream. Please try again.', type: 'server_error' },
    }, 502);
  }
});

/** OpenAI models endpoint — returns available models. */
aiProxyRoutes.get('/models', async (c) => {
  if (c.env.AI_PROXY_ENABLED === 'false') {
    return c.json({ error: { message: 'AI proxy is disabled', type: 'service_unavailable' } }, 503);
  }

  const allowedModels = getAllowedModels(c.env);
  const models = Array.from(allowedModels).map((id) => ({
    id,
    object: 'model' as const,
    created: 0,
    owned_by: isAnthropicModel(id) ? 'anthropic' : 'cloudflare',
  }));

  return c.json({ object: 'list', data: models });
});

// Export for testing
export { aiProxyRoutes, isAnthropicModel, resolveModelId };
