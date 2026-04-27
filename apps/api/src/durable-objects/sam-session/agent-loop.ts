/**
 * SAM agent loop — calls LLM via AI Gateway, processes streaming response,
 * executes tools, and streams SSE events to the browser.
 *
 * Supports two backends:
 * - Anthropic (claude-* models): native Anthropic Messages API
 * - Workers AI (@cf/* models): OpenAI-compatible chat completions API
 */
import {
  SAM_ANTHROPIC_VERSION,
  type SamConfig,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { getPlatformAgentCredential } from '../../services/platform-credentials';
import { executeTool, SAM_TOOLS } from './tools';
import type {
  AnthropicContentBlock,
  AnthropicToolDef,
  AnthropicToolResultBlock,
  CollectedToolCall,
  MessageRow,
  SamSseEvent,
  ToolContext,
} from './types';

const SAM_SYSTEM_PROMPT = `You are SAM — Simple Agent Manager. You are a senior engineering manager who orchestrates AI coding agents across multiple projects.

You have access to all of the user's projects, tasks, missions, and agents. You can dispatch work, check progress, coordinate multi-project efforts, and answer questions about what's happening across their engineering organization.

## Your personality
- Direct and concise — you're a busy manager, not a chatbot
- You proactively surface problems (stalled tasks, CI failures, blocked agents)
- You confirm before taking destructive or expensive actions (dispatching tasks, canceling missions)
- You think in terms of dependencies and priorities, not just individual tasks

## How you work
- When asked about status, check the real data — don't guess
- When asked to do something, use the available tools
- When multiple projects are involved, think about dependencies and sequencing
- When an agent is stuck, check its messages and suggest interventions

## What you don't do
- You don't write code yourself — you delegate to agents who do
- You don't make up project status — you check with tools
- You don't take action without confirming — dispatch, cancel, and policy changes are confirmed first`;

/** Encode an SSE event as unnamed data frame. */
function encodeSseEvent(event: SamSseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

// =============================================================================
// Model detection
// =============================================================================

/** Check if a model ID is a Workers AI model (uses OpenAI-compatible API). */
function isWorkersAIModel(model: string): boolean {
  return model.startsWith('@cf/') || model.startsWith('@hf/');
}

// =============================================================================
// Workers AI backend (OpenAI-compatible format)
// =============================================================================

/** Build AI Gateway URL for Workers AI (OpenAI-compatible). */
function buildWorkersAIUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

/** Convert Anthropic tool definitions to OpenAI function-calling format. */
function toOpenAITools(tools: AnthropicToolDef[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** OpenAI-format message type used for Workers AI calls. */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Convert stored message rows to OpenAI messages format. */
function toOpenAIMessages(rows: MessageRow[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  for (const row of rows) {
    if (row.role === 'user') {
      messages.push({ role: 'user', content: row.content });
    } else if (row.role === 'assistant') {
      const msg: OpenAIMessage = { role: 'assistant', content: row.content || null };
      if (row.tool_calls_json) {
        try {
          const toolCalls = JSON.parse(row.tool_calls_json) as CollectedToolCall[];
          msg.tool_calls = toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
          // OpenAI format: if there are tool_calls, content should be null when empty
          if (!msg.content) msg.content = null;
        } catch { /* ignore parse errors */ }
      }
      messages.push(msg);
    } else if (row.role === 'tool_result') {
      messages.push({
        role: 'tool',
        content: row.content,
        tool_call_id: row.tool_call_id || '',
      });
    }
  }

  return messages;
}

/** Call Workers AI via AI Gateway with OpenAI-compatible streaming. */
async function callWorkersAI(
  env: Env,
  config: SamConfig,
  messages: OpenAIMessage[],
  userId: string,
  conversationId: string,
): Promise<Response> {
  const url = buildWorkersAIUrl(env);
  const systemPrompt = config.systemPromptAppend
    ? `${SAM_SYSTEM_PROMPT}\n\n${config.systemPromptAppend}`
    : SAM_SYSTEM_PROMPT;

  const allMessages: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: allMessages,
    stream: true,
  };

  // Add tools if available — Workers AI models may or may not support them
  const openAITools = toOpenAITools(SAM_TOOLS);
  if (openAITools.length > 0) {
    body.tools = openAITools;
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-metadata': JSON.stringify({
        source: config.aigSource,
        userId,
        conversationId,
      }),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Process Workers AI streaming response (OpenAI SSE format).
 * Writes SSE events to the writer and collects tool calls.
 */
async function processWorkersAIStream(
  response: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<{ textContent: string; toolCalls: CollectedToolCall[] }> {
  if (!response.body) {
    throw new Error('No response body from Workers AI');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';
  const toolCalls: CollectedToolCall[] = [];

  // Track tool calls being built from deltas
  const toolCallBuilders = new Map<number, { id: string; name: string; args: string }>();

  let streamDone = false;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) { streamDone = true; break; }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      // OpenAI streaming format: choices[0].delta
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const firstChoice = choices?.[0];
      if (!firstChoice) continue;

      const delta = firstChoice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Text content
      if (delta.content && typeof delta.content === 'string') {
        textContent += delta.content;
        await writer.write(encodeSseEvent({ type: 'text_delta', content: delta.content }));
      }

      // Tool calls (OpenAI streaming format)
      const deltaToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (deltaToolCalls) {
        for (const dtc of deltaToolCalls) {
          const index = (dtc.index as number) ?? 0;
          const fn = dtc.function as Record<string, unknown> | undefined;

          if (!toolCallBuilders.has(index)) {
            // New tool call starting
            const id = (dtc.id as string) || `call_${crypto.randomUUID().slice(0, 8)}`;
            const name = fn?.name as string || '';
            toolCallBuilders.set(index, { id, name, args: '' });
            if (name) {
              await writer.write(encodeSseEvent({ type: 'tool_start', tool: name, input: {} }));
            }
          }

          const builder = toolCallBuilders.get(index)!;
          if (fn?.name && typeof fn.name === 'string' && !builder.name) {
            builder.name = fn.name;
            await writer.write(encodeSseEvent({ type: 'tool_start', tool: builder.name, input: {} }));
          }
          if (fn?.arguments && typeof fn.arguments === 'string') {
            builder.args += fn.arguments;
          }
        }
      }

      // Check for finish_reason to finalize tool calls
      const finishReason = firstChoice.finish_reason as string | undefined;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        for (const [, builder] of toolCallBuilders) {
          if (builder.name) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(builder.args) as Record<string, unknown>;
            } catch { /* empty input */ }
            toolCalls.push({ id: builder.id, name: builder.name, input });
          }
        }
        toolCallBuilders.clear();
      }
    }
  }

  // Finalize any remaining tool calls that weren't closed by finish_reason
  for (const [, builder] of toolCallBuilders) {
    if (builder.name) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(builder.args) as Record<string, unknown>;
      } catch { /* empty input */ }
      toolCalls.push({ id: builder.id, name: builder.name, input });
    }
  }

  return { textContent, toolCalls };
}

