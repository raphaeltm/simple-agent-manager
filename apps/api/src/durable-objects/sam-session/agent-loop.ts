/**
 * Agent loop — unified OpenAI-format code path routed through AI Gateway.
 *
 * Reusable by both SamSession (per-user) and ProjectAgent (per-project) DOs.
 * Callers provide their own system prompt, tool definitions, and tool executor.
 *
 * Internally uses OpenAI chat-completions format. The AI Gateway endpoint is
 * selected by model prefix:
 *   - @cf/* or @hf/*  → Workers AI  (OpenAI-native)
 *   - claude-*         → Anthropic   (translated at the boundary)
 *
 * Swapping models/providers is a config change (SAM_MODEL env var), not a code change.
 */
import {
  DEFAULT_SAM_MAX_REQUEST_BODY_BYTES_WORKERS_AI,
  SAM_ANTHROPIC_VERSION,
  type SamConfig,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { buildWorkersAIGatewayUrl } from '../../services/ai-proxy-shared';
import { checkAiUsageGate } from '../../services/ai-token-budget';
import { attachTokenUsageAccounting } from '../../services/ai-token-usage-accounting';
import { getPlatformAgentCredential } from '../../services/platform-credentials';
import {
  buildAnthropicGatewayUrl,
  encodeSseEvent,
  isAnthropicModel,
  isWorkersAIModel,
  type OpenAITool,
  parseToolInput,
  SAM_SYSTEM_PROMPT,
  toOpenAIMessages,
  toOpenAITools,
} from './agent-loop-helpers';
import type { OpenAIMessage } from './payload-size';
import { estimateMessagesBytes, trimMessagesToFit, truncateToolResult } from './payload-size';
import type { AnthropicToolDef, CollectedToolCall, MessageRow, ToolContext } from './types';

export { SAM_SYSTEM_PROMPT };

async function getAnthropicApiKey(env: Env): Promise<string> {
  const { drizzle } = await import('drizzle-orm/d1');
  const db = drizzle(env.DATABASE);
  const encryptionKey = getCredentialEncryptionKey(env);
  const cred = await getPlatformAgentCredential(db, 'claude-code', encryptionKey);
  if (!cred?.credential) {
    throw new Error(
      'No Anthropic API key configured. An admin must add a Claude Code platform credential.'
    );
  }
  return cred.credential;
}

/** Default fetch timeout for LLM calls (configurable via SAM_LLM_TIMEOUT_MS). */
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

async function callLLM(
  env: Env,
  config: SamConfig,
  messages: OpenAIMessage[],
  userId: string,
  conversationId: string,
  baseSystemPrompt: string,
  tools: AnthropicToolDef[]
): Promise<Response> {
  const model = config.model;
  const systemPrompt = config.systemPromptAppend
    ? `${baseSystemPrompt}\n\n${config.systemPromptAppend}`
    : baseSystemPrompt;

  const openAITools = toOpenAITools(tools);
  const aigMetadata = JSON.stringify({
    source: config.aigSource,
    userId,
    conversationId,
  });

  // Timeout to prevent hanging fetches inside DOs
  const timeoutMs =
    parseInt(String((env as unknown as Record<string, string>).SAM_LLM_TIMEOUT_MS) || '', 10) ||
    DEFAULT_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (isAnthropicModel(model)) {
      return await callAnthropicLLM(
        env,
        model,
        systemPrompt,
        messages,
        openAITools,
        aigMetadata,
        config.maxTokens,
        controller.signal,
        tools
      );
    } else if (isWorkersAIModel(model)) {
      return await callWorkersAILLM(
        env,
        model,
        systemPrompt,
        messages,
        openAITools,
        aigMetadata,
        config.maxTokens,
        controller.signal
      );
    } else {
      throw new Error(`Unknown model provider for model: ${model}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Call Anthropic Messages API, translating from OpenAI format at the boundary. */
async function callAnthropicLLM(
  env: Env,
  model: string,
  systemPrompt: string,
  messages: OpenAIMessage[],
  _openAITools: OpenAITool[],
  aigMetadata: string,
  maxTokens: number,
  signal: AbortSignal,
  anthropicTools: AnthropicToolDef[]
): Promise<Response> {
  const apiKey = await getAnthropicApiKey(env);
  const url = buildAnthropicGatewayUrl(env);

  // Convert OpenAI messages to Anthropic format
  const anthropicMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'user') {
        return { role: 'user' as const, content: m.content || '' };
      } else if (m.role === 'assistant') {
        const content: Array<Record<string, unknown>> = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              /* empty */
            }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
        }
        return { role: 'assistant' as const, content };
      } else if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            { type: 'tool_result', tool_use_id: m.tool_call_id || '', content: m.content || '' },
          ],
        };
      }
      return { role: 'user' as const, content: m.content || '' };
    });

  return fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': SAM_ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools,
      stream: true,
    }),
  });
}

/** Call Workers AI via AI Gateway (OpenAI-compatible). */
async function callWorkersAILLM(
  env: Env,
  model: string,
  systemPrompt: string,
  messages: OpenAIMessage[],
  openAITools: OpenAITool[],
  aigMetadata: string,
  maxTokens: number,
  signal: AbortSignal
): Promise<Response> {
  const url = buildWorkersAIGatewayUrl(env);

  const fullMessages: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }, ...messages];

  return fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: fullMessages,
      tools: openAITools.length > 0 ? openAITools : undefined,
      stream: true,
    }),
  });
}

/**
 * Process an Anthropic SSE stream (native Anthropic event format).
 * Writes SAM SSE events to the writer and collects tool calls.
 */
async function processAnthropicStream(
  response: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<{ textContent: string; toolCalls: CollectedToolCall[] }> {
  if (!response.body) {
    throw new Error('No response body from Anthropic');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';
  const toolCalls: CollectedToolCall[] = [];

  let currentToolId = '';
  let currentToolName = '';
  let currentToolInputJson = '';

  let streamDone = false;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) {
      streamDone = true;
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let event: Record<string, unknown>;
      try {
        event = expectJsonRecord(JSON.parse(data), 'sam-session.anthropic_stream.event');
      } catch {
        continue;
      }

      const eventType = event.type as string;

      if (eventType === 'content_block_start') {
        const block = expectJsonRecord(
          event.content_block,
          'sam-session.anthropic_stream.content_block'
        );
        if (block?.type === 'tool_use') {
          currentToolId = typeof block.id === 'string' ? block.id : '';
          currentToolName = typeof block.name === 'string' ? block.name : '';
          currentToolInputJson = '';
          await writer.write(
            encodeSseEvent({
              type: 'tool_start',
              tool: currentToolName,
              input: {},
            })
          );
        }
      } else if (eventType === 'content_block_delta') {
        const delta = expectJsonRecord(event.delta, 'sam-session.anthropic_stream.delta');
        if (delta?.type === 'text_delta') {
          const text = typeof delta.text === 'string' ? delta.text : '';
          textContent += text;
          await writer.write(encodeSseEvent({ type: 'text_delta', content: text }));
        } else if (delta?.type === 'input_json_delta') {
          currentToolInputJson += typeof delta.partial_json === 'string' ? delta.partial_json : '';
        }
      } else if (eventType === 'content_block_stop') {
        if (currentToolId) {
          const input = parseToolInput(
            currentToolInputJson,
            'sam-session.anthropic_stream.tool_input'
          );
          toolCalls.push({ id: currentToolId, name: currentToolName, input });
          currentToolId = '';
          currentToolName = '';
          currentToolInputJson = '';
        }
      } else if (eventType === 'error') {
        const errorObj = expectJsonRecord(event.error ?? {}, 'sam-session.anthropic_stream.error');
        const message =
          typeof errorObj.message === 'string' ? errorObj.message : 'Anthropic API error';
        await writer.write(encodeSseEvent({ type: 'error', message }));
      }
    }
  }

  return { textContent, toolCalls };
}

/**
 * Process an OpenAI-format SSE stream (Workers AI / OpenAI-compatible).
 * Writes SAM SSE events to the writer and collects tool calls.
 */
async function processOpenAIStream(
  response: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<{ textContent: string; toolCalls: CollectedToolCall[] }> {
  if (!response.body) {
    throw new Error('No response body from LLM');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';
  const toolCalls: CollectedToolCall[] = [];

  const toolCallBuilders = new Map<number, { id: string; name: string; args: string }>();

  let streamDone = false;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) {
      streamDone = true;
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let chunk: Record<string, unknown>;
      try {
        chunk = expectJsonRecord(JSON.parse(data), 'sam-session.openai_stream.chunk');
      } catch {
        continue;
      }

      const choices = Array.isArray(chunk.choices)
        ? chunk.choices.map((choice, index) =>
            expectJsonRecord(choice, `sam-session.openai_stream.choices[${index}]`)
          )
        : undefined;
      const firstChoice = choices?.[0];
      if (!firstChoice) continue;

      const delta = firstChoice.delta
        ? expectJsonRecord(firstChoice.delta, 'sam-session.openai_stream.delta')
        : undefined;
      if (!delta) continue;

      // Text content
      if (delta.content && typeof delta.content === 'string') {
        textContent += delta.content;
        await writer.write(encodeSseEvent({ type: 'text_delta', content: delta.content }));
      }

      // Tool calls (streamed as deltas with index)
      const deltaToolCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls.map((toolCall, index) =>
            expectJsonRecord(toolCall, `sam-session.openai_stream.tool_calls[${index}]`)
          )
        : undefined;
      if (deltaToolCalls) {
        for (const dtc of deltaToolCalls) {
          const index = typeof dtc.index === 'number' ? dtc.index : 0;
          const fn = dtc.function
            ? expectJsonRecord(dtc.function, 'sam-session.openai_stream.tool_call.function')
            : undefined;

          let builder = toolCallBuilders.get(index);
          if (!builder) {
            const id =
              typeof dtc.id === 'string' ? dtc.id : `call_${crypto.randomUUID().slice(0, 8)}`;
            const name = typeof fn?.name === 'string' ? fn.name : '';
            builder = { id, name, args: '' };
            toolCallBuilders.set(index, builder);
            if (name) {
              await writer.write(encodeSseEvent({ type: 'tool_start', tool: name, input: {} }));
            }
          }

          if (fn?.name && typeof fn.name === 'string' && !builder.name) {
            builder.name = fn.name;
            await writer.write(
              encodeSseEvent({ type: 'tool_start', tool: builder.name, input: {} })
            );
          }
          if (fn?.arguments && typeof fn.arguments === 'string') {
            builder.args += fn.arguments;
          }
        }
      }

      // Finalize tool calls on finish_reason
      const finishReason =
        typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : undefined;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        for (const [, builder] of toolCallBuilders) {
          if (builder.name) {
            const input = parseToolInput(builder.args, 'sam-session.openai_stream.tool_input');
            toolCalls.push({ id: builder.id, name: builder.name, input });
          }
        }
        toolCallBuilders.clear();
      }
    }
  }

  // Finalize remaining builders (stream ended without explicit finish_reason)
  for (const [, builder] of toolCallBuilders) {
    if (builder.name) {
      const input = parseToolInput(builder.args, 'sam-session.openai_stream.remaining_tool_input');
      toolCalls.push({ id: builder.id, name: builder.name, input });
    }
  }

  return { textContent, toolCalls };
}

/** Configuration for a customized agent loop. */
export interface AgentLoopOptions {
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Tool definitions in Anthropic native format. */
  tools: AnthropicToolDef[];
  /** Custom tool executor. */
  executeTool: (toolCall: CollectedToolCall, ctx: ToolContext) => Promise<unknown>;
  /** Extra fields to merge into the ToolContext. */
  toolContextExtras?: Record<string, unknown>;
}

/**
 * Run an agent loop: call LLM, process tool calls, repeat until done.
 * Streams SSE events to the writer throughout.
 *
 * Used by both SamSession (per-user) and ProjectAgent (per-project).
 */
export async function runAgentLoop(
  conversationId: string,
  historyRows: MessageRow[],
  userMessage: string,
  config: SamConfig,
  env: Env,
  userId: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  persistMessage: (
    conversationId: string,
    role: string,
    content: string,
    toolCallsJson?: string | null,
    toolCallId?: string | null
  ) => void,
  searchMessages?: (
    query: string,
    limit: number
  ) => Array<{ snippet: string; role: string; sequence: number; createdAt: string }>,
  options?: AgentLoopOptions,
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>
): Promise<void> {
  const messages: OpenAIMessage[] = [
    ...toOpenAIMessages(historyRows),
    { role: 'user', content: userMessage },
  ];

  const systemPrompt = options?.systemPrompt ?? SAM_SYSTEM_PROMPT;
  const tools = options?.tools ?? [];
  const executeToolFn =
    options?.executeTool ?? (async () => ({ error: 'No tool executor configured' }));
  const toolCtx: ToolContext = {
    env: expectJsonRecord(env, 'sam-session.tool_context.env'),
    userId,
    searchMessages,
    ...options?.toolContextExtras,
  };
  const useAnthropicParser = isAnthropicModel(config.model);
  const tokenUsageFormat = useAnthropicParser ? ('anthropic' as const) : ('openai' as const);

  // Workers AI models have smaller context windows, so use a tighter budget
  // unless the user explicitly set SAM_MAX_REQUEST_BODY_BYTES as an override.
  const hasExplicitOverride = !!env.SAM_MAX_REQUEST_BODY_BYTES;
  const effectiveBudget =
    !hasExplicitOverride && isWorkersAIModel(config.model)
      ? DEFAULT_SAM_MAX_REQUEST_BODY_BYTES_WORKERS_AI
      : config.maxRequestBodyBytes;
  const fixedOverhead = systemPrompt.length + JSON.stringify(tools).length + 500;

  let turnCount = 0;
  let continueLoop = true;

  while (continueLoop && turnCount < config.maxTurns) {
    continueLoop = false;
    turnCount++;

    // Trim messages to fit within the request body budget
    const llmMessages = trimMessagesToFit(messages, effectiveBudget, fixedOverhead);
    if (llmMessages.length < messages.length) {
      log.info('sam.messages_trimmed', {
        original: messages.length,
        trimmed: llmMessages.length,
        estimatedBytes: estimateMessagesBytes(llmMessages),
        budgetBytes: effectiveBudget,
      });
    }

    const usageGate = await checkAiUsageGate(env.KV, userId, env);
    if (!usageGate.allowed) {
      const message =
        usageGate.reason === 'daily-token-budget'
          ? 'Daily token budget exceeded. Resets at midnight UTC.'
          : 'Monthly cost cap exceeded. Adjust your cap in Settings > Usage.';
      log.warn('sam.ai_usage_gate_denied', {
        userId,
        conversationId,
        reason: usageGate.reason,
        model: config.model,
      });
      await writer.write(encodeSseEvent({ type: 'error', message }));
      break;
    }

    let response: Response;
    try {
      response = await callLLM(
        env,
        config,
        llmMessages,
        userId,
        conversationId,
        systemPrompt,
        tools
      );
      response = await attachTokenUsageAccounting(response, {
        env,
        userId,
        format: tokenUsageFormat,
        executionCtx,
      });
    } catch (fetchErr) {
      const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      const isTimeout = errMsg.includes('abort');
      log.error('sam.llm_fetch_error', {
        model: config.model,
        error: errMsg,
        isTimeout,
      });
      await writer.write(
        encodeSseEvent({
          type: 'error',
          message: isTimeout
            ? 'AI request timed out. Please try again.'
            : 'Failed to reach AI service. Please try again.',
        })
      );
      break;
    }

    log.info('sam.llm_response', {
      status: response.status,
      hasBody: !!response.body,
      model: config.model,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.error('sam.llm_error', {
        status: response.status,
        body: errorText.slice(0, 500),
        model: config.model,
      });
      await writer.write(
        encodeSseEvent({
          type: 'error',
          message: `AI error (${response.status}). Please try again.`,
        })
      );
      break;
    }

    let textContent: string;
    let toolCalls: CollectedToolCall[];
    try {
      const result = useAnthropicParser
        ? await processAnthropicStream(response, writer)
        : await processOpenAIStream(response, writer);
      textContent = result.textContent;
      toolCalls = result.toolCalls;
    } catch (streamErr) {
      log.error('sam.stream_error', {
        model: config.model,
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      });
      await writer.write(
        encodeSseEvent({
          type: 'error',
          message: 'Error processing AI response. Please try again.',
        })
      );
      break;
    }

    // Persist assistant message
    persistMessage(
      conversationId,
      'assistant',
      textContent,
      toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
    );

    if (toolCalls.length > 0) {
      // Add assistant message with tool_calls to the conversation
      messages.push({
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });

      // Execute each tool and add results
      for (const tc of toolCalls) {
        const result = await executeToolFn(tc, toolCtx);
        const fullResultStr = JSON.stringify(result);

        // Stream and persist the FULL result; only truncate for LLM context
        await writer.write(encodeSseEvent({ type: 'tool_result', tool: tc.name, result }));
        persistMessage(conversationId, 'tool_result', fullResultStr, null, tc.id);

        const llmResultStr = truncateToolResult(fullResultStr, config.maxToolResultBytes);
        messages.push({
          role: 'tool',
          content: llmResultStr,
          tool_call_id: tc.id,
        });
      }

      continueLoop = true;
    }
  }

  if (continueLoop && turnCount >= config.maxTurns) {
    await writer.write(
      encodeSseEvent({
        type: 'error',
        message: 'Maximum tool iterations reached. Please try a simpler request.',
      })
    );
  }

  await writer.write(encodeSseEvent({ type: 'done' }));
}
