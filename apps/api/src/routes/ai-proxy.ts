/**
 * AI inference proxy — OpenAI-compatible chat/completions + model list.
 *
 * Proxies requests to Cloudflare AI Gateway's unified API, enabling
 * access to models from Workers AI, Anthropic, Google, and other providers
 * through a single OpenAI-compatible interface with full tool/function
 * calling support.
 *
 * Auth: Bearer token in Authorization header (workspace callback token).
 * Rate limit: per-user RPM via KV.
 * Token budget: per-user daily input/output token limits via KV.
 *
 * Mount point: app.route('/ai/v1', aiProxyRoutes) in index.ts.
 */
import {
  DEFAULT_AI_GATEWAY_ID,
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
import { chatCompletionRequestSchema } from '../schemas/ai-proxy';
import { checkTokenBudget, incrementTokenUsage } from '../services/ai-token-budget';
import { verifyCallbackToken } from '../services/jwt';

const aiProxyRoutes = new Hono<{ Bindings: Env }>();

/** Parse allowed models from env or use defaults. */
function getAllowedModels(env: Env): Set<string> {
  const raw = env.AI_PROXY_ALLOWED_MODELS || DEFAULT_AI_PROXY_ALLOWED_MODELS;
  return new Set(raw.split(',').map((m) => m.trim()).filter(Boolean));
}

/** Resolve model ID, falling back to default. */
function resolveModelId(model: string | undefined, env: Env): string {
  if (!model) return env.AI_PROXY_DEFAULT_MODEL || DEFAULT_AI_PROXY_MODEL;
  let resolved = model;
  // Strip workers-ai/ prefix if OpenCode prepends it (it adds the provider as a prefix)
  if (resolved.startsWith('workers-ai/workers-ai/')) {
    resolved = resolved.slice('workers-ai/'.length);
  }
  return resolved;
}

/** Build the AI Gateway URL.
 * Uses the Workers AI provider-specific endpoint for now (standard Bearer auth).
 * Future: switch to /compat/ unified API endpoint when provider BYOK keys are configured. */
function getGatewayUrl(env: Env): string {
  const accountId = env.CF_ACCOUNT_ID;
  const gatewayId = env.AI_GATEWAY_ID || DEFAULT_AI_GATEWAY_ID;
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1/chat/completions`;
}

/** Extract text content length from a message for token estimation. */
function messageContentLength(msg: { content?: string | null }): number {
  return (msg.content ?? '').length;
}

/**
 * POST /chat/completions — OpenAI-compatible chat completions endpoint.
 * Proxies to Cloudflare AI Gateway unified API.
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

  // --- Parse and validate request body ---
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }

  const parsed = chatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: {
        message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    }, 400);
  }
  const req = parsed.data;

  // --- Resolve and validate model ---
  const modelId = resolveModelId(req.model, c.env);
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
  const estimatedInputTokens = Math.ceil(
    req.messages.reduce((sum, m) => sum + messageContentLength(m), 0) / 4,
  );
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

  // --- Build gateway request ---
  const gatewayUrl = getGatewayUrl(c.env);
  // Strip provider prefix for the provider-specific gateway endpoint.
  // The gateway already knows the provider from the URL path.
  const gatewayModelId = modelId.startsWith('workers-ai/')
    ? modelId.slice('workers-ai/'.length)
    : modelId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gatewayBody: Record<string, any> = {
    model: gatewayModelId,
    messages: req.messages,
    stream: req.stream,
  };
  if (req.temperature !== undefined) gatewayBody.temperature = req.temperature;
  if (req.max_tokens !== undefined) gatewayBody.max_tokens = req.max_tokens;
  if (req.tools?.length) gatewayBody.tools = req.tools;
  if (req.tool_choice !== undefined) gatewayBody.tool_choice = req.tool_choice;

  log.info('ai_proxy.inference_start', {
    userId,
    workspaceId,
    modelId,
    gatewayModelId,
    gatewayUrl,
    messageCount: req.messages.length,
    stream: req.stream,
    hasTools: (req.tools?.length ?? 0) > 0,
    toolCount: req.tools?.length ?? 0,
    estimatedInputTokens,
  });

  try {
    if (req.stream) {
      return await handleStreamingRequest(c, {
        gatewayUrl,
        gatewayBody,
        modelId,
        userId,
        workspaceId,
        cfApiToken: c.env.CF_API_TOKEN,
      });
    } else {
      return await handleNonStreamingRequest(c, {
        gatewayUrl,
        gatewayBody,
        modelId,
        userId,
        workspaceId,
        cfApiToken: c.env.CF_API_TOKEN,
      });
    }
  } catch (err) {
    log.error('ai_proxy.inference_error', {
      userId,
      workspaceId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({
      error: { message: 'Inference failed. Please try again.', type: 'server_error' },
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

// --- Internal helpers ---

interface GatewayParams {
  gatewayUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gatewayBody: Record<string, any>;
  modelId: string;
  userId: string;
  workspaceId: string;
  cfApiToken: string;
}

async function handleNonStreamingRequest(
  c: { env: Env; json: (data: unknown, status?: number) => Response },
  params: GatewayParams,
): Promise<Response> {
  const { gatewayUrl, gatewayBody, modelId, userId, workspaceId, cfApiToken } = params;

  log.info('ai_proxy.gateway_fetch_start', {
    userId,
    workspaceId,
    gatewayUrl,
    model: gatewayBody.model,
    stream: gatewayBody.stream,
    hasApiToken: !!cfApiToken,
    apiTokenPrefix: cfApiToken?.slice(0, 8) + '...',
  });

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfApiToken}`,
    },
    body: JSON.stringify(gatewayBody),
  });

  log.info('ai_proxy.gateway_fetch_response', {
    userId,
    workspaceId,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type'),
    cfRay: response.headers.get('cf-ray'),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('ai_proxy.gateway_error', {
      userId,
      workspaceId,
      modelId,
      status: response.status,
      statusText: response.statusText,
      error: errorText.slice(0, 1000),
    });
    return c.json({
      error: { message: 'AI Gateway request failed', type: 'server_error', details: errorText.slice(0, 200) },
    }, 502);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await response.json() as any;

  // Extract usage for token budget tracking
  const promptTokens = result.usage?.prompt_tokens ?? 0;
  const completionTokens = result.usage?.completion_tokens ?? 0;
  if (promptTokens || completionTokens) {
    await incrementTokenUsage(c.env.KV, userId, promptTokens, completionTokens);
  }

  log.info('ai_proxy.inference_complete', {
    userId,
    workspaceId,
    modelId,
    promptTokens,
    completionTokens,
    stream: false,
  });

  // Pass through the gateway response as-is (already in OpenAI format)
  return c.json(result);
}

async function handleStreamingRequest(
  c: { env: Env; header: (name: string, value: string) => void; body: (data: ReadableStream | null, init?: ResponseInit) => Response },
  params: GatewayParams,
): Promise<Response> {
  const { gatewayUrl, gatewayBody, modelId, userId, workspaceId, cfApiToken } = params;

  log.info('ai_proxy.gateway_stream_fetch_start', {
    userId,
    workspaceId,
    gatewayUrl,
    model: gatewayBody.model,
    hasApiToken: !!cfApiToken,
  });

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfApiToken}`,
    },
    body: JSON.stringify(gatewayBody),
  });

  log.info('ai_proxy.gateway_stream_fetch_response', {
    userId,
    workspaceId,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type'),
    hasBody: !!response.body,
    cfRay: response.headers.get('cf-ray'),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    log.error('ai_proxy.gateway_stream_error', {
      userId,
      workspaceId,
      modelId,
      status: response.status,
      statusText: response.statusText,
      error: errorText.slice(0, 1000),
    });
    return new Response(JSON.stringify({
      error: { message: 'AI Gateway streaming request failed', type: 'server_error' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  // Track token usage from streaming response
  let totalContent = '';
  let chunkCount = 0;
  const encoder = new TextEncoder();

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      // Pass through chunks as-is — gateway already sends OpenAI SSE format
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);

      // Count content for token estimation
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr && jsonStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                totalContent += delta.content;
                chunkCount++;
              }
            } catch {
              // Non-JSON — pass through
            }
          }
        }
      }

      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
    async flush() {
      // Update token budget with estimates from streamed content
      const promptTokens = Math.ceil(
        (gatewayBody.messages as Array<{ content?: string }>)
          .reduce((s, m) => s + (m.content?.length ?? 0), 0) / 4,
      );
      const completionTokens = Math.ceil(totalContent.length / 4);

      incrementTokenUsage(c.env.KV, userId, promptTokens, completionTokens).catch((err) => {
        log.error('ai_proxy.budget_update_failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      log.info('ai_proxy.inference_complete', {
        userId,
        workspaceId,
        modelId,
        promptTokens,
        completionTokens,
        chunkCount,
        stream: true,
      });
    },
  });

  const readable = response.body.pipeThrough(transformStream);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export { aiProxyRoutes };
