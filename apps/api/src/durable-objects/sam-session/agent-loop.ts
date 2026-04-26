/**
 * SAM agent loop — calls Claude via AI Gateway, processes streaming response,
 * executes tools, and streams SSE events to the browser.
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

/**
 * Run the SAM agent loop: call Claude, process tool calls, repeat until done.
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

  if (turnCount >= config.maxTurns) {
    await writer.write(encodeSseEvent({
      type: 'error',
      message: 'Maximum tool iterations reached. Please try a simpler request.',
    }));
  }

  await writer.write(encodeSseEvent({ type: 'done' }));
}
