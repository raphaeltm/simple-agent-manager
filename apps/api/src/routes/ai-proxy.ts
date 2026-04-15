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
function messageContentLength(msg: { content?: string | unknown[] | null }): number {
  if (typeof msg.content === 'string') return msg.content.length;
  if (Array.isArray(msg.content)) return JSON.stringify(msg.content).length;
  return 0;
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

/** Workers AI tool call — either native format (name + arguments at top level)
 * or OpenAI format (id + type + function.name + function.arguments). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkersAiToolCall = {
  name?: string;
  arguments?: Record<string, unknown> | string;
  id?: string;
  type?: string;
  function?: { name: string; arguments: string };
};

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
function normalizeWorkersAiResult(raw: any): { response?: string; tool_calls?: WorkersAiToolCall[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } {
  if (!raw) return { response: '' };
  if (typeof raw === 'string') return { response: stripThinkingTags(raw) || '' };
  if (raw instanceof ReadableStream) {
    return { response: '[streaming result — unexpected]' };
  }

  // Some Workers AI models (Qwen3) return full OpenAI-compatible format with choices[].
  // Detect and extract from that format first.
  if (raw.choices?.length && raw.choices[0]?.message) {
    const msg = raw.choices[0].message;
    const toolCalls = msg.tool_calls?.length ? msg.tool_calls : undefined;
    let response = typeof msg.content === 'string' ? stripThinkingTags(msg.content) : '';
    // If content is just whitespace and we have tool calls, treat as no content
    if (toolCalls && response.trim() === '') response = '';
    return {
      response: response || undefined,
      tool_calls: toolCalls,
      usage: raw.usage,
    };
  }

  // Native Workers AI format: { response: string, tool_calls: [...] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let toolCalls: WorkersAiToolCall[] | undefined = raw.tool_calls?.length ? raw.tool_calls : undefined;
  let response: string | undefined;

  // Check if response is a tool call object (older Qwen model behavior)
  if (raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response)) {
    const resp = raw.response;
    if (resp.name && resp.arguments !== undefined) {
      toolCalls = [{ name: resp.name, arguments: resp.arguments }];
      response = undefined;
    } else {
      response = JSON.stringify(raw.response);
    }
  } else {
    const rawResponse = typeof raw.response === 'string' ? raw.response : (raw.response ? String(raw.response) : '');
    response = stripThinkingTags(rawResponse) || rawResponse || '';
  }

  return { response, tool_calls: toolCalls, usage: raw.usage };
}

/** Transform Workers AI tool_calls to OpenAI format.
 * Ensures arguments is always a valid JSON string — Workers AI models may
 * return empty strings, undefined, or malformed arguments that cause
 * ACP ContentBlock marshal failures if passed through as-is. */
function transformToolCalls(toolCalls: WorkersAiToolCall[]): Array<{
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  return toolCalls.map((tc, i) => {
    // Handle OpenAI-format tool calls (Qwen3 returns these directly)
    if (tc.function?.name) {
      let args = tc.function.arguments || '{}';
      try { JSON.parse(args); } catch { args = '{}'; }
      return {
        id: tc.id || `call_${Date.now()}_${i}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: args,
        },
      };
    }

    // Handle native Workers AI format (name + arguments at top level)
    let args: string;
    if (typeof tc.arguments === 'string') {
      try { JSON.parse(tc.arguments); args = tc.arguments; } catch {
        args = tc.arguments ? JSON.stringify({ raw: tc.arguments }) : '{}';
      }
    } else if (tc.arguments !== null && tc.arguments !== undefined) {
      args = JSON.stringify(tc.arguments);
    } else {
      args = '{}';
    }
    return {
      id: tc.id || `call_${Date.now()}_${i}`,
      type: 'function' as const,
      function: {
        name: tc.name || 'unknown',
        arguments: args,
      },
    };
  });
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
  const hasTools = (req.tools?.length ?? 0) > 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiInputs: Record<string, any> = {
    messages: req.messages,
    // Use real streaming when client requests it and no tools are involved.
    // Tool-calling requires the full response to extract tool_calls array, so we
    // must buffer for those. For text-only streaming, Workers AI returns a
    // ReadableStream in EventSource format ({"response":"token"}\n) that we
    // transform into OpenAI-compatible SSE chunks.
    stream: req.stream && !hasTools,
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
    realStream: req.stream && !hasTools,
    hasTools,
    toolCount: req.tools?.length ?? 0,
    hasGateway: !!aiOptions.gateway,
    estimatedInputTokens,
  });

  const streamTimeoutMs = parseInt(c.env.AI_PROXY_STREAM_TIMEOUT_MS || '', 10) || DEFAULT_AI_PROXY_STREAM_TIMEOUT_MS;

  try {
    const startMs = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiPromise = (c.env.AI as any).run(workersAiModel, aiInputs, aiOptions);

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Workers AI inference timed out after ${streamTimeoutMs}ms`)), streamTimeoutMs),
    );

    const rawResult = await Promise.race([aiPromise, timeoutPromise]);

    // --- Real streaming path: transform Workers AI stream to OpenAI SSE ---
    if (req.stream && !hasTools && rawResult instanceof ReadableStream) {
      const completionId = generateCompletionId();
      const created = Math.floor(Date.now() / 1000);

      log.info('ai_proxy.streaming_start', { userId, workspaceId, modelId, completionId });

      // Estimate input tokens for budget tracking (output tracked per-chunk is impractical,
      // so we estimate after the fact via a rough character count)
      const estimatedPromptTokens = Math.ceil(
        req.messages.reduce((sum, m) => sum + messageContentLength(m), 0) / 4,
      );

      const outputStream = transformWorkersAiStream(
        rawResult as ReadableStream<Uint8Array>,
        completionId,
        created,
        modelId,
      );

      // Background: update token budget after stream completes (best-effort)
      // We can't know output tokens until the stream finishes, so we estimate
      // a minimum and rely on the daily budget being generous enough.
      incrementTokenUsage(c.env.KV, userId, estimatedPromptTokens, 0).catch((err) => {
        log.error('ai_proxy.budget_update_failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return new Response(outputStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // --- Non-streaming path (tool calls or non-streaming client) ---
    const elapsedMs = Date.now() - startMs;
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
    });

    const usage = result.usage ?? (rawResult as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
    const promptTokens = usage?.prompt_tokens ?? Math.ceil(
      (aiInputs.messages as Array<{ content?: string }>)
        .reduce((s, m) => s + (m.content?.length ?? 0), 0) / 4,
    );
    const completionTokens = usage?.completion_tokens ?? Math.ceil((result.response?.length ?? 0) / 4);

    if (promptTokens || completionTokens) {
      incrementTokenUsage(c.env.KV, userId, promptTokens, completionTokens).catch((err) => {
        log.error('ai_proxy.budget_update_failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const completionId = generateCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const hasToolCalls = result.tool_calls && result.tool_calls.length > 0;

    const responseContent = hasToolCalls
      ? (result.response || null)
      : (result.response ?? '');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message: Record<string, any> = {
      role: 'assistant',
      content: responseContent,
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
      // Client requested streaming but we used non-streaming for tool calls —
      // wrap the complete response in SSE events
      return formatAsSSE(completionId, created, modelId, message, hasToolCalls);
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

/** Transform a Workers AI streaming response into OpenAI-compatible SSE.
 *
 * Workers AI models return two different streaming formats:
 *
 * 1. Native format (Llama models):
 *    data: {"response":"token"}
 *    data: [DONE]
 *
 * 2. OpenAI-compatible format (Qwen3):
 *    data: {"choices":[{"delta":{"content":"token"}}]}
 *    data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}
 *    data: [DONE]
 *
 * We detect the format from the first chunk and handle both, outputting
 * standard OpenAI chat.completion.chunk format in all cases.
 * Strips reasoning_content (Qwen3) and <think> tags (Llama) from output.
 */
function transformWorkersAiStream(
  workersStream: ReadableStream<Uint8Array>,
  completionId: string,
  created: number,
  modelId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let sentRole = false;
  let sentDone = false;
  let thinkingBuffer = '';
  let insideThink = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = workersStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);

            if (payload === '[DONE]') {
              if (!sentRole) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { role: 'assistant' }, null))}\n\n`));
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, {}, 'stop'))}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              sentDone = true;
              continue;
            }

            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const parsed: any = JSON.parse(payload);

              // Detect format: OpenAI-compatible has choices[], native has response
              if (parsed.choices?.length) {
                // OpenAI-compatible format (Qwen3)
                const delta = parsed.choices[0]?.delta;
                if (!delta) continue;

                // Send role if this is the first chunk with role
                if (delta.role && !sentRole) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { role: delta.role }, null))}\n\n`));
                  sentRole = true;
                }

                // Skip reasoning_content chunks (Qwen3 thinking)
                if (delta.reasoning_content !== undefined) continue;

                // Forward content chunks
                if (delta.content !== undefined && delta.content !== null) {
                  const cleaned = processStreamToken(delta.content);
                  if (cleaned) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { content: cleaned }, null))}\n\n`));
                  }
                }

                // Forward finish_reason
                if (parsed.choices[0]?.finish_reason) {
                  if (!sentRole) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { role: 'assistant' }, null))}\n\n`));
                    sentRole = true;
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, {}, parsed.choices[0].finish_reason))}\n\n`));
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  sentDone = true;
                }
              } else {
                // Native Workers AI format (Llama models)
                if (!sentRole) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { role: 'assistant' }, null))}\n\n`));
                  sentRole = true;
                }

                const token = parsed.response ?? '';
                if (token) {
                  const cleaned = processStreamToken(token);
                  if (cleaned) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { content: cleaned }, null))}\n\n`));
                  }
                }
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        // Ensure we always send termination
        if (!sentDone) {
          if (!sentRole) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { role: 'assistant' }, null))}\n\n`));
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, {}, 'stop'))}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  /** Process a streaming token, stripping <think> tags. */
  function processStreamToken(token: string): string {
    let result = '';
    for (const char of token) {
      if (insideThink) {
        thinkingBuffer += char;
        if (thinkingBuffer.endsWith('</think>')) {
          insideThink = false;
          thinkingBuffer = '';
        }
      } else {
        thinkingBuffer += char;
        if (thinkingBuffer.endsWith('<think>')) {
          insideThink = true;
          result = result.slice(0, result.length - '<think'.length);
          thinkingBuffer = '';
        } else if (thinkingBuffer.length > 7) {
          result += thinkingBuffer;
          thinkingBuffer = '';
        }
      }
    }
    if (!insideThink && thinkingBuffer.length > 7) {
      result += thinkingBuffer;
      thinkingBuffer = '';
    }
    return result;
  }
}

