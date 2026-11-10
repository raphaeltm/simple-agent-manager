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
import { DEFAULT_SAM_MAX_REQUEST_BODY_BYTES_WORKERS_AI, type SamConfig } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { checkAiUsageGate } from '../../services/ai-token-budget';
import { attachTokenUsageAccounting } from '../../services/ai-token-usage-accounting';
import { LlmUnavailableError, resolveOpenAICompatibleTarget } from '../../services/llm-chat-target';
import {
  encodeSseEvent,
  isAnthropicModel,
  isWorkersAIModel,
  parseToolInput,
  SAM_SYSTEM_PROMPT,
  toOpenAIMessages,
} from './agent-loop-helpers';
import { callLLM } from './agent-loop-llm';
import type { OpenAIMessage } from './payload-size';
import { estimateMessagesBytes, trimMessagesToFit, truncateToolResult } from './payload-size';
import type { AnthropicToolDef, CollectedToolCall, MessageRow, ToolContext } from './types';

export { SAM_SYSTEM_PROMPT };

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
  baseConfig: SamConfig,
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
  // An admin-configured OpenAI-compatible endpoint replaces the model route for SAM and project
  // agents (services/llm-chat-target.ts); without one the configured model routes as before.
  let endpoint;
  try {
    endpoint = await resolveOpenAICompatibleTarget(env, 'agent', baseConfig.model);
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) throw err;
    await writer.write(encodeSseEvent({ type: 'error', message: err.message }));
    await writer.write(encodeSseEvent({ type: 'done' }));
    return;
  }
  const config: SamConfig = endpoint ? { ...baseConfig, model: endpoint.model } : baseConfig;
  const tools = options?.tools ?? [];
  const executeToolFn =
    options?.executeTool ?? (async () => ({ error: 'No tool executor configured' }));
  const toolCtx: ToolContext = {
    env: expectJsonRecord(env, 'sam-session.tool_context.env'),
    userId,
    searchMessages,
    ...options?.toolContextExtras,
  };
  const useAnthropicParser = !endpoint && isAnthropicModel(config.model);
  const tokenUsageFormat = useAnthropicParser ? ('anthropic' as const) : ('openai' as const);

  // Workers AI models have smaller context windows, so use a tighter budget
  // unless the user explicitly set SAM_MAX_REQUEST_BODY_BYTES as an override.
  const hasExplicitOverride = !!env.SAM_MAX_REQUEST_BODY_BYTES;
  const effectiveBudget =
    !hasExplicitOverride && (endpoint !== null || isWorkersAIModel(config.model))
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
        tools,
        endpoint
      );
      response = await attachTokenUsageAccounting(response, {
        env,
        userId,
        format: tokenUsageFormat,
        executionCtx,
      });
    } catch (fetchErr) {
      // No model on this installation (no endpoint configured, no Cloudflare route): retrying
      // cannot help, so say what an admin must do instead of reporting a transient failure.
      if (fetchErr instanceof LlmUnavailableError) {
        log.warn('sam.llm_unavailable', { model: config.model });
        await writer.write(encodeSseEvent({ type: 'error', message: fetchErr.message }));
        break;
      }
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
