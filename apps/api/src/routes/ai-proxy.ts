/**
 * POST /chat/completions — OpenAI-compatible AI inference proxy.
 *
 * Proxies requests to Cloudflare Workers AI, enabling trial users to use
 * OpenCode without bringing their own API key.
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

/** Resolve model ID: strip workers-ai/ prefix, fall back to default. */
function resolveModelId(model: string | undefined, env: Env): string {
  if (!model) return env.AI_PROXY_DEFAULT_MODEL || DEFAULT_AI_PROXY_MODEL;
  // Strip common prefixes that OpenCode may prepend
  let resolved = model;
  if (resolved.startsWith('workers-ai/')) {
    resolved = resolved.slice('workers-ai/'.length);
  }
  return resolved;
}

/** Generate a unique completion ID. */
function generateCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

/**
 * POST /chat/completions — OpenAI-compatible chat completions endpoint.
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
  const windowSeconds = 60;
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
    req.messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
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

  // --- Call Workers AI ---
  const completionId = generateCompletionId();
  const created = Math.floor(Date.now() / 1000);

  log.info('ai_proxy.inference_start', {
    userId,
    workspaceId,
    modelId,
    messageCount: req.messages.length,
    stream: req.stream,
    estimatedInputTokens,
  });

  try {
    if (req.stream) {
      return await handleStreamingRequest(c, {
        modelId,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        completionId,
        created,
        userId,
        workspaceId,
      });
    } else {
      return await handleNonStreamingRequest(c, {
        modelId,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        completionId,
        created,
        userId,
        workspaceId,
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

interface InferenceParams {
  modelId: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  completionId: string;
  created: number;
  userId: string;
  workspaceId: string;
}

async function handleNonStreamingRequest(
  c: { env: Env; json: (data: unknown, status?: number) => Response },
  params: InferenceParams,
): Promise<Response> {
  const { modelId, messages, temperature, max_tokens, completionId, created, userId, workspaceId } = params;

  const aiResponse = await c.env.AI.run(modelId as Parameters<Ai['run']>[0], {
    messages: messages.map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
    temperature,
    max_tokens,
  });

  // Workers AI returns either { response: string } or the content directly
  const content = typeof aiResponse === 'string'
    ? aiResponse
    : (aiResponse as { response?: string }).response ?? JSON.stringify(aiResponse);

  // Extract usage if available from Workers AI response
  const usage = (aiResponse as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  const promptTokens = usage?.prompt_tokens ?? Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4);
  const completionTokens = usage?.completion_tokens ?? Math.ceil(content.length / 4);

  // Update token budget (fire-and-forget in waitUntil would be ideal but c.executionCtx not available here)
  await incrementTokenUsage(c.env.KV, userId, promptTokens, completionTokens);

  log.info('ai_proxy.inference_complete', {
    userId,
    workspaceId,
    modelId,
    promptTokens,
    completionTokens,
    stream: false,
  });

  return c.json({
    id: completionId,
    object: 'chat.completion',
    created,
    model: modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

async function handleStreamingRequest(
  c: { env: Env; header: (name: string, value: string) => void; body: (data: ReadableStream | null, init?: ResponseInit) => Response },
  params: InferenceParams,
): Promise<Response> {
  const { modelId, messages, temperature, max_tokens, completionId, created, userId, workspaceId } = params;

  const aiStream = await c.env.AI.run(modelId as Parameters<Ai['run']>[0], {
    messages: messages.map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
    temperature,
    max_tokens,
    stream: true,
  });

  // Workers AI with stream: true returns a ReadableStream of text
  const encoder = new TextEncoder();
  let totalContent = '';
  let chunkCount = 0;

  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      // Workers AI streams text chunks directly
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);

      // Workers AI streaming returns SSE-formatted data like:
      // data: {"response":"token"}\n\n
      // Or sometimes just raw text chunks depending on the model.
      // We need to parse these and re-emit in OpenAI SSE format.
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') {
            // Don't forward upstream [DONE] — flush() sends exactly one [DONE]
            // after the final finish_reason: 'stop' chunk.
            return;
          }
          try {
            const parsed = JSON.parse(jsonStr);
            const tokenContent = parsed.response ?? '';
            if (tokenContent) {
              totalContent += tokenContent;
              chunkCount++;
              const sseData = JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{
                  index: 0,
                  delta: { content: tokenContent },
                  finish_reason: null,
                }],
              });
              controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
            }
          } catch {
            // Non-JSON line from Workers AI — treat as raw content
            if (jsonStr) {
              totalContent += jsonStr;
              chunkCount++;
              const sseData = JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{
                  index: 0,
                  delta: { content: jsonStr },
                  finish_reason: null,
                }],
              });
              controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
            }
          }
        } else if (line.trim() && !line.startsWith(':')) {
          // Raw text content (some models don't use SSE format)
          totalContent += line;
          chunkCount++;
          const sseData = JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: { content: line },
              finish_reason: null,
            }],
          });
          controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
        }
      }
    },
    async flush(controller) {
      // Send final chunk with finish_reason
      const finalData = JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      });
      controller.enqueue(encoder.encode(`data: ${finalData}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));

      // Update token budget with estimates
      const promptTokens = Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4);
      const completionTokens = Math.ceil(totalContent.length / 4);
      // Best-effort budget update — don't block the stream close
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

  // Pipe the AI stream through the transform
  const readable = (aiStream as ReadableStream).pipeThrough(transformStream);

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
