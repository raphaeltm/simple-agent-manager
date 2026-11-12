import { describe, expect, it } from 'vitest';

import {
  collectStreamTokenUsage,
  estimateInputTokensFromMessages,
  extractJsonTokenUsage,
} from '../../../src/services/ai-token-usage-accounting';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('ai token usage accounting helpers', () => {
  it('extracts OpenAI non-streaming usage', () => {
    expect(extractJsonTokenUsage({
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }, 'openai')).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it('extracts Anthropic non-streaming usage', () => {
    expect(extractJsonTokenUsage({
      usage: { input_tokens: 20, output_tokens: 9 },
    }, 'anthropic')).toEqual({ inputTokens: 20, outputTokens: 9 });
  });

  it('collects OpenAI streaming usage from the final SSE chunk', async () => {
    const usage = await collectStreamTokenUsage(streamFromText([
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')), 'openai');

    expect(usage).toEqual({ inputTokens: 11, outputTokens: 5 });
  });

  it('collects OpenAI Responses API streaming usage from the response.completed event', async () => {
    const usage = await collectStreamTokenUsage(streamFromText([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1","usage":null}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":40,"output_tokens":9,"input_tokens_details":{"cached_tokens":30}}}}',
      '',
      '',
    ].join('\n')), 'openai');

    expect(usage).toEqual({ inputTokens: 40, outputTokens: 9, cachedInputTokens: 30 });
  });

  it('extracts Anthropic prompt-cache reads and writes for pricing', () => {
    expect(extractJsonTokenUsage({
      usage: {
        input_tokens: 20,
        output_tokens: 9,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 10,
      },
    }, 'anthropic')).toEqual({
      inputTokens: 20,
      outputTokens: 9,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 10,
    });
  });

  it('collects Anthropic streaming usage across message_start and message_delta', async () => {
    const usage = await collectStreamTokenUsage(streamFromText([
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":17,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":8}}',
      '',
      '',
    ].join('\n')), 'anthropic');

    expect(usage).toEqual({ inputTokens: 17, outputTokens: 8 });
  });

  it('estimates input tokens from text message content', () => {
    expect(estimateInputTokensFromMessages([
      { role: 'user', content: '12345678' },
      { role: 'assistant', content: [{ type: 'text', text: '1234' }] },
    ])).toBe(3);
  });
});