// =============================================================================
// Anthropic backend (native Anthropic Messages API)
// =============================================================================

/** Build AI Gateway URL for Anthropic Messages API. */
function buildAnthropicUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages`;
  }
  return 'https://api.anthropic.com/v1/messages';
}

/** Get platform Anthropic API key. */
async function getAnthropicApiKey(env: Env): Promise<string> {
  const { drizzle } = await import('drizzle-orm/d1');
  const db = drizzle(env.DATABASE);
  const encryptionKey = getCredentialEncryptionKey(env);
  const cred = await getPlatformAgentCredential(db, 'claude-code', encryptionKey);
  if (!cred?.credential) {
    throw new Error('No Anthropic API key configured. An admin must add a Claude Code platform credential.');
  }
  return cred.credential;
}

/** Convert stored message rows to Anthropic messages format. */
function toAnthropicMessages(
  rows: MessageRow[],
): Array<{ role: string; content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[] }> {
  const messages: Array<{ role: string; content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[] }> = [];

  for (const row of rows) {
    if (row.role === 'user') {
      messages.push({ role: 'user', content: row.content });
    } else if (row.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (row.content) {
        content.push({ type: 'text', text: row.content });
      }
      if (row.tool_calls_json) {
        try {
          const toolCalls = JSON.parse(row.tool_calls_json) as CollectedToolCall[];
          for (const tc of toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
          }
        } catch { /* ignore parse errors */ }
      }
      messages.push({ role: 'assistant', content });
    } else if (row.role === 'tool_result') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: row.tool_call_id || '',
          content: row.content,
        }],
      });
    }
  }

  return messages;
}

/** Call Anthropic Messages API via AI Gateway with streaming. */
async function callAnthropic(
  env: Env,
  config: SamConfig,
  messages: Array<{ role: string; content: unknown }>,
  userId: string,
  conversationId: string,
): Promise<Response> {
  const apiKey = await getAnthropicApiKey(env);
  const url = buildAnthropicUrl(env);

  const systemPrompt = config.systemPromptAppend
    ? `${SAM_SYSTEM_PROMPT}\n\n${config.systemPromptAppend}`
    : SAM_SYSTEM_PROMPT;

  return fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': SAM_ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'cf-aig-metadata': JSON.stringify({
        source: config.aigSource,
        userId,
        conversationId,
      }),
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt,
      messages,
      tools: SAM_TOOLS,
      stream: true,
    }),
  });
}

/**
 * Process the Anthropic streaming response.
 * Writes SSE events to the writer and collects tool calls.
 * Returns the accumulated text and tool calls.
 */
async function processAnthropicStream(
  response: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<{ textContent: string; toolCalls: CollectedToolCall[] }> {
  if (!response.body) {
    throw new Error('No response body from Anthropic');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';
  const toolCalls: CollectedToolCall[] = [];

  // Track current tool call being built
  let currentToolId = '';
  let currentToolName = '';
  let currentToolInputJson = '';

  let streamDone = false;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) { streamDone = true; break; }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = event.type as string;

      if (eventType === 'content_block_start') {
        const block = event.content_block as Record<string, unknown>;
        if (block?.type === 'tool_use') {
          currentToolId = block.id as string;
          currentToolName = block.name as string;
          currentToolInputJson = '';
          await writer.write(encodeSseEvent({
            type: 'tool_start',
            tool: currentToolName,
            input: {},
          }));
        }
      } else if (eventType === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>;
        if (delta?.type === 'text_delta') {
          const text = delta.text as string;
          textContent += text;
          await writer.write(encodeSseEvent({ type: 'text_delta', content: text }));
        } else if (delta?.type === 'input_json_delta') {
          currentToolInputJson += delta.partial_json as string;
        }
      } else if (eventType === 'content_block_stop') {
        if (currentToolId) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(currentToolInputJson) as Record<string, unknown>;
          } catch { /* empty input */ }
          toolCalls.push({ id: currentToolId, name: currentToolName, input });
          currentToolId = '';
          currentToolName = '';
          currentToolInputJson = '';
        }
      } else if (eventType === 'error') {
        const errorObj = event.error as Record<string, unknown>;
        const message = (errorObj?.message as string) || 'Anthropic API error';
        await writer.write(encodeSseEvent({ type: 'error', message }));
      }
    }
  }

  return { textContent, toolCalls };
}

// =============================================================================
// Unified agent loop
// =============================================================================

/**
 * Run the SAM agent loop: call LLM, process tool calls, repeat until done.
 * Streams SSE events to the writer throughout.
 *
 * Dispatches to Workers AI or Anthropic based on the configured model.
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
    toolCallId?: string | null,
  ) => void,
): Promise<void> {
  const useWorkersAI = isWorkersAIModel(config.model);

  if (useWorkersAI) {
    await runWorkersAILoop(conversationId, historyRows, userMessage, config, env, userId, writer, persistMessage);
  } else {
    await runAnthropicLoop(conversationId, historyRows, userMessage, config, env, userId, writer, persistMessage);
  }
}

/** Agent loop using Workers AI (OpenAI-compatible format). */
async function runWorkersAILoop(
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
    toolCallId?: string | null,
  ) => void,
): Promise<void> {
  const messages: OpenAIMessage[] = [
    ...toOpenAIMessages(historyRows),
    { role: 'user', content: userMessage },
  ];

  const toolCtx: ToolContext = { env: env as unknown as Record<string, unknown>, userId };

  let turnCount = 0;
  let continueLoop = true;

  while (continueLoop && turnCount < config.maxTurns) {
    continueLoop = false;
    turnCount++;

    const response = await callWorkersAI(env, config, messages, userId, conversationId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.error('sam.workers_ai_error', { status: response.status, body: errorText.slice(0, 500), model: config.model });
      await writer.write(encodeSseEvent({
        type: 'error',
        message: `AI inference error (${response.status}). Please try again.`,
      }));
      break;
    }

    const { textContent, toolCalls } = await processWorkersAIStream(response, writer);

    // Persist assistant message
    persistMessage(
      conversationId,
      'assistant',
      textContent,
      toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    );

    // If tool calls, execute and continue
    if (toolCalls.length > 0) {
      // Add assistant message with tool_calls to conversation
      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      };
      messages.push(assistantMsg);

      // Execute each tool and add results
      for (const tc of toolCalls) {
        const result = await executeTool(tc, toolCtx);
        const resultStr = JSON.stringify(result);

        await writer.write(encodeSseEvent({ type: 'tool_result', tool: tc.name, result }));

        // Persist tool result
        persistMessage(conversationId, 'tool_result', resultStr, null, tc.id);

        // Add tool result in OpenAI format
        messages.push({
          role: 'tool',
          content: resultStr,
          tool_call_id: tc.id,
        });
      }

      continueLoop = true;
    }
  }

  if (continueLoop && turnCount >= config.maxTurns) {
    await writer.write(encodeSseEvent({
      type: 'error',
      message: 'Maximum tool iterations reached. Please try a simpler request.',
    }));
  }

  await writer.write(encodeSseEvent({ type: 'done' }));
}

/** Agent loop using Anthropic (native Anthropic Messages API). */
async function runAnthropicLoop(
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
    toolCallId?: string | null,
  ) => void,
): Promise<void> {
  // Build messages from history + new user message
  const messages: Array<{ role: string; content: unknown }> = [
    ...toAnthropicMessages(historyRows),
    { role: 'user', content: userMessage },
  ];

  const toolCtx: ToolContext = { env: env as unknown as Record<string, unknown>, userId };

  let turnCount = 0;
  let continueLoop = true;

  while (continueLoop && turnCount < config.maxTurns) {
    continueLoop = false;
    turnCount++;

    const response = await callAnthropic(env, config, messages, userId, conversationId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.error('sam.anthropic_error', { status: response.status, body: errorText.slice(0, 500) });
      await writer.write(encodeSseEvent({
        type: 'error',
        message: `Claude API error (${response.status}). Please try again.`,
      }));
      break;
    }

    const { textContent, toolCalls } = await processAnthropicStream(response, writer);

    // Persist assistant message
    persistMessage(
      conversationId,
      'assistant',
      textContent,
      toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    );

    // If tool calls, execute and continue
    if (toolCalls.length > 0) {
      // Build the assistant content block for the messages array
      const assistantContent: AnthropicContentBlock[] = [];
      if (textContent) {
        assistantContent.push({ type: 'text', text: textContent });
      }
      for (const tc of toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      // Execute each tool and build tool results
      const toolResults: AnthropicToolResultBlock[] = [];
      for (const tc of toolCalls) {
        const result = await executeTool(tc, toolCtx);
        const resultStr = JSON.stringify(result);

        await writer.write(encodeSseEvent({ type: 'tool_result', tool: tc.name, result }));

        // Persist tool result
        persistMessage(conversationId, 'tool_result', resultStr, null, tc.id);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: resultStr,
        });
      }

      // Add tool results as a user message for next turn
      messages.push({ role: 'user', content: toolResults });
      continueLoop = true;
    }
  }

  if (continueLoop && turnCount >= config.maxTurns) {
    await writer.write(encodeSseEvent({
      type: 'error',
      message: 'Maximum tool iterations reached. Please try a simpler request.',
    }));
  }

  await writer.write(encodeSseEvent({ type: 'done' }));
}
