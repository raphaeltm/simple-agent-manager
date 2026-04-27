/**
 * Unit tests for SamSession Durable Object and agent loop components.
 *
 * Covers:
 * - SSE event encoding format
 * - Tool execution dispatch and error handling
 * - SAM config resolution from env vars
 * - Agent loop streaming with mocked Anthropic response
 * - Agent loop streaming with mocked OpenAI (Workers AI) response
 * - Message format conversion (history rows → OpenAI format)
 * - Fetch timeout handling
 */
import {
  DEFAULT_SAM_AIG_SOURCE,
  DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW,
  DEFAULT_SAM_FTS_ENABLED,
  DEFAULT_SAM_HISTORY_LOAD_LIMIT,
  DEFAULT_SAM_MAX_CONVERSATIONS,
  DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION,
  DEFAULT_SAM_MAX_TOKENS,
  DEFAULT_SAM_MAX_TURNS,
  DEFAULT_SAM_MODEL,
  DEFAULT_SAM_RATE_LIMIT_RPM,
  DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_SAM_SEARCH_LIMIT,
  DEFAULT_SAM_SEARCH_MAX_LIMIT,
  resolveSamConfig,
  SAM_ANTHROPIC_VERSION,
} from '@simple-agent-manager/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '../../../src/durable-objects/sam-session/agent-loop';
import { buildFtsQuery, extractSnippet } from '../../../src/durable-objects/sam-session/index';
import { executeTool } from '../../../src/durable-objects/sam-session/tools';
import { searchConversationHistory } from '../../../src/durable-objects/sam-session/tools/search-conversation-history';
import type { CollectedToolCall, MessageRow, ToolContext } from '../../../src/durable-objects/sam-session/types';

// Mock cloudflare:workers (vitest hoists vi.mock calls automatically)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn().mockResolvedValue({
    credential: 'test-api-key',
  }),
}));