/** Build an OpenAI chat.completion.chunk object. */
function makeChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Format a buffered (non-streaming) response as SSE events for streaming clients.
 * Used when tool calls require buffering the full Workers AI response. */
function formatAsSSE(
  completionId: string,
  created: number,
  modelId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: Record<string, any>,
  hasToolCalls: boolean | undefined,
): Response {
  const events: string[] = [];

  // First chunk: role
  events.push(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { role: 'assistant' }, null))}\n\n`);

  // Content chunk
  if (message.content !== null && message.content !== undefined) {
    events.push(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { content: message.content || '' }, null))}\n\n`);
  }

  // Tool calls chunk
  if (hasToolCalls && message.tool_calls) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCallsWithIndex = message.tool_calls.map((tc: any, i: number) => ({
      index: i,
      ...tc,
    }));
    events.push(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, { tool_calls: toolCallsWithIndex }, null))}\n\n`);
  }

  // Final chunk with finish_reason
  events.push(`data: ${JSON.stringify(makeChunk(completionId, created, modelId, {}, hasToolCalls ? 'tool_calls' : 'stop'))}\n\n`);
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

/** TEMPORARY debug endpoint — full chat/completions without auth for direct testing.
 * Mirrors the real endpoint but skips auth/rate-limit/budget checks.
 * Remove before merging to production. */
aiProxyRoutes.post('/debug/chat', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
  }

  const parsed = chatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`, type: 'invalid_request_error' } }, 400);
  }
  const req = parsed.data;

  const modelId = resolveModelId(req.model, c.env);
  const workersAiModel = toWorkersAiModel(modelId);
  const hasTools = (req.tools?.length ?? 0) > 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiInputs: Record<string, any> = {
    messages: req.messages,
    stream: req.stream && !hasTools,
  };
  if (req.temperature !== undefined) aiInputs.temperature = req.temperature;
  if (req.max_tokens !== undefined) aiInputs.max_tokens = req.max_tokens;
  if (req.tools?.length) aiInputs.tools = req.tools;
  if (req.tool_choice !== undefined) aiInputs.tool_choice = req.tool_choice;

  const aiOptions = getAiRunOptions(c.env);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawResult = await (c.env.AI as any).run(workersAiModel, aiInputs, aiOptions);

    // Real streaming path
    if (req.stream && !hasTools && rawResult instanceof ReadableStream) {
      const completionId = generateCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const outputStream = transformWorkersAiStream(rawResult as ReadableStream<Uint8Array>, completionId, created, modelId);
      return new Response(outputStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // Non-streaming path
    const result = normalizeWorkersAiResult(rawResult);
    const completionId = generateCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const hasToolCalls = result.tool_calls && result.tool_calls.length > 0;
    const responseContent = hasToolCalls ? (result.response || null) : (result.response ?? '');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message: Record<string, any> = { role: 'assistant', content: responseContent };
    if (hasToolCalls) message.tool_calls = transformToolCalls(result.tool_calls!);

    const usage = result.usage ?? (rawResult as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
    const openAiResponse = {
      id: completionId, object: 'chat.completion', created, model: modelId,
      choices: [{ index: 0, message, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: usage?.prompt_tokens ?? 0, completion_tokens: usage?.completion_tokens ?? 0, total_tokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0) },
    };

    if (req.stream) {
      return formatAsSSE(completionId, created, modelId, message, hasToolCalls);
    }
    return new Response(JSON.stringify(openAiResponse), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return c.json({ error: { message: err instanceof Error ? err.message : String(err), type: 'server_error' } }, 502);
  }
});

/** TEMPORARY debug endpoint — test Workers AI directly without VM/auth overhead.
 * Accepts a simple prompt, calls Workers AI both streaming and non-streaming,
 * and returns raw results. Remove before merging to production. */
aiProxyRoutes.post('/debug/test', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const prompt = body.prompt || 'Say hello in one sentence.';
  const model = body.model || toWorkersAiModel(c.env.AI_PROXY_DEFAULT_MODEL || DEFAULT_AI_PROXY_MODEL);
  const testStream = body.stream ?? false;
  const tools = body.tools;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiInputs: Record<string, any> = {
    messages: [{ role: 'user', content: prompt }],
    stream: testStream,
  };
  if (tools) aiInputs.tools = tools;

  try {
    const startMs = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawResult = await (c.env.AI as any).run(model, aiInputs);
    const elapsedMs = Date.now() - startMs;

    if (testStream && rawResult instanceof ReadableStream) {
      // For stream testing, collect all chunks and return as JSON
      const reader = rawResult.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        chunks.push(text);
        // Parse SSE data lines
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              if (parsed.response) fullText += parsed.response;
            } catch { /* skip */ }
          }
        }
      }
      return c.json({
        model,
        mode: 'streaming',
        elapsedMs,
        chunkCount: chunks.length,
        fullText,
        rawChunks: chunks.slice(0, 10), // First 10 chunks for inspection
      });
    }

    // Non-streaming
    const normalized = normalizeWorkersAiResult(rawResult);
    return c.json({
      model,
      mode: 'non-streaming',
      elapsedMs,
      rawResultType: typeof rawResult,
      rawResultKeys: rawResult && typeof rawResult === 'object' ? Object.keys(rawResult) : [],
      rawResultPreview: JSON.stringify(rawResult).substring(0, 3000),
      normalized,
    });
  } catch (err) {
    return c.json({
      model,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }, 500);
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

export { aiProxyRoutes };
