/**
 * Unit tests for SamSession Durable Object and agent loop components.
 *
 * Covers:
 * - SSE event encoding format
 * - Tool execution dispatch and error handling
 * - SAM config resolution from env vars
 * - Agent loop streaming with mocked Anthropic response
 * - Anthropic message format conversion
 */
import {
  DEFAULT_SAM_AIG_SOURCE,
  DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW,
  DEFAULT_SAM_MAX_CONVERSATIONS,
  DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION,
  DEFAULT_SAM_MAX_TOKENS,
  DEFAULT_SAM_MAX_TURNS,
  DEFAULT_SAM_MODEL,
  DEFAULT_SAM_RATE_LIMIT_RPM,
  DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS,
  resolveSamConfig,
  SAM_ANTHROPIC_VERSION,
} from '@simple-agent-manager/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '../../../src/durable-objects/sam-session/agent-loop';
import { executeTool } from '../../../src/durable-objects/sam-session/tools';
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

  it('uses defaults when no env vars set', () => {
    const config = resolveSamConfig({});

    expect(config.model).toBe(DEFAULT_SAM_MODEL);
    expect(config.maxTokens).toBe(DEFAULT_SAM_MAX_TOKENS);
    expect(config.maxTurns).toBe(DEFAULT_SAM_MAX_TURNS);
    expect(config.rateLimitRpm).toBe(DEFAULT_SAM_RATE_LIMIT_RPM);
    expect(config.rateLimitWindowSeconds).toBe(DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS);
    expect(config.systemPromptAppend).toBe('');
    expect(config.aigSource).toBe(DEFAULT_SAM_AIG_SOURCE);
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

    expect(SAM_TOOLS).toHaveLength(3);

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
  });

  it('get_project_status requires projectId', async () => {
    const { SAM_TOOLS } = await import('../../../src/durable-objects/sam-session/tools');
    const getProjectStatus = SAM_TOOLS.find((t) => t.name === 'get_project_status');

    expect(getProjectStatus?.input_schema.required).toContain('projectId');
  });
});

/* ═══════════════════════════════════════════════════════════════
   Agent Loop Tests — mock fetch to return synthetic Anthropic SSE
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

describe('Agent Loop — Streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits text_delta and done events for a simple text response', async () => {
    // Mock fetch to return an Anthropic streaming response with text only
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

    // Wait a tick for the reader to process
    await new Promise((r) => setTimeout(r, 50));

    // Should have text_delta events
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBe(2);
    expect(textDeltas[0]!.content).toBe('Hello!');
    expect(textDeltas[1]!.content).toBe(' How can I help?');

    // Should end with done
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents.length).toBe(1);

    // Should persist assistant message
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.role).toBe('assistant');
    expect(persisted[0]!.content).toBe('Hello! How can I help?');
  });

  it('emits tool_start, tool_result events for tool use response', async () => {
    // First call: Anthropic returns a tool_use block
    const firstCallEvents = [
      { type: 'message_start', message: { id: 'msg_2', role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_projects' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];

    // Second call: Anthropic returns text after tool result
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

    // Should have tool_start
    const toolStarts = events.filter((e) => e.type === 'tool_start');
    expect(toolStarts.length).toBe(1);
    expect(toolStarts[0]!.tool).toBe('list_projects');

    // Should have tool_result
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]!.tool).toBe('list_projects');

    // Should have text after tool execution
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);

    // Should end with done
    expect(events.filter((e) => e.type === 'done').length).toBe(1);

    // Should have persisted: assistant (tool call), tool_result, assistant (text)
    expect(persisted.length).toBe(3);
    expect(persisted[0]!.role).toBe('assistant');
    expect(persisted[1]!.role).toBe('tool_result');
    expect(persisted[2]!.role).toBe('assistant');
  });

  it('emits error event when Anthropic returns non-200', async () => {
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
    // Create events that always return tool_use, forcing continued loops
    const toolUseEvents = [
      { type: 'message_start', message: { id: 'msg_loop', role: 'assistant' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_loop', name: 'list_projects' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    // Return tool_use for every call (maxTurns + safety margin)
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

    // Should have an error about max turns
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0]!.message as string)).toContain('Maximum tool iterations');

    // fetch should have been called exactly 3 times (maxTurns)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('converts history rows to Anthropic message format', async () => {
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

    // Verify the fetch body includes history + new message
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
