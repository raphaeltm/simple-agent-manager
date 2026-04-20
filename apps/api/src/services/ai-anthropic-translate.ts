/**
 * OpenAI ↔ Anthropic Messages format translation for the AI proxy.
 *
 * OpenCode speaks OpenAI-compatible chat format. When the resolved model is
 * an Anthropic model (claude-*), the proxy must translate to/from Anthropic's
 * Messages API format before forwarding through the AI Gateway's /anthropic path.
 */

// =============================================================================
// Types
// =============================================================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContentBlock[] };

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// =============================================================================
// Request Translation: OpenAI → Anthropic
// =============================================================================

/** Default max_tokens for Anthropic (required field). */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Translate an OpenAI chat completions request body into an Anthropic Messages API request.
 */
export function translateRequestToAnthropic(
  body: Record<string, unknown>,
  modelId: string,
): AnthropicRequest {
  const messages = body.messages as OpenAIMessage[];
  const systemMessages: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Anthropic uses a top-level `system` field, not a system message role
      const text = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as ContentPart[] | null)?.map((p) => p.text || '').join('') || '';
      if (text) systemMessages.push(text);
      continue;
    }

    if (msg.role === 'user') {
      const content = normalizeContent(msg.content);
      anthropicMessages.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      // Text content
      const text = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as ContentPart[] | null)?.map((p) => p.text || '').join('') || '';
      if (text) blocks.push({ type: 'text', text });
      // Tool calls
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: safeParseJson(tc.function.arguments),
          });
        }
      }
      if (blocks.length > 0) {
        anthropicMessages.push({ role: 'assistant', content: blocks });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results must be in a user message in Anthropic format
      const toolResultBlock: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
      // If the last message is already a user message, append to it (merge consecutive tool results)
      const lastMsg = anthropicMessages[anthropicMessages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        lastMsg.content.push(toolResultBlock);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResultBlock] });
      }
      continue;
    }
  }

  // Anthropic requires alternating user/assistant messages. Merge consecutive same-role messages.
  const merged = mergeConsecutiveMessages(anthropicMessages);

  const request: AnthropicRequest = {
    model: modelId,
    messages: merged,
    max_tokens: (body.max_tokens as number) || DEFAULT_MAX_TOKENS,
    stream: !!body.stream,
  };

  if (systemMessages.length > 0) {
    request.system = systemMessages.join('\n\n');
  }

  // Translate tools
  if (body.tools && Array.isArray(body.tools)) {
    request.tools = (body.tools as OpenAITool[]).map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
  }

  if (body.temperature != null) request.temperature = body.temperature as number;
  if (body.top_p != null) request.top_p = body.top_p as number;
  if (body.stop && Array.isArray(body.stop)) request.stop_sequences = body.stop as string[];

  return request;
}

// =============================================================================
// Response Translation: Anthropic → OpenAI (non-streaming)
// =============================================================================

/**
 * Translate an Anthropic Messages API response into OpenAI chat completions format.
 */
export function translateResponseToOpenAI(response: AnthropicResponse): Record<string, unknown> {
  const toolCalls: OpenAIToolCall[] = [];
  const textParts: string[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.join('') || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${response.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(response.stop_reason),
    }],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

// =============================================================================
// Streaming Translation: Anthropic SSE → OpenAI SSE
// =============================================================================

/**
 * Create a TransformStream that converts Anthropic streaming events into
 * OpenAI-compatible SSE delta format.
 */
export function createAnthropicToOpenAIStream(model: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentToolCallIndex = 0;
  let messageId = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      // Keep incomplete last line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          continue;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        const openAIDelta = translateStreamEvent(event, model, messageId, currentToolCallIndex);
        if (openAIDelta) {
          if (openAIDelta.messageId) messageId = openAIDelta.messageId;
          if (openAIDelta.toolCallIndex !== undefined) currentToolCallIndex = openAIDelta.toolCallIndex;
          if (openAIDelta.chunk) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIDelta.chunk)}\n\n`));
          }
        }
      }
    },
    flush(controller) {
      // Send final [DONE] if not already sent
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });
}

// =============================================================================
// Helpers
// =============================================================================

function normalizeContent(content: string | ContentPart[] | null): AnthropicContentBlock[] {
  if (!content) return [{ type: 'text', text: '' }];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => ({ type: 'text' as const, text: p.text! }));
}

function mergeConsecutiveMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content.push(...msg.content);
    } else {
      merged.push({ ...msg, content: [...msg.content] });
    }
  }
  return merged;
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case 'end_turn': return 'stop';
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'stop_sequence': return 'stop';
    default: return 'stop';
  }
}

interface StreamDelta {
  chunk?: Record<string, unknown>;
  messageId?: string;
  toolCallIndex?: number;
}

function translateStreamEvent(
  event: Record<string, unknown>,
  model: string,
  messageId: string,
  toolCallIndex: number,
): StreamDelta | null {
  const type = event.type as string;

  switch (type) {
    case 'message_start': {
      const msg = event.message as Record<string, unknown> | undefined;
      const id = (msg?.id as string) || `chatcmpl-${Date.now()}`;
      return {
        messageId: id,
        chunk: {
          id: `chatcmpl-${id}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          }],
        },
      };
    }

    case 'content_block_start': {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use') {
        const newIndex = toolCallIndex;
        return {
          toolCallIndex: newIndex + 1,
          chunk: {
            id: `chatcmpl-${messageId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: newIndex,
                  id: block.id as string,
                  type: 'function',
                  function: { name: block.name as string, arguments: '' },
                }],
              },
              finish_reason: null,
            }],
          },
        };
      }
      return null;
    }

    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return null;

      if (delta.type === 'text_delta') {
        return {
          chunk: {
            id: `chatcmpl-${messageId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: delta.text as string },
              finish_reason: null,
            }],
          },
        };
      }

      if (delta.type === 'input_json_delta') {
        return {
          chunk: {
            id: `chatcmpl-${messageId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolCallIndex - 1,
                  function: { arguments: delta.partial_json as string },
                }],
              },
              finish_reason: null,
            }],
          },
        };
      }

      return null;
    }

    case 'message_delta': {
      const delta = event.delta as Record<string, unknown> | undefined;
      const stopReason = delta?.stop_reason as string | null;
      return {
        chunk: {
          id: `chatcmpl-${messageId}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: mapStopReason(stopReason),
          }],
          usage: event.usage as Record<string, unknown> | undefined,
        },
      };
    }

    default:
      return null;
  }
}
