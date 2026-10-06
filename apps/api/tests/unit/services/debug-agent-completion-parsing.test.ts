import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  complete,
  executeTool,
  resolveDebugAgentConfig,
  type ToolCall,
} from '../../../src/services/debug-agent';

const mocks = vi.hoisted(() => ({
  queryCloudflareLogs: vi.fn().mockResolvedValue({
    logs: [],
    cursor: null,
    hasMore: false,
    queryId: 'q1',
  }),
}));

vi.mock('../../../src/services/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/observability')>();
  return {
    ...actual,
    queryCloudflareLogs: mocks.queryCloudflareLogs,
  };
});

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    CF_API_TOKEN: 'server-token',
    CF_ACCOUNT_ID: 'account-1',
    ...overrides,
  } as Env;
}

describe('complete() — validated Completion response parsing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses a well-formed completion response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello', tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = resolveDebugAgentConfig({} as Env);
    const result = await complete(makeEnv(), config, 'test-feature', [], 100);

    expect(result.choices?.[0]?.message?.content).toBe('hello');
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('parses a response with no choices/usage at all (every field is optional)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
    vi.stubGlobal('fetch', fetchMock);

    const config = resolveDebugAgentConfig({} as Env);
    await expect(complete(makeEnv(), config, 'test-feature', [], 100)).resolves.toEqual({});
  });

  it('throws instead of returning a blindly-cast payload for a literal JSON null body', async () => {
    // Regression: `(await response.json()) as Completion` let `payload` be
    // `null` with no error at all. The caller's existing catch
    // (`releaseFeatureTokenBudget` + rethrow) only fires when complete()
    // actually throws — a silently-null completion skipped that path.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
    vi.stubGlobal('fetch', fetchMock);

    const config = resolveDebugAgentConfig({} as Env);
    await expect(complete(makeEnv(), config, 'test-feature', [], 100)).rejects.toThrow();
  });

  it('throws for a tool_calls entry missing required fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'x' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = resolveDebugAgentConfig({} as Env);
    // function.arguments is missing — every downstream tool_calls consumer
    // (JSON.parse(call.function.arguments)) assumes it is always a string.
    await expect(complete(makeEnv(), config, 'test-feature', [], 100)).rejects.toThrow();
  });

  it('still throws the HTTP-status error before attempting to parse the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('oops', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const config = resolveDebugAgentConfig({} as Env);
    await expect(complete(makeEnv(), config, 'test-feature', [], 100)).rejects.toThrow(
      'Debugging model request failed with HTTP 500'
    );
  });
});

describe('executeTool — query_cloudflare_logs argument parsing', () => {
  const window = { errorId: null, startMs: 0, endMs: 60_000 };

  function toolCall(args: string): ToolCall {
    return {
      id: 'call-1',
      type: 'function',
      function: { name: 'query_cloudflare_logs', arguments: args },
    };
  }

  it('forwards well-formed search/levels args', async () => {
    const config = resolveDebugAgentConfig({} as Env);
    await executeTool(
      makeEnv(),
      window,
      config,
      toolCall(JSON.stringify({ search: 'timeout', levels: ['error', 'warn'] }))
    );

    expect(mocks.queryCloudflareLogs).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'timeout', levels: ['error', 'warn'] })
    );
  });

  it('falls back to bounded defaults for JSON-syntax-invalid args', async () => {
    const config = resolveDebugAgentConfig({} as Env);
    await executeTool(makeEnv(), window, config, toolCall('{not valid json'));

    const call = mocks.queryCloudflareLogs.mock.calls.at(-1)?.[0];
    expect(call?.search).toBeUndefined();
    expect(call?.levels).toBeUndefined();
  });

  it('falls back to bounded defaults for wrongly-shaped-but-valid-JSON args (mistyped search)', async () => {
    // Regression: `JSON.parse(call.function.arguments) as typeof args` blindly
    // cast whatever the model produced. A numeric `search` used to reach
    // `args.search?.slice(0, 200)` downstream — numbers don't have `.slice`.
    const config = resolveDebugAgentConfig({} as Env);
    await executeTool(makeEnv(), window, config, toolCall(JSON.stringify({ search: 12345 })));

    const call = mocks.queryCloudflareLogs.mock.calls.at(-1)?.[0];
    expect(call?.search).toBeUndefined();
    expect(call?.levels).toBeUndefined();
  });

  it('falls back to bounded defaults when the model emits a JSON array instead of an object', async () => {
    const config = resolveDebugAgentConfig({} as Env);
    await executeTool(makeEnv(), window, config, toolCall(JSON.stringify(['unexpected'])));

    const call = mocks.queryCloudflareLogs.mock.calls.at(-1)?.[0];
    expect(call?.search).toBeUndefined();
    expect(call?.levels).toBeUndefined();
  });
});
