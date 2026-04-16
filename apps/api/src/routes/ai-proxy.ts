/**
 * AI inference proxy — routes requests through Cloudflare AI Gateway.
 *
 * The AI Gateway provides an OpenAI-compatible endpoint for Workers AI models.
 * This proxy handles SAM-specific concerns (auth, rate limiting, token budgets)
 * and strips model-specific artifacts (e.g., <think> reasoning tags) from
 * streaming responses before forwarding to OpenCode.
 *
 * Auth: Bearer token in Authorization header (workspace callback token).
 * Rate limit: per-user RPM via KV.
 * Token budget: per-user daily input/output token limits via KV.
 * Metadata: cf-aig-metadata header for AI Gateway analytics/monitoring.
 *
 * Mount point: app.route('/ai/v1', aiProxyRoutes) in index.ts.
 */
import {
  DEFAULT_AI_PROXY_ALLOWED_MODELS,
  DEFAULT_AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST,
  DEFAULT_AI_PROXY_MODEL,
  DEFAULT_AI_PROXY_RATE_LIMIT_RPM,
  DEFAULT_AI_PROXY_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_AI_PROXY_STREAM_TIMEOUT_MS,
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

// =============================================================================
// <think> tag stripping — Qwen3 and similar models wrap reasoning in
// <think>...</think> tags which produce empty visible content when passed
// through transparently. These helpers strip thinking content from both
// streaming (SSE) and non-streaming responses.
// =============================================================================

/** Regex to match <think>...</think> blocks (including across newlines). */
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/g;

/**
 * Strip <think>...</think> content from a string.
 * Handles both complete tags and trailing unclosed tags.
 */
function stripThinkTags(text: string): string {
  // Strip complete <think>...</think> blocks
  let result = text.replace(THINK_TAG_RE, '');
  // Strip unclosed <think> tag and everything after it (partial streaming chunk)
  const openIdx = result.indexOf('<think>');
  if (openIdx !== -1) {
    result = result.slice(0, openIdx);
  }
  return result;
}

/**
 * Strip <think> tags from a non-streaming chat completion response body.
 * Returns the modified JSON string, or the original if parsing fails.
 */
function stripThinkTagsFromResponse(bodyText: string): string {
  try {
    const data = JSON.parse(bodyText);
    if (data.choices && Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (choice.message && typeof choice.message.content === 'string') {
          choice.message.content = stripThinkTags(choice.message.content).trim();
        }
      }
    }
    return JSON.stringify(data);
  } catch {
    return bodyText;
  }
}

/**
 * State machine for stripping <think> tags from an SSE stream.
 *
 * Processes `data: {json}` lines from the AI Gateway, removes thinking
 * content from `choices[].delta.content`, and suppresses chunks that
 * become empty after stripping. Passes non-data lines (comments, blank
 * lines, `data: [DONE]`) through unchanged.
 */
class ThinkTagStripper {
  private insideThink = false;
  private buffer = '';

  /** Process a single SSE data payload. Returns the (possibly modified) line, or null to suppress. */
  processLine(line: string): string | null {
    // Pass through non-data lines unchanged
    if (!line.startsWith('data: ')) return line;

    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return line;

    try {
      const data = JSON.parse(payload);
      if (!data.choices?.[0]?.delta) return line;

      const delta = data.choices[0].delta;
      if (typeof delta.content !== 'string') return line;

      const content = delta.content;

      // Process the content character by character for state tracking
      let output = '';
      for (let i = 0; i < content.length; i++) {
        if (!this.insideThink) {
          this.buffer += content[i];
          // Check if buffer ends with <think>
          if (this.buffer.endsWith('<think>')) {
            // Remove the <think> tag from output and enter thinking mode
            output = output.slice(0, -(('<think>'.length) - 1));
            this.buffer = '';
            this.insideThink = true;
          } else {
            output += content[i];
            // Keep buffer bounded — only need enough to detect <think>
            if (this.buffer.length > 10) {
              this.buffer = this.buffer.slice(-7);
            }
          }
        } else {
          this.buffer += content[i];
          // Check if buffer ends with </think>
          if (this.buffer.endsWith('</think>')) {
            this.buffer = '';
            this.insideThink = false;
          } else if (this.buffer.length > 10) {
            // Keep buffer bounded — only need enough to detect </think>
            this.buffer = this.buffer.slice(-8);
          }
        }
      }

      // If the chunk is entirely thinking content, suppress it
      if (output.length === 0 && content.length > 0) {
        return null;
      }

      // Update the content and re-serialize
      if (output !== delta.content) {
        delta.content = output;
        return `data: ${JSON.stringify(data)}`;
      }

      return line;
    } catch {
      // If JSON parsing fails, pass through unchanged
      return line;
    }
  }
}

