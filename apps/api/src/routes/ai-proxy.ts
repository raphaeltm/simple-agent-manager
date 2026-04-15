/**
 * AI inference proxy — OpenAI-compatible chat/completions + model list.
 *
 * Uses the Workers AI binding (c.env.AI) to call models, with optional
 * AI Gateway routing for analytics and caching. Transforms Workers AI
 * native responses into OpenAI-compatible format for OpenCode consumption.
 *
 * Always calls Workers AI in non-streaming mode for reliability, then
 * wraps the response as SSE events if the client requested streaming.
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
  DEFAULT_AI_PROXY_STREAM_TIMEOUT_MS,
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

/** Extract the Workers AI model name from the model ID.
 * Strips the `workers-ai/` provider prefix since the AI binding doesn't need it. */
function toWorkersAiModel(modelId: string): string {
  return modelId.startsWith('workers-ai/')
    ? modelId.slice('workers-ai/'.length)
    : modelId;
}

/** Generate a unique completion ID. */
function generateCompletionId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Extract text content length from a message for token estimation. */
function messageContentLength(msg: { content?: string | null }): number {
  return (msg.content ?? '').length;
}

/** Build AI binding options, optionally routing through AI Gateway. */
function getAiRunOptions(env: Env): { gateway?: { id: string } } {
  const gatewayId = env.AI_GATEWAY_ID || DEFAULT_AI_GATEWAY_ID;
  // Only use gateway if explicitly configured
  if (env.AI_GATEWAY_ID) {
    return { gateway: { id: gatewayId } };
  }
  return {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkersAiToolCall = { name: string; arguments: Record<string, unknown> | string };

/** Strip `<think>...</think>` reasoning tags from model output.
 * Some Workers AI models (Qwen3, Llama 4 Scout) wrap reasoning in these tags.
 * OpenCode may try to parse these as "thinking" ContentBlocks, causing ACP marshal
 * errors ("unexpected end of JSON input") when the thinking content is empty or malformed.
 * We strip the tags and return only the non-thinking content. */
function stripThinkingTags(text: string): string {
  // Remove <think>...</think> blocks (including multiline, lazy match)
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Also handle unclosed <think> tags (model cut off mid-reasoning)
  return stripped.replace(/<think>[\s\S]*/gi, '').trim();
}

/** Normalize Workers AI result to a consistent shape.
 * Workers AI text-generation models can return different shapes:
 * - { response: string } — simple text completion
 * - { response: string, tool_calls: [{name, arguments}] } — tool-calling with explicit array
 * - { response: {name, arguments}, tool_calls: [] } — tool call embedded in response field (Qwen)
 * - A ReadableStream if stream: true was somehow set
 * - Possibly a string directly for older models
 *
 * When the model decides to call a tool, some Workers AI models put the tool call
 * in the `response` field as a JSON object (with name + arguments) instead of
 * populating the `tool_calls` array. We detect this and normalize to tool_calls.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeWorkersAiResult(raw: any): { response?: string; tool_calls?: WorkersAiToolCall[] } {
  if (!raw) return { response: '' };
  if (typeof raw === 'string') return { response: stripThinkingTags(raw) || '' };
  if (raw instanceof ReadableStream) {
    return { response: '[streaming result — unexpected]' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let toolCalls: WorkersAiToolCall[] | undefined = raw.tool_calls?.length ? raw.tool_calls : undefined;
  let response: string | undefined;

  // Check if response is a tool call object (Qwen model behavior)
  if (raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response)) {
    const resp = raw.response;
    if (resp.name && resp.arguments !== undefined) {
      // The response IS a tool call — move it to tool_calls
      toolCalls = [{ name: resp.name, arguments: resp.arguments }];
      response = undefined; // No text content when tool calling
    } else {
      // Unknown object shape — stringify it
      response = JSON.stringify(raw.response);
    }
  } else {
    const rawResponse = typeof raw.response === 'string' ? raw.response : (raw.response ? String(raw.response) : '');
    response = stripThinkingTags(rawResponse) || rawResponse || '';
  }

  return { response, tool_calls: toolCalls };
}

/** Transform Workers AI tool_calls to OpenAI format. */
function transformToolCalls(toolCalls: WorkersAiToolCall[]): Array<{
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  return toolCalls.map((tc, i) => ({
    id: `call_${Date.now()}_${i}`,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments),
    },
  }));
}

