import type { SamConfig } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '../../../src/durable-objects/sam-session/agent-loop';
import type { MessageRow } from '../../../src/durable-objects/sam-session/types';
import type { Env } from '../../../src/env';

function makeConfig(overrides: Partial<SamConfig> = {}): SamConfig {
  return {
    model: '@cf/test/model',
    maxTokens: 128,
    maxTurns: 1,
    maxRequestBodyBytes: 100_000,
    maxToolResultBytes: 10_000,
    aigSource: 'sam-session',
    ftsEnabled: false,
    ...overrides,
  } as SamConfig;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'cf-token',
    AI_GATEWAY_ID: 'gateway-1',
    KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as unknown as Env;
}

function createCollectingWriter(): { writer: WritableStreamDefaultWriter<Uint8Array>; output: string[] } {
  const decoder = new TextDecoder();
  const output: string[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      output.push(decoder.decode(chunk, { stream: true }));
    },
    close() {
      output.push(decoder.decode());
    },
  });
  return { writer: writable.getWriter(), output };
}

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.map((chunk) => `data: ${chunk}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('runAgentLoop metering', () => {
  const history: MessageRow[] = [];

  it('denies the LLM call when the user is over daily token budget', async () => {
    const kvGet = vi.fn().mockImplementation(async (key: string) => {
      if (key.startsWith('ai-budget:user-1:')) return { inputTokens: 2, outputTokens: 0 };
      return null;
    });
    const env = makeEnv({
      AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: '1',
      KV: { get: kvGet, put: vi.fn() } as unknown as KVNamespace,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { writer, output } = createCollectingWriter();

    await runAgentLoop(
      'conversation-1',
      history,
      'hello',
      makeConfig(),
      env,
      'user-1',
      writer,
      vi.fn(),
      undefined,
      { systemPrompt: 'system', tools: [], executeTool: async () => ({}) },
    );
    await writer.close();

    expect(output.join('')).toContain('Daily token budget exceeded. Resets at midnight UTC.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accounts token usage from streamed OpenAI-format responses', async () => {
    let storedBudget: { inputTokens: number; outputTokens: number } | null = null;
    const kvGet = vi.fn().mockImplementation(async (key: string) => {
      if (key.startsWith('ai-budget:user-1:')) return storedBudget;
      return null;
    });
    const kvPut = vi.fn().mockImplementation(async (_key: string, value: string) => {
      storedBudget = JSON.parse(value) as { inputTokens: number; outputTokens: number };
    });
    const env = makeEnv({ KV: { get: kvGet, put: kvPut } as unknown as KVNamespace });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      '[DONE]',
    ])));
    const waitUntilPromises: Promise<unknown>[] = [];
    const { writer, output } = createCollectingWriter();

    await runAgentLoop(
      'conversation-1',
      history,
      'hello',
      makeConfig(),
      env,
      'user-1',
      writer,
      vi.fn(),
      undefined,
      { systemPrompt: 'system', tools: [], executeTool: async () => ({}) },
      { waitUntil: (promise) => { waitUntilPromises.push(promise); } },
    );
    await Promise.all(waitUntilPromises);
    await writer.close();

    expect(output.join('')).toContain('Hello');
    expect(storedBudget).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});