/**
 * Create a TransformStream that strips <think> tags from an SSE stream.
 * Each SSE event is processed through the ThinkTagStripper state machine.
 */
function createThinkTagStrippingStream(): TransformStream<Uint8Array, Uint8Array> {
  const stripper = new ThinkTagStripper();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let remainder = '';

  return new TransformStream({
    transform(chunk, controller) {
      const text = remainder + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');

      // Last element may be incomplete — save it for the next chunk
      remainder = lines.pop() || '';

      const outputLines: string[] = [];
      for (const line of lines) {
        const result = stripper.processLine(line);
        if (result !== null) {
          outputLines.push(result);
        }
      }

      if (outputLines.length > 0) {
        controller.enqueue(encoder.encode(outputLines.join('\n') + '\n'));
      }
    },
    flush(controller) {
      // Process any remaining data
      if (remainder) {
        const result = stripper.processLine(remainder);
        if (result !== null) {
          controller.enqueue(encoder.encode(result + '\n'));
        }
      }
    },
  });
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

  // --- Timeout guard for upstream request ---
  const streamTimeoutMs = parseInt(c.env.AI_PROXY_STREAM_TIMEOUT_MS || '', 10)
    || DEFAULT_AI_PROXY_STREAM_TIMEOUT_MS;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), streamTimeoutMs);

    const gatewayResponse = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
        'cf-aig-metadata': aigMetadata,
      },
      body: JSON.stringify(gatewayBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

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

    // --- Response transformation: strip <think> tags from model output ---
    // Some models (Qwen3, etc.) wrap reasoning in <think>...</think> tags.
    // These produce empty visible content when passed through to OpenCode.
    if (body.stream && gatewayResponse.body) {
      // Streaming: pipe through a TransformStream that strips thinking tags from SSE chunks
      const strippedStream = gatewayResponse.body.pipeThrough(createThinkTagStrippingStream());
      return new Response(strippedStream, {
        status: gatewayResponse.status,
        headers: responseHeaders,
      });
    }

    if (!body.stream) {
      // Non-streaming: parse response, strip thinking tags, re-serialize
      const responseText = await gatewayResponse.text();
      const strippedText = stripThinkTagsFromResponse(responseText);
      return new Response(strippedText, {
        status: gatewayResponse.status,
        headers: responseHeaders,
      });
    }

    // Fallback: pass through unchanged (no body on streaming response — shouldn't happen)
    return new Response(gatewayResponse.body, {
      status: gatewayResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    log.error('ai_proxy.gateway_fetch_error', {
      userId,
      workspaceId,
      modelId,
      error: isTimeout ? `Request timed out after ${streamTimeoutMs}ms` : (err instanceof Error ? err.message : String(err)),
      isTimeout,
    });
    if (isTimeout) {
      return c.json({
        error: { message: `AI Gateway request timed out after ${streamTimeoutMs / 1000}s`, type: 'timeout_error' },
      }, 504);
    }
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

// Export for testing
export { aiProxyRoutes, createThinkTagStrippingStream, resolveModelId, stripThinkTags, stripThinkTagsFromResponse };
