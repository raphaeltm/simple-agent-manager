/**
 * SAM agent loop — unified OpenAI-format code path routed through AI Gateway.
 *
 * Internally uses OpenAI chat-completions format. The AI Gateway endpoint is
 * selected by model prefix:
 *   - @cf/* or @hf/*  → Workers AI  (OpenAI-native)
 *   - claude-*         → Anthropic   (translated at the boundary)
 *
 * Swapping models/providers is a config change (SAM_MODEL env var), not a code change.
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
  AnthropicToolDef,
  CollectedToolCall,
  MessageRow,
  SamSseEvent,
  ToolContext,
} from './types';

// =============================================================================
// System prompt
// =============================================================================

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
- You don't take action without confirming — dispatch, cancel, and policy changes are confirmed first

## Conversation memory
- Your conversation with the user persists across page refreshes
- If the user references something from earlier that is not in your current context, use the search_conversation_history tool to find it
- This is especially useful for recalling past decisions, preferences, or discussions`;

// =============================================================================
// SSE encoding
// =============================================================================

function encodeSseEvent(event: SamSseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

// =============================================================================
// Model detection
// =============================================================================

function isAnthropicModel(model: string): boolean {
  return model.startsWith('claude-');
}

function isWorkersAIModel(model: string): boolean {
  return model.startsWith('@cf/') || model.startsWith('@hf/');
}

// =============================================================================
// OpenAI message types (canonical internal format)
// =============================================================================

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

interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

// =============================================================================
// Format converters
// =============================================================================

/** Convert Anthropic-format tool definitions to OpenAI function-calling format. */
function toOpenAITools(tools: AnthropicToolDef[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** Convert stored message rows to OpenAI messages. */
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

// =============================================================================
// Gateway URL builders
// =============================================================================

function buildWorkersAIGatewayUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

function buildAnthropicGatewayUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages`;
  }
  return 'https://api.anthropic.com/v1/messages';
}

// =============================================================================
// Credential helpers
// =============================================================================

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

// =============================================================================
// LLM call — routes to Workers AI or Anthropic based on model prefix
// =============================================================================

/** Default fetch timeout for LLM calls (configurable via SAM_LLM_TIMEOUT_MS). */
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

async function callLLM(
  env: Env,
  config: SamConfig,
  messages: OpenAIMessage[],
  userId: string,
  conversationId: string,
): Promise<Response> {
  const model = config.model;
  const systemPrompt = config.systemPromptAppend
    ? `${SAM_SYSTEM_PROMPT}\n\n${config.systemPromptAppend}`
    : SAM_SYSTEM_PROMPT;

  const openAITools = toOpenAITools(SAM_TOOLS);
  const aigMetadata = JSON.stringify({
    source: config.aigSource,
    userId,
    conversationId,
  });

  // Timeout to prevent hanging fetches inside DOs
  const timeoutMs = parseInt(String((env as unknown as Record<string, string>).SAM_LLM_TIMEOUT_MS) || '', 10) || DEFAULT_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (isAnthropicModel(model)) {
      return await callAnthropicLLM(env, model, systemPrompt, messages, openAITools, aigMetadata, config.maxTokens, controller.signal);
    } else if (isWorkersAIModel(model)) {
      return await callWorkersAILLM(env, model, systemPrompt, messages, openAITools, aigMetadata, config.maxTokens, controller.signal);
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
            try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
        }
        return { role: 'assistant' as const, content };
      } else if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: m.content || '' }],
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
      tools: SAM_TOOLS,
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
  signal: AbortSignal,
): Promise<Response> {
  const url = buildWorkersAIGatewayUrl(env);

  const fullMessages: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  return fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
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

// =============================================================================
// Stream parsers
// =============================================================================

/**
 * Process an Anthropic SSE stream (native Anthropic event format).
 * Writes SAM SSE events to the writer and collects tool calls.
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

/**
 * Process an OpenAI-format SSE stream (Workers AI / OpenAI-compatible).
 * Writes SAM SSE events to the writer and collects tool calls.
 */
async function processOpenAIStream(
  response: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
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

      // Tool calls (streamed as deltas with index)
      const deltaToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (deltaToolCalls) {
        for (const dtc of deltaToolCalls) {
          const index = (dtc.index as number) ?? 0;
          const fn = dtc.function as Record<string, unknown> | undefined;

          if (!toolCallBuilders.has(index)) {
            const id = (dtc.id as string) || `call_${crypto.randomUUID().slice(0, 8)}`;
            const name = (fn?.name as string) || '';
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

      // Finalize tool calls on finish_reason
      const finishReason = firstChoice.finish_reason as string | undefined;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        for (const [, builder] of toolCallBuilders) {
          if (builder.name) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(builder.args) as Record<string, unknown>; } catch { /* empty */ }
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
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(builder.args) as Record<string, unknown>; } catch { /* empty */ }
      toolCalls.push({ id: builder.id, name: builder.name, input });
    }
  }

  return { textContent, toolCalls };
}

// =============================================================================
// Agent loop
// =============================================================================

/**
 * Run the SAM agent loop: call LLM, process tool calls, repeat until done.
 * Streams SSE events to the writer throughout.
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
  searchMessages?: (query: string, limit: number) => Array<{ snippet: string; role: string; sequence: number; createdAt: string }>,
): Promise<void> {
  const messages: OpenAIMessage[] = [
    ...toOpenAIMessages(historyRows),
    { role: 'user', content: userMessage },
  ];

  const toolCtx: ToolContext = { env: env as unknown as Record<string, unknown>, userId, searchMessages };
  const useAnthropicParser = isAnthropicModel(config.model);

  let turnCount = 0;
  let continueLoop = true;

  while (continueLoop && turnCount < config.maxTurns) {
    continueLoop = false;
    turnCount++;

    let response: Response;
    try {
      response = await callLLM(env, config, messages, userId, conversationId);
    } catch (fetchErr) {
      const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      const isTimeout = errMsg.includes('abort');
      log.error('sam.llm_fetch_error', {
        model: config.model,
        error: errMsg,
        isTimeout,
      });
      await writer.write(encodeSseEvent({
        type: 'error',
        message: isTimeout
          ? 'AI request timed out. Please try again.'
          : 'Failed to reach AI service. Please try again.',
      }));
      break;
    }

    log.info('sam.llm_response', { status: response.status, hasBody: !!response.body, model: config.model });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.error('sam.llm_error', { status: response.status, body: errorText.slice(0, 500), model: config.model });
      await writer.write(encodeSseEvent({
        type: 'error',
        message: `AI error (${response.status}). Please try again.`,
      }));
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
      await writer.write(encodeSseEvent({
        type: 'error',
        message: 'Error processing AI response. Please try again.',
      }));
      break;
    }

    // Persist assistant message
    persistMessage(
      conversationId,
      'assistant',
      textContent,
      toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
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
        const result = await executeTool(tc, toolCtx);
        const resultStr = JSON.stringify(result);

        await writer.write(encodeSseEvent({ type: 'tool_result', tool: tc.name, result }));
        persistMessage(conversationId, 'tool_result', resultStr, null, tc.id);

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