/**
 * POST /chat/completions — OpenAI-compatible chat completions endpoint.
 * Uses Workers AI binding with optional AI Gateway routing.
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

  // --- Call Workers AI ---
  const workersAiModel = toWorkersAiModel(modelId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiInputs: Record<string, any> = {
    messages: req.messages,
    // Always non-streaming — Workers AI streaming format differs from OpenAI and causes
    // ACP ContentBlock marshal errors. We buffer the full response and wrap as SSE if needed.
    stream: false,
  };
  if (req.temperature !== undefined) aiInputs.temperature = req.temperature;
  if (req.max_tokens !== undefined) aiInputs.max_tokens = req.max_tokens;
  if (req.tools?.length) aiInputs.tools = req.tools;
  if (req.tool_choice !== undefined) aiInputs.tool_choice = req.tool_choice;

  const aiOptions = getAiRunOptions(c.env);

  log.info('ai_proxy.inference_start', {
    userId,
    workspaceId,
    modelId,
    workersAiModel,
    messageCount: req.messages.length,
    clientStream: req.stream,
    hasTools: (req.tools?.length ?? 0) > 0,
    toolCount: req.tools?.length ?? 0,
    hasGateway: !!aiOptions.gateway,
    estimatedInputTokens,
  });

  const streamTimeoutMs = parseInt(c.env.AI_PROXY_STREAM_TIMEOUT_MS || '', 10) || DEFAULT_AI_PROXY_STREAM_TIMEOUT_MS;

  try {
    // Call Workers AI binding with a timeout guard.
    // The AI binding is an I/O operation (doesn't count against CPU time) but we add
    // a timeout to prevent indefinite hangs if the model is unresponsive.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const startMs = Date.now();
    const aiPromise = (c.env.AI as any).run(workersAiModel, aiInputs, aiOptions);

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Workers AI inference timed out after ${streamTimeoutMs}ms`)), streamTimeoutMs),
    );

    const rawResult = await Promise.race([aiPromise, timeoutPromise]);
    const elapsedMs = Date.now() - startMs;

    // Workers AI may return different shapes depending on model/version.
    // Normalize to { response, tool_calls }.
    const result = normalizeWorkersAiResult(rawResult);

    log.info('ai_proxy.workers_ai_result', {
      userId,
      workspaceId,
      elapsedMs,
      hasResponse: !!result.response,
      responseLength: result.response?.length ?? 0,
      responsePreview: result.response?.substring(0, 200),
      hasToolCalls: !!(result.tool_calls?.length),
      toolCallCount: result.tool_calls?.length ?? 0,
      toolCallNames: result.tool_calls?.map(tc => tc.name).join(','),
      rawResultType: typeof rawResult,
      rawResultKeys: rawResult && typeof rawResult === 'object' ? Object.keys(rawResult).join(',') : 'N/A',
    });

    // Use actual usage from Workers AI if available, otherwise estimate
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawUsage = (rawResult as any)?.usage;
    const promptTokens = rawUsage?.prompt_tokens ?? Math.ceil(
      (aiInputs.messages as Array<{ content?: string }>)
        .reduce((s, m) => s + (m.content?.length ?? 0), 0) / 4,
    );
    const completionTokens = rawUsage?.completion_tokens ?? Math.ceil((result.response?.length ?? 0) / 4);

    if (promptTokens || completionTokens) {
      incrementTokenUsage(c.env.KV, userId, promptTokens, completionTokens).catch((err) => {
        log.error('ai_proxy.budget_update_failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Build OpenAI-format response
    const completionId = generateCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const hasToolCalls = result.tool_calls && result.tool_calls.length > 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message: Record<string, any> = {
      role: 'assistant',
      content: result.response ?? null,
    };
    if (hasToolCalls) {
      message.tool_calls = transformToolCalls(result.tool_calls!);
    }

    const openAiResponse = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{
        index: 0,
        message,
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    log.info('ai_proxy.inference_complete', {
      userId,
      workspaceId,
      modelId,
      promptTokens,
      completionTokens,
      finishReason: hasToolCalls ? 'tool_calls' : 'stop',
      clientStream: req.stream,
    });

    if (req.stream) {
      // Client requested streaming — wrap the complete response in SSE events
      return formatAsSSE(openAiResponse, completionId, created, modelId, message, hasToolCalls);
    } else {
      return new Response(JSON.stringify(openAiResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    log.error('ai_proxy.inference_error', {
      userId,
      workspaceId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(JSON.stringify({
      error: { message: 'Inference failed. Please try again.', type: 'server_error' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
});

/** Format a complete response as SSE events for streaming clients. */
function formatAsSSE(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _fullResponse: Record<string, any>,
  completionId: string,
  created: number,
  modelId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: Record<string, any>,
  hasToolCalls: boolean | undefined,
): Response {
  const events: string[] = [];

  // First chunk: role
  events.push(`data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{
      index: 0,
      delta: { role: 'assistant' },
      finish_reason: null,
    }],
  })}\n\n`);

  // Content chunk (if any)
  if (message.content) {
    events.push(`data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: { content: message.content },
        finish_reason: null,
      }],
    })}\n\n`);
  }

  // Tool calls chunk (if any)
  if (hasToolCalls && message.tool_calls) {
    events.push(`data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: { tool_calls: message.tool_calls },
        finish_reason: null,
      }],
    })}\n\n`);
  }

  // Final chunk with finish_reason
  events.push(`data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
    }],
  })}\n\n`);

  events.push('data: [DONE]\n\n');

  return new Response(events.join(''), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

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

export { aiProxyRoutes };
