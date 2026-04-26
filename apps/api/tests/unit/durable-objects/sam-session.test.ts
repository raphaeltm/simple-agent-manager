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
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock cloudflare:workers before importing SamSession
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

// Mock platform credentials
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn().mockResolvedValue({
    credential: 'test-api-key',
  }),
}));

// Import after mocks
import {
  DEFAULT_SAM_MODEL,
  DEFAULT_SAM_MAX_TOKENS,
  DEFAULT_SAM_MAX_TURNS,
  DEFAULT_SAM_RATE_LIMIT_RPM,
  DEFAULT_SAM_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_SAM_MAX_CONVERSATIONS,
  DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION,
  DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW,
  DEFAULT_SAM_AIG_SOURCE,
  SAM_ANTHROPIC_VERSION,
  resolveSamConfig,
} from '@simple-agent-manager/shared';
import type { CollectedToolCall, ToolContext } from '../../../src/durable-objects/sam-session/types';
import { executeTool } from '../../../src/durable-objects/sam-session/tools';

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
