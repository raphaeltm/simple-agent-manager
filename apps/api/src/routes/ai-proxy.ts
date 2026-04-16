/**
 * AI inference proxy — transparent pass-through to Cloudflare AI Gateway.
 *
 * The AI Gateway provides an OpenAI-compatible endpoint that natively supports
 * tools, streaming, and all chat completion features. This proxy handles
 * SAM-specific concerns (auth, rate limiting, token budgets) and forwards
 * requests transparently — no format translation needed.
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
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import { checkTokenBudget } from '../services/ai-token-budget';
import { verifyCallbackToken } from '../services/jwt';

const aiProxyRoutes = new Hono<{ Bindings: Env }>();

/** Parse allowed models from env or use defaults, normalizing prefixes. */
function getAllowedModels(env: Env): Set<string> {
  const raw = env.AI_PROXY_ALLOWED_MODELS || DEFAULT_AI_PROXY_ALLOWED_MODELS;
  return new Set(raw.split(',').map((m) => m.trim()).filter(Boolean).map((m) => normalizeModelId(m)));
}

/** Normalize model ID: ensure @cf/ prefix for Workers AI models. */
function normalizeModelId(model: string): string {
  let resolved = model;
  // Strip workers-ai/ prefix that OpenCode may prepend
  if (resolved.startsWith('workers-ai/')) {
    resolved = resolved.slice('workers-ai/'.length);
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

/**
 * Build the upstream URL for Workers AI chat completions.
 *
 * When AI_GATEWAY_ID is set, routes through the AI Gateway for caching,
 * logging, and analytics. Otherwise falls back to the Workers AI REST API.
 */
function buildUpstreamUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  // Fallback: Workers AI OpenAI-compatible REST API (no gateway needed)
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

/**
 * Estimate input tokens from messages (rough: 1 token ≈ 4 chars).
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

/**
 * POST /chat/completions — Transparent proxy to Cloudflare AI Gateway.
 *
 * Accepts the full OpenAI chat completions format (messages, tools, tool_choice,
 * stream, temperature, etc.) and forwards it to the AI Gateway. The response is
 * streamed back without modification.
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

  // --- Parse request body (accept any valid JSON — Gateway handles validation) ---
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

  // --- Forward to AI Gateway (transparent pass-through) ---
  // Set the resolved model in the body and forward everything else as-is.
  // The Gateway handles tools, tool_choice, streaming, temperature, etc. natively.
  const gatewayBody = { ...body, model: modelId };
  const gatewayUrl = buildUpstreamUrl(c.env);

  // Attach per-user metadata for AI Gateway analytics (max 5 fields).
  // Enables per-user token usage tracking, cost attribution, and log filtering.
  const aigMetadata = JSON.stringify({
    userId,
    workspaceId,
    modelId,
    stream: !!body.stream,
    hasTools: !!body.tools,
  });

  log.info('ai_proxy.gateway_forward', {
    userId,
    workspaceId,
    modelId,
    messageCount: (body.messages as unknown[]).length,
    hasTools: !!body.tools,
    stream: !!body.stream,
    estimatedInputTokens,
    gatewayUrl,
  });

  try {
    const gatewayResponse = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
        'cf-aig-metadata': aigMetadata,
      },
      body: JSON.stringify(gatewayBody),
    });

    if (!gatewayResponse.ok) {
      const errorText = await gatewayResponse.text();
      log.error('ai_proxy.gateway_error', {
        userId,
        workspaceId,
        modelId,
        status: gatewayResponse.status,
        error: errorText.slice(0, 500),
        cfRay: gatewayResponse.headers.get('cf-ray'),
      });
      return c.json({
        error: {
          message: `AI Gateway error (${gatewayResponse.status}): ${errorText.slice(0, 200)}`,
          type: 'server_error',
        },
      }, gatewayResponse.status as 500);
    }

    // Pass through the response transparently — including streaming SSE.
    // The Gateway already returns proper OpenAI-format responses.
    log.info('ai_proxy.gateway_response', {
      userId,
      workspaceId,
      modelId,
      status: gatewayResponse.status,
      contentType: gatewayResponse.headers.get('content-type'),
      cfRay: gatewayResponse.headers.get('cf-ray'),
      aigLogId: gatewayResponse.headers.get('cf-aig-log-id'),
    });

    // Build response headers — preserve content-type and streaming headers from Gateway
    const responseHeaders = new Headers();
    const contentType = gatewayResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    if (body.stream) {
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('Connection', 'keep-alive');
      responseHeaders.set('X-Accel-Buffering', 'no');
    }

    return new Response(gatewayResponse.body, {
      status: gatewayResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    log.error('ai_proxy.gateway_fetch_error', {
      userId,
      workspaceId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({
      error: { message: 'Failed to reach AI Gateway. Please try again.', type: 'server_error' },
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
    owned_by: 'cloudflare',
  }));

  return c.json({ object: 'list', data: models });
});

// Export resolveModelId for testing
export { aiProxyRoutes, resolveModelId };
