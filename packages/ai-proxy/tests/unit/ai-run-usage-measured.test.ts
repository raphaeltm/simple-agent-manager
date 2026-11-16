/**
 * Insights slice U: the AI proxy reports only usage the upstream measured, normalized so input
 * excludes cache reads for every format, and never the input estimate used for budgets.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  accountTokenUsageFromJson,
  collectStreamTokenUsage,
  extractJsonTokenUsage,
  type MeasuredTokenUsage,
  measuredTokenUsage,
} from '../../src/ai-token-usage-accounting';
import type { AiProxyEnv } from '../../src/env';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const kvEnv = {
  KV: { get: async () => null, put: async () => undefined },
} as unknown as AiProxyEnv;

describe('measured run usage from the AI proxy', () => {
  it('reads Anthropic cache reads and writes, separate from input', () => {
    const extracted = extractJsonTokenUsage(
      {
        usage: {
          input_tokens: 20,
          output_tokens: 9,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 40,
        },
      },
      'anthropic'
    );
    expect(measuredTokenUsage(extracted, 'anthropic')).toEqual({
      inputTokens: 20,
      outputTokens: 9,
      cacheReadTokens: 500,
      cacheWriteTokens: 40,
      reasoningTokens: null,
    });
  });

  it('moves OpenAI cached tokens out of the prompt total and keeps reasoning', () => {
    const extracted = extractJsonTokenUsage(
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 600 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      },
      'openai'
    );
    // Budgets keep the provider's prompt total; only the run-usage view subtracts the cache.
    expect(extracted.inputTokens).toBe(1000);
    expect(measuredTokenUsage(extracted, 'openai')).toEqual({
      inputTokens: 400,
      outputTokens: 200,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
      reasoningTokens: 50,
    });
  });

  it('collects Anthropic stream cache counters from message_start', async () => {
    const usage = await collectStreamTokenUsage(
      streamFromText(
        [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":17,"cache_read_input_tokens":900,"cache_creation_input_tokens":12}}}',
          '',
          'data: {"type":"message_delta","usage":{"output_tokens":8}}',
          '',
          '',
        ].join('\n')
      ),
      'anthropic'
    );
    expect(measuredTokenUsage(usage, 'anthropic')).toMatchObject({
      inputTokens: 17,
      outputTokens: 8,
      cacheReadTokens: 900,
      cacheWriteTokens: 12,
    });
  });

  it('collects Responses API usage nested in response.completed', async () => {
    const usage = await collectStreamTokenUsage(
      streamFromText(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":300,"output_tokens":40,"input_tokens_details":{"cached_tokens":100},"output_tokens_details":{"reasoning_tokens":10}}}}\n\n'
      ),
      'openai'
    );
    expect(measuredTokenUsage(usage, 'openai')).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
    });
  });

  it('reports nothing when the upstream reported no usage, even with an input estimate', async () => {
    const onMeasuredUsage = vi.fn(async (_usage: MeasuredTokenUsage) => undefined);
    await accountTokenUsageFromJson(
      { id: 'resp' },
      { env: kvEnv, userId: 'u', format: 'anthropic', fallbackInputTokens: 5000, onMeasuredUsage }
    );
    expect(measuredTokenUsage({}, 'openai')).toBeNull();
    expect(onMeasuredUsage).not.toHaveBeenCalled();
  });

  it('hands measured usage to the hook and keeps budget accounting when the hook fails', async () => {
    const put = vi.fn(async () => undefined);
    const env = { KV: { get: async () => null, put } } as unknown as AiProxyEnv;
    const onMeasuredUsage = vi.fn(async () => {
      throw new Error('D1 unavailable');
    });
    await accountTokenUsageFromJson(
      { usage: { input_tokens: 3, output_tokens: 2 } },
      { env, userId: 'u', format: 'anthropic', onMeasuredUsage }
    );
    expect(onMeasuredUsage).toHaveBeenCalledWith({
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: null,
    });
    expect(put).toHaveBeenCalled();
  });
});
