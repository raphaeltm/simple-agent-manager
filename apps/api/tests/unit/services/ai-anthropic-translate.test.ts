/**
 * Unit tests for the OpenAI ↔ Anthropic format translation layer.
 */
import { describe, expect, it } from 'vitest';

import {
  translateRequestToAnthropic,
  translateResponseToOpenAI,
} from '../../../src/services/ai-anthropic-translate';

describe('translateRequestToAnthropic', () => {
  it('translates a simple user message', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.max_tokens).toBe(4096);
  });

  it('extracts system messages to top-level system field', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    expect(result.system).toBe('You are helpful.');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });

  it('joins multiple system messages', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [
        { role: 'system', content: 'Rule 1' },
        { role: 'system', content: 'Rule 2' },
        { role: 'user', content: 'Hi' },
      ],
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    expect(result.system).toBe('Rule 1\n\nRule 2');
  });

  it('translates assistant messages with tool calls', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [
        { role: 'user', content: 'What time is it?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_time', arguments: '{}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: '14:30 UTC',
        },
      ],
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    // Assistant message with text + tool_use
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content).toHaveLength(2);
    expect(result.messages[1].content[0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(result.messages[1].content[1]).toEqual({
      type: 'tool_use',
      id: 'call_123',
      name: 'get_time',
      input: {},
    });

    // Tool result in a user message
    expect(result.messages[2].role).toBe('user');
    expect(result.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_123',
      content: '14:30 UTC',
    });
  });

  it('translates OpenAI tools to Anthropic tools format', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    expect(result.tools).toHaveLength(1);
    expect(result.tools![0]).toEqual({
      name: 'get_weather',
      description: 'Get the weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    });
  });

  it('passes through temperature and top_p', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      top_p: 0.9,
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
  });

  it('uses max_tokens from request body', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    expect(result.max_tokens).toBe(1024);
  });

  it('merges consecutive same-role messages', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'Are you there?' },
      ],
    };

    const result = translateRequestToAnthropic(body, 'claude-haiku-4-5-20251001');

    // Should be merged into one user message
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toHaveLength(2);
  });
});

describe('translateResponseToOpenAI', () => {
  it('translates a simple text response', () => {
    const response = {
      id: 'msg_123',
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Hello!' }],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = translateResponseToOpenAI(response);

    expect(result.id).toBe('chatcmpl-msg_123');
    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe('stop');
    const message = choices[0].message as Record<string, unknown>;
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('Hello!');
    const usage = result.usage as Record<string, unknown>;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });

  it('translates tool_use blocks into tool_calls', () => {
    const response = {
      id: 'msg_456',
      type: 'message' as const,
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'Let me check.' },
        {
          type: 'tool_use' as const,
          id: 'toolu_123',
          name: 'get_time',
          input: { timezone: 'UTC' },
        },
      ],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 15 },
    };

    const result = translateResponseToOpenAI(response);

    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe('tool_calls');
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBe('Let me check.');
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('toolu_123');
    expect(toolCalls[0].type).toBe('function');
    const fn = toolCalls[0].function as Record<string, unknown>;
    expect(fn.name).toBe('get_time');
    expect(fn.arguments).toBe('{"timezone":"UTC"}');
  });

  it('maps max_tokens stop reason to length', () => {
    const response = {
      id: 'msg_789',
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Truncated...' }],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 4096 },
    };

    const result = translateResponseToOpenAI(response);

    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe('length');
  });
});
