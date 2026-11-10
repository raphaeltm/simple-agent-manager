/**
 * Model stream parsers for the agent loop, split out of agent-loop.ts (rule 18): each turns one
 * upstream SSE stream into SAM SSE events on the writer and collects the turn's tool calls.
 */
import { expectJsonRecord } from '../../lib/runtime-validation';
import { encodeSseEvent, parseToolInput } from './agent-loop-helpers';
import type { CollectedToolCall } from './types';

/**
 * Process an Anthropic SSE stream (native Anthropic event format).
 * Writes SAM SSE events to the writer and collects tool calls.
 */
export async function processAnthropicStream(
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
export async function processOpenAIStream(
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