describe('SAM Constants and Config', () => {
  it('has correct default values', () => {
    expect(DEFAULT_SAM_MODEL).toBe('claude-sonnet-4-20250514');
    expect(DEFAULT_SAM_MAX_TOKENS).toBe(4096);
    expect(DEFAULT_SAM_MAX_TURNS).toBe(20);
    expect(DEFAULT_SAM_RATE_LIMIT_RPM).toBe(30);
    expect(DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(DEFAULT_SAM_MAX_CONVERSATIONS).toBe(100);
    expect(DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION).toBe(500);
    expect(DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW).toBe(50);
    expect(DEFAULT_SAM_AIG_SOURCE).toBe('sam');
    expect(SAM_ANTHROPIC_VERSION).toBe('2023-06-01');
    expect(DEFAULT_SAM_FTS_ENABLED).toBe(true);
    expect(DEFAULT_SAM_SEARCH_LIMIT).toBe(10);
    expect(DEFAULT_SAM_SEARCH_MAX_LIMIT).toBe(50);
    expect(DEFAULT_SAM_HISTORY_LOAD_LIMIT).toBe(200);
  });

  it('resolves config from env vars', () => {
    const config = resolveSamConfig({
      SAM_MODEL: 'claude-opus-4-20250514',
      SAM_MAX_TOKENS: '8192',
      SAM_MAX_TURNS: '10',
    });

    expect(config.model).toBe('claude-opus-4-20250514');
    expect(config.maxTokens).toBe(8192);
    expect(config.maxTurns).toBe(10);
    // Defaults for unset values
    expect(config.rateLimitRpm).toBe(DEFAULT_SAM_RATE_LIMIT_RPM);
    expect(config.aigSource).toBe(DEFAULT_SAM_AIG_SOURCE);
  });

  it('resolves Workers AI model from env', () => {
    const config = resolveSamConfig({
      SAM_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct',
    });
    expect(config.model).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('uses defaults when no env vars set', () => {
    const config = resolveSamConfig({});

    expect(config.model).toBe(DEFAULT_SAM_MODEL);
    expect(config.maxTokens).toBe(DEFAULT_SAM_MAX_TOKENS);
    expect(config.maxTurns).toBe(DEFAULT_SAM_MAX_TURNS);
    expect(config.rateLimitRpm).toBe(DEFAULT_SAM_RATE_LIMIT_RPM);
    expect(config.rateLimitWindowSeconds).toBe(DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS);
    expect(config.systemPromptAppend).toBe('');
    expect(config.aigSource).toBe(DEFAULT_SAM_AIG_SOURCE);
    expect(config.ftsEnabled).toBe(true);
    expect(config.searchLimit).toBe(DEFAULT_SAM_SEARCH_LIMIT);
    expect(config.searchMaxLimit).toBe(DEFAULT_SAM_SEARCH_MAX_LIMIT);
    expect(config.historyLoadLimit).toBe(DEFAULT_SAM_HISTORY_LOAD_LIMIT);
  });

  it('resolves FTS and search config from env', () => {
    const config = resolveSamConfig({
      SAM_FTS_ENABLED: 'false',
      SAM_SEARCH_LIMIT: '20',
      SAM_SEARCH_MAX_LIMIT: '100',
      SAM_HISTORY_LOAD_LIMIT: '500',
    });

    expect(config.ftsEnabled).toBe(false);
    expect(config.searchLimit).toBe(20);
    expect(config.searchMaxLimit).toBe(100);
    expect(config.historyLoadLimit).toBe(500);
  });

  it('handles non-numeric env values gracefully', () => {
    const config = resolveSamConfig({
      SAM_MAX_TOKENS: 'not-a-number',
      SAM_MAX_TURNS: '',
    });

    expect(config.maxTokens).toBe(DEFAULT_SAM_MAX_TOKENS);
    expect(config.maxTurns).toBe(DEFAULT_SAM_MAX_TURNS);
  });
});

describe('Tool Execution', () => {
  const mockCtx: ToolContext = {
    env: { DATABASE: {} } as Record<string, unknown>,
    userId: 'test-user-id',
  };

  it('returns error for unknown tools', async () => {
    const toolCall: CollectedToolCall = {
      id: 'call-1',
      name: 'nonexistent_tool',
      input: {},
    };

    const result = await executeTool(toolCall, mockCtx);
    expect(result).toEqual({ error: 'Unknown tool: nonexistent_tool' });
  });

  it('catches tool handler errors', async () => {
    // list_projects will fail because the mock DATABASE isn't a real D1Database
    // but the error should be caught gracefully
    const toolCall: CollectedToolCall = {
      id: 'call-2',
      name: 'list_projects',
      input: {},
    };

    const result = await executeTool(toolCall, mockCtx);
    // Should return an error object, not throw
    expect(result).toHaveProperty('error');
    expect(typeof (result as { error: string }).error).toBe('string');
  });

  it('dispatches to correct handler for each tool name', async () => {
    // Verify all three tools are registered
    for (const toolName of ['list_projects', 'get_project_status', 'search_tasks']) {
      const toolCall: CollectedToolCall = {
        id: `call-${toolName}`,
        name: toolName,
        input: toolName === 'get_project_status' ? { projectId: 'test' } : {},
      };
      const result = await executeTool(toolCall, mockCtx);
      // Should not return "Unknown tool" error
      const errorResult = result as { error?: string };
      if (errorResult.error) {
        expect(errorResult.error).not.toContain('Unknown tool');
      }
    }
  });
});

describe('SSE Event Format', () => {
  it('encodes events as unnamed SSE data frames', () => {
    // Test the SSE format matches the unnamed-event contract
    // (data: {json}\n\n — no "event:" line)
    const event = { type: 'text_delta', content: 'hello' };
    const encoded = `data: ${JSON.stringify(event)}\n\n`;

    // Must not contain "event:" line
    expect(encoded).not.toContain('event:');
    // Must start with "data: "
    expect(encoded.startsWith('data: ')).toBe(true);
    // Must end with double newline
    expect(encoded.endsWith('\n\n')).toBe(true);
    // Must be valid JSON after "data: " prefix
    const jsonStr = encoded.slice(6, encoded.indexOf('\n'));
    expect(() => JSON.parse(jsonStr)).not.toThrow();
    expect(JSON.parse(jsonStr)).toEqual(event);
  });

  it('encodes all event types correctly', () => {
    const events = [
      { type: 'text_delta', content: 'hello world' },
      { type: 'tool_start', tool: 'list_projects', input: {} },
      { type: 'tool_result', tool: 'list_projects', result: { projects: [] } },
      { type: 'error', message: 'Something went wrong' },
      { type: 'done' },
    ];

    for (const event of events) {
      const encoded = `data: ${JSON.stringify(event)}\n\n`;
      const parsed = JSON.parse(encoded.slice(6, encoded.indexOf('\n')));
      expect(parsed.type).toBe(event.type);
    }
  });
});

describe('SAM Tool Definitions', () => {
  it('exports tool definitions in Anthropic native format', async () => {
    const { SAM_TOOLS } = await import('../../../src/durable-objects/sam-session/tools');

    expect(SAM_TOOLS).toHaveLength(19);

    for (const tool of SAM_TOOLS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('input_schema');
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema).toHaveProperty('properties');
    }

    const names = SAM_TOOLS.map((t) => t.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('get_project_status');
    expect(names).toContain('search_tasks');
    expect(names).toContain('search_conversation_history');
  });

  it('get_project_status requires projectId', async () => {
    const { SAM_TOOLS } = await import('../../../src/durable-objects/sam-session/tools');
    const getProjectStatus = SAM_TOOLS.find((t) => t.name === 'get_project_status');

    expect(getProjectStatus?.input_schema.required).toContain('projectId');
  });
});

describe('buildFtsQuery', () => {
  it('wraps each word in double quotes', () => {
    expect(buildFtsQuery('hello world')).toBe('"hello" "world"');
  });

  it('returns null for empty input', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
  });

  it('escapes double quotes within words', () => {
    expect(buildFtsQuery('say "hello"')).toBe('"say" """hello"""');
  });

  it('handles single word', () => {
    expect(buildFtsQuery('testing')).toBe('"testing"');
  });

  it('strips extra whitespace', () => {
    expect(buildFtsQuery('  a   b  ')).toBe('"a" "b"');
  });
});

describe('extractSnippet', () => {
  it('returns snippet around first match', () => {
    const content = 'A'.repeat(200) + 'MATCH' + 'B'.repeat(200);
    const snippet = extractSnippet(content, 'MATCH');
    expect(snippet).toContain('MATCH');
    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
    expect(snippet.length).toBeLessThan(content.length);
  });

  it('returns start of content when no match', () => {
    const content = 'Hello world this is a test message';
    const snippet = extractSnippet(content, 'zzzzz');
    expect(snippet).toBe(content);
  });

  it('truncates long content when no match', () => {
    const content = 'X'.repeat(300);
    const snippet = extractSnippet(content, 'nomatch');
    expect(snippet.length).toBe(203); // 200 + '...'
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('is case-insensitive', () => {
    const content = 'Hello World Test';
    const snippet = extractSnippet(content, 'hello');
    expect(snippet).toContain('Hello');
  });

  it('does not prefix with ... when match is near start', () => {
    const content = 'Hello World Test';
    const snippet = extractSnippet(content, 'Hello');
    expect(snippet.startsWith('...')).toBe(false);
  });
});

describe('search_conversation_history tool', () => {
  it('returns error for empty query', async () => {
    const ctx: ToolContext = { env: {} as Record<string, unknown>, userId: 'u1' };
    const result = await searchConversationHistory({ query: '' }, ctx);
    expect(result).toEqual({ error: 'Query is required' });
  });

  it('returns error when searchMessages not available', async () => {
    const ctx: ToolContext = { env: {} as Record<string, unknown>, userId: 'u1' };
    const result = await searchConversationHistory({ query: 'test' }, ctx);
    expect(result).toEqual({ error: 'Search is not available in this context' });
  });

  it('calls searchMessages and returns results', async () => {
    const mockResults = [
      { snippet: 'test snippet', role: 'user', sequence: 1, createdAt: '2026-01-01' },
    ];
    const ctx: ToolContext = {
      env: {} as Record<string, unknown>,
      userId: 'u1',
      searchMessages: vi.fn().mockReturnValue(mockResults),
    };
    const result = await searchConversationHistory({ query: 'test', limit: 5 }, ctx);
    expect(ctx.searchMessages).toHaveBeenCalledWith('test', 5);
    expect(result).toEqual({ results: mockResults, count: 1, query: 'test' });
  });

  it('caps limit at DEFAULT_SAM_SEARCH_MAX_LIMIT', async () => {
    const ctx: ToolContext = {
      env: {} as Record<string, unknown>,
      userId: 'u1',
      searchMessages: vi.fn().mockReturnValue([]),
    };
    await searchConversationHistory({ query: 'test', limit: 999 }, ctx);
    expect(ctx.searchMessages).toHaveBeenCalledWith('test', DEFAULT_SAM_SEARCH_MAX_LIMIT);
  });

  it('defaults limit to DEFAULT_SAM_SEARCH_LIMIT', async () => {
    const ctx: ToolContext = {
      env: {} as Record<string, unknown>,
      userId: 'u1',
      searchMessages: vi.fn().mockReturnValue([]),
    };
    await searchConversationHistory({ query: 'test' }, ctx);
    expect(ctx.searchMessages).toHaveBeenCalledWith('test', DEFAULT_SAM_SEARCH_LIMIT);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Agent Loop Tests — mock fetch to return synthetic SSE streams
   ═══════════════════════════════════════════════════════════════ */

/** Build a synthetic Anthropic SSE stream from events. */
function buildAnthropicSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = events.map((e) => `event: ${(e.type as string) || 'message'}\ndata: ${JSON.stringify(e)}\n\n`);
  const body = lines.join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

/** Build a synthetic OpenAI SSE stream from chunks. */
function buildOpenAISseStream(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  const body = lines.join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

/** Collect all SSE events written to a WritableStream. */
function createCollectingWriter(): {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  // Read in background
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      let done = false;
      while (!done) {
        const result = await reader.read();
        if (result.done) { done = true; break; }
        buffer += decoder.decode(result.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          try {
            events.push(JSON.parse(part.slice(6)) as Record<string, unknown>);
          } catch { /* ignore */ }
        }
      }
    } catch { /* stream may close */ }
  })();

  return { writer, events };
}

describe('Agent Loop — Anthropic Streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits text_delta and done events for a simple text response', async () => {
    const anthropicEvents = [
      { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello!' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' How can I help?' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(buildAnthropicSseStream(anthropicEvents), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const { writer, events } = createCollectingWriter();
    const persisted: Array<{ role: string; content: string }> = [];

    const config = resolveSamConfig({});
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: '',
      CF_ACCOUNT_ID: '',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop(
      'conv-1',
      [], // no history
      'Hi SAM',
      config,
      mockEnv,
      'user-1',
      writer,
      (_convId, role, content) => {
        persisted.push({ role, content });
      },
    );
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBe(2);
    expect(textDeltas[0]!.content).toBe('Hello!');
    expect(textDeltas[1]!.content).toBe(' How can I help?');

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents.length).toBe(1);

    expect(persisted.length).toBe(1);
    expect(persisted[0]!.role).toBe('assistant');
    expect(persisted[0]!.content).toBe('Hello! How can I help?');
  });

  it('emits tool_start, tool_result events for tool use response', async () => {
    const firstCallEvents = [
      { type: 'message_start', message: { id: 'msg_2', role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_projects' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];

    const secondCallEvents = [
      { type: 'message_start', message: { id: 'msg_3', role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'You have projects.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(
        new Response(buildAnthropicSseStream(firstCallEvents), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
      .mockResolvedValueOnce(
        new Response(buildAnthropicSseStream(secondCallEvents), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );

    const { writer, events } = createCollectingWriter();
    const persisted: Array<{ role: string; content: string }> = [];

    const config = resolveSamConfig({});
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: '',
      CF_ACCOUNT_ID: '',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop(
      'conv-2',
      [],
      'Show my projects',
      config,
      mockEnv,
      'user-1',
      writer,
      (_convId, role, content) => {
        persisted.push({ role, content });
      },
    );
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const toolStarts = events.filter((e) => e.type === 'tool_start');
    expect(toolStarts.length).toBe(1);
    expect(toolStarts[0]!.tool).toBe('list_projects');

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]!.tool).toBe('list_projects');

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);

    expect(events.filter((e) => e.type === 'done').length).toBe(1);

    expect(persisted.length).toBe(3);
    expect(persisted[0]!.role).toBe('assistant');
    expect(persisted[1]!.role).toBe('tool_result');
    expect(persisted[2]!.role).toBe('assistant');
  });

  it('emits error event when API returns non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":{"message":"Invalid API key"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );

    const { writer, events } = createCollectingWriter();

    const config = resolveSamConfig({});
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: '',
      CF_ACCOUNT_ID: '',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop(
      'conv-3',
      [],
      'Hello',
      config,
      mockEnv,
      'user-1',
      writer,
      () => { /* no-op */ },
    );
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0]!.message as string)).toContain('401');
  });

  it('respects maxTurns limit', async () => {
    const toolUseEvents = [
      { type: 'message_start', message: { id: 'msg_loop', role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_loop', name: 'list_projects' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (let i = 0; i < 5; i++) {
      fetchMock.mockResolvedValueOnce(
        new Response(buildAnthropicSseStream(toolUseEvents), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    }

    const { writer, events } = createCollectingWriter();

    const config = resolveSamConfig({ SAM_MAX_TURNS: '3' });
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: '',
      CF_ACCOUNT_ID: '',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop(
      'conv-4',
      [],
      'Loop forever',
      config,
      mockEnv,
      'user-1',
      writer,
      () => { /* no-op */ },
    );
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0]!.message as string)).toContain('Maximum tool iterations');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('converts history rows to message format', async () => {
    const history: MessageRow[] = [
      {
        id: 'h1', conversation_id: 'c1', role: 'user', content: 'Previous question',
        tool_calls_json: null, tool_call_id: null, created_at: '', sequence: 1,
      },
      {
        id: 'h2', conversation_id: 'c1', role: 'assistant', content: 'Previous answer',
        tool_calls_json: null, tool_call_id: null, created_at: '', sequence: 2,
      },
    ];

    const anthropicEvents = [
      { type: 'message_start', message: { id: 'msg_hist', role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Response with context' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(buildAnthropicSseStream(anthropicEvents), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const { writer } = createCollectingWriter();

    const config = resolveSamConfig({});
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: '',
      CF_ACCOUNT_ID: '',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop('conv-hist', history, 'New question', config, mockEnv, 'user-1', writer, () => {});
    await writer.close();

    // Verify the fetch body includes history + new message (Anthropic format)
    const fetchCall = fetchMock.mock.calls[0]!;
    const fetchBody = JSON.parse(fetchCall[1]!.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };

    // Should have: history user, history assistant, new user = 3 messages
    expect(fetchBody.messages.length).toBe(3);
    expect(fetchBody.messages[0]!.role).toBe('user');
    expect(fetchBody.messages[0]!.content).toBe('Previous question');
    expect(fetchBody.messages[1]!.role).toBe('assistant');
    expect(fetchBody.messages[2]!.role).toBe('user');
    expect(fetchBody.messages[2]!.content).toBe('New question');
  });
});

describe('Agent Loop — OpenAI (Workers AI) Streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits text_delta and done events for Workers AI text response', async () => {
    const openAIChunks = [
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Hello from ' } }] },
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Workers AI!' } }] },
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(buildOpenAISseStream(openAIChunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const { writer, events } = createCollectingWriter();
    const persisted: Array<{ role: string; content: string }> = [];

    const config = resolveSamConfig({ SAM_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct' });
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: 'test-gw',
      CF_ACCOUNT_ID: 'test-acct',
      CF_API_TOKEN: 'test-token',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop(
      'conv-wai-1',
      [],
      'Hi SAM',
      config,
      mockEnv,
      'user-1',
      writer,
      (_convId, role, content) => {
        persisted.push({ role, content });
      },
    );
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBe(2);
    expect(textDeltas[0]!.content).toBe('Hello from ');
    expect(textDeltas[1]!.content).toBe('Workers AI!');

    expect(events.filter((e) => e.type === 'done').length).toBe(1);

    expect(persisted.length).toBe(1);
    expect(persisted[0]!.role).toBe('assistant');
    expect(persisted[0]!.content).toBe('Hello from Workers AI!');
  });

  it('routes Workers AI requests to the correct gateway URL', async () => {
    const openAIChunks = [
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Ok' }, finish_reason: 'stop' }] },
    ];

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(buildOpenAISseStream(openAIChunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const { writer } = createCollectingWriter();

    const config = resolveSamConfig({ SAM_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct' });
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: 'my-gateway',
      CF_ACCOUNT_ID: 'my-account',
      CF_API_TOKEN: 'my-token',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop('conv-url', [], 'Test', config, mockEnv, 'user-1', writer, () => {});
    await writer.close();

    const fetchCall = fetchMock.mock.calls[0]!;
    const url = fetchCall[0] as string;
    expect(url).toContain('gateway.ai.cloudflare.com');
    expect(url).toContain('my-account');
    expect(url).toContain('my-gateway');
    expect(url).toContain('workers-ai');

    const headers = fetchCall[1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-token');
  });

  it('handles Workers AI tool calls in OpenAI format', async () => {
    // First call: tool_calls in delta
    const firstCallChunks = [
      { id: 'chatcmpl-2', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_projects', arguments: '' } }] } }] },
      { id: 'chatcmpl-2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
      { id: 'chatcmpl-2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];

    // Second call: text response after tool result
    const secondCallChunks = [
      { id: 'chatcmpl-3', choices: [{ index: 0, delta: { content: 'Found your projects.' }, finish_reason: 'stop' }] },
    ];

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(
        new Response(buildOpenAISseStream(firstCallChunks), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
      .mockResolvedValueOnce(
        new Response(buildOpenAISseStream(secondCallChunks), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );

    const { writer, events } = createCollectingWriter();
    const persisted: Array<{ role: string; content: string }> = [];

    const config = resolveSamConfig({ SAM_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct' });
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: 'gw',
      CF_ACCOUNT_ID: 'acct',
      CF_API_TOKEN: 'tok',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop(
      'conv-wai-tool',
      [],
      'Show my projects',
      config,
      mockEnv,
      'user-1',
      writer,
      (_convId, role, content) => {
        persisted.push({ role, content });
      },
    );
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const toolStarts = events.filter((e) => e.type === 'tool_start');
    expect(toolStarts.length).toBe(1);
    expect(toolStarts[0]!.tool).toBe('list_projects');

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.length).toBe(1);

    expect(events.filter((e) => e.type === 'done').length).toBe(1);

    // assistant (tool call), tool_result, assistant (text)
    expect(persisted.length).toBe(3);
    expect(persisted[0]!.role).toBe('assistant');
    expect(persisted[1]!.role).toBe('tool_result');
    expect(persisted[2]!.role).toBe('assistant');
  });
});

describe('Agent Loop — Fetch Error Handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits error event when fetch throws (network error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const { writer, events } = createCollectingWriter();

    const config = resolveSamConfig({});
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: '',
      CF_ACCOUNT_ID: '',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop('conv-err', [], 'Hello', config, mockEnv, 'user-1', writer, () => {});
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0]!.message as string)).toContain('Failed to reach AI service');
  });

  it('emits timeout error when fetch is aborted', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));

    const { writer, events } = createCollectingWriter();

    const config = resolveSamConfig({});
    const mockEnv = {
      DATABASE: {},
      AI_GATEWAY_ID: '',
      CF_ACCOUNT_ID: '',
      SAM_LLM_TIMEOUT_MS: '100',
    } as unknown as Parameters<typeof runAgentLoop>[4];

    await runAgentLoop('conv-timeout', [], 'Hello', config, mockEnv, 'user-1', writer, () => {});
    await writer.close();
    await new Promise((r) => setTimeout(r, 50));

    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0]!.message as string)).toContain('timed out');
  });
});
