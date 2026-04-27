/**
 * SAM agent loop — single OpenAI-format code path routed through AI Gateway.
 *
 * Internally always uses OpenAI chat-completions format. The AI Gateway
 * endpoint is selected by model prefix:
 *   - @cf/* or @hf/*  → Workers AI  (OpenAI-native)
 *   - claude-*         → Anthropic   (translated at the boundary via ai-anthropic-translate)
 *
 * This means swapping models/providers is a config change (SAM_MODEL env var),
 * not a code change.
 */
import {
  SAM_ANTHROPIC_VERSION,
  type SamConfig,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import {
  createAnthropicToOpenAIStream,
  translateRequestToAnthropic,
} from '../../services/ai-anthropic-translate';
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
- You don't take action without confirming — dispatch, cancel, and policy changes are confirmed first`;

// =============================================================================
// SSE encoding
// =============================================================================

function encodeSseEvent(event: SamSseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

// =============================================================================
// Model detection & routing
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
// Format converters (stored rows ↔ OpenAI, Anthropic tool defs → OpenAI)
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
// Unified LLM call — always OpenAI format in, OpenAI SSE out
// =============================================================================

/**
 * Call the LLM via AI Gateway. Always accepts and returns OpenAI format.
 *
 * For Workers AI models: direct pass-through (already OpenAI-native).
 * For Anthropic models: translates request to Anthropic format, pipes
 * the response through createAnthropicToOpenAIStream to get OpenAI SSE back.
 */
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

  const aigMetadata = JSON.stringify({
    source: config.aigSource,
    userId,
    conversationId,
  });

  // Build the canonical OpenAI request body
  const openAIBody: Record<string, unknown> = {
    model,
    max_tokens: config.maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    stream: true,
  };

  const tools = toOpenAITools(SAM_TOOLS);
  if (tools.length > 0) {
    openAIBody.tools = tools;
  }

  if (isAnthropicModel(model)) {
    // Translate OpenAI → Anthropic at the boundary
    const anthropicRequest = translateRequestToAnthropic(openAIBody, model);
    const url = buildAnthropicGatewayUrl(env);
    const apiKey = await getAnthropicApiKey(env);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': SAM_ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
        'cf-aig-metadata': aigMetadata,
      },
      body: JSON.stringify(anthropicRequest),
    });

    if (!response.ok || !response.body) {
      return response;
    }

    // Pipe Anthropic SSE → OpenAI SSE so the stream parser only needs one format
    const translatedStream = response.body.pipeThrough(createAnthropicToOpenAIStream(model));
    return new Response(translatedStream, {
      status: response.status,
      headers: response.headers,
    });
  }

  // Workers AI (or any OpenAI-compatible provider) — direct pass-through
  const url = isWorkersAIModel(model)
    ? buildWorkersAIGatewayUrl(env)
    : buildWorkersAIGatewayUrl(env); // fallback to Workers AI gateway for unknown models

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
    },
    body: JSON.stringify(openAIBody),
  });
}

// =============================================================================
// OpenAI SSE stream parser
// =============================================================================

/**
 * Process an OpenAI-format SSE stream.
 * Writes SAM SSE events to the writer and collects tool calls.
 */
async function processStream(
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

  // Track tool calls being built from streaming deltas
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

  // Finalize any remaining builders (stream ended without explicit finish_reason)
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

    const response = await callLLM(env, config, messages, userId, conversationId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.error('sam.llm_error', { status: response.status, body: errorText.slice(0, 500), model: config.model });
      await writer.write(encodeSseEvent({
        type: 'error',
        message: `AI error (${response.status}). Please try again.`,
      }));
      break;
    }

    const { textContent, toolCalls } = await processStream(response, writer);

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
