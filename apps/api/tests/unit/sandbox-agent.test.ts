/**
 * Tests for sandbox tools, agent loop, and SANDBOX_ENABLED gate.
 *
 * Uses mocks for both AI binding and Sandbox SDK since neither is
 * available in Miniflare.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  isSandboxEnabled,
  resolveSandboxAgentConfig,
  runSandboxAgent,
} from '../../src/services/sandbox-agent';
import {
  SANDBOX_TOOLS,
  SANDBOX_TOOL_NAMES,
  type SandboxHandle,
  executeSandboxTool,
} from '../../src/services/sandbox-tools';

// =============================================================================
// Sandbox Tool Definitions
// =============================================================================

describe('sandbox tool definitions', () => {
  it('defines exactly 5 tools', () => {
    expect(SANDBOX_TOOLS).toHaveLength(5);
  });

  it('each tool has valid OpenAI function-calling schema', () => {
    for (const tool of SANDBOX_TOOLS) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
      expect(tool.function.parameters.properties).toBeDefined();
      expect(Array.isArray(tool.function.parameters.required)).toBe(true);
    }
  });

  it('has expected tool names', () => {
    const names = SANDBOX_TOOLS.map((t) => t.function.name);
    expect(names).toContain('sandbox_exec');
    expect(names).toContain('sandbox_read_file');
    expect(names).toContain('sandbox_write_file');
    expect(names).toContain('sandbox_list_files');
    expect(names).toContain('sandbox_git_clone');
  });

  it('SANDBOX_TOOL_NAMES set matches tool definitions', () => {
    expect(SANDBOX_TOOL_NAMES.size).toBe(5);
    for (const tool of SANDBOX_TOOLS) {
      expect(SANDBOX_TOOL_NAMES.has(tool.function.name)).toBe(true);
    }
  });

  it('sandbox_exec requires command parameter', () => {
    const execTool = SANDBOX_TOOLS.find((t) => t.function.name === 'sandbox_exec')!;
    expect(execTool.function.parameters.required).toContain('command');
  });

  it('sandbox_read_file requires path parameter', () => {
    const tool = SANDBOX_TOOLS.find((t) => t.function.name === 'sandbox_read_file')!;
    expect(tool.function.parameters.required).toContain('path');
  });

  it('sandbox_write_file requires path and content', () => {
    const tool = SANDBOX_TOOLS.find((t) => t.function.name === 'sandbox_write_file')!;
    expect(tool.function.parameters.required).toContain('path');
    expect(tool.function.parameters.required).toContain('content');
  });

  it('sandbox_git_clone requires repo_url', () => {
    const tool = SANDBOX_TOOLS.find((t) => t.function.name === 'sandbox_git_clone')!;
    expect(tool.function.parameters.required).toContain('repo_url');
  });
});

// =============================================================================
// Tool Execution Dispatch
// =============================================================================

function createMockSandbox(): SandboxHandle {
  return {
    exec: vi.fn().mockResolvedValue({
      stdout: 'mock output',
      stderr: '',
      exitCode: 0,
      success: true,
    }),
    readFile: vi.fn().mockResolvedValue({ content: 'mock file content' }),
    writeFile: vi.fn().mockResolvedValue({ success: true }),
    listFiles: vi.fn().mockResolvedValue({
      files: [
        { name: 'file1.ts' },
        { name: 'file2.ts' },
      ],
      count: 2,
    }),
  };
}

describe('executeSandboxTool', () => {
  it('dispatches sandbox_exec correctly', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_exec', { command: 'ls -la' });

    expect(sandbox.exec).toHaveBeenCalledWith('ls -la', { timeout: 30_000 });
    expect(result).toMatchObject({
      stdout: 'mock output',
      exitCode: 0,
      success: true,
    });
    expect('durationMs' in result).toBe(true);
  });

  it('sandbox_exec uses custom timeout', async () => {
    const sandbox = createMockSandbox();
    await executeSandboxTool(sandbox, 'sandbox_exec', { command: 'sleep 5', timeout_ms: 60000 });

    expect(sandbox.exec).toHaveBeenCalledWith('sleep 5', { timeout: 60000 });
  });

  it('sandbox_exec returns error when command is missing', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_exec', {});
    expect(result).toEqual({ error: 'command is required' });
  });

  it('dispatches sandbox_read_file correctly', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_read_file', { path: '/workspace/main.ts' });

    expect(sandbox.readFile).toHaveBeenCalledWith('/workspace/main.ts');
    expect(result).toMatchObject({ content: 'mock file content' });
  });

  it('sandbox_read_file returns error when path is missing', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_read_file', {});
    expect(result).toEqual({ error: 'path is required' });
  });

  it('dispatches sandbox_write_file correctly', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_write_file', {
      path: '/workspace/out.ts',
      content: 'hello world',
    });

    expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/out.ts', 'hello world');
    expect(result).toEqual({ success: true });
  });

  it('sandbox_write_file returns error when path or content is missing', async () => {
    const sandbox = createMockSandbox();
    expect(await executeSandboxTool(sandbox, 'sandbox_write_file', { content: 'x' }))
      .toEqual({ error: 'path is required' });
    expect(await executeSandboxTool(sandbox, 'sandbox_write_file', { path: '/x' }))
      .toEqual({ error: 'content is required' });
  });

  it('dispatches sandbox_list_files correctly', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_list_files', { path: '/workspace' });

    expect(sandbox.listFiles).toHaveBeenCalledWith('/workspace');
    expect(result).toMatchObject({ entries: ['file1.ts', 'file2.ts'] });
  });

  it('sandbox_list_files defaults to /workspace when path omitted', async () => {
    const sandbox = createMockSandbox();
    await executeSandboxTool(sandbox, 'sandbox_list_files', {});

    expect(sandbox.listFiles).toHaveBeenCalledWith('/workspace');
  });

  it('dispatches sandbox_git_clone correctly', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_git_clone', {
      repo_url: 'https://github.com/test/repo',
      branch: 'develop',
      target_dir: '/project',
      depth: 3,
    });

    expect(sandbox.exec).toHaveBeenCalledWith(
      'git clone --depth=3 --branch=develop https://github.com/test/repo /project',
      { timeout: 120_000 }
    );
    expect(result).toMatchObject({ success: true });
  });

  it('sandbox_git_clone uses defaults for optional params', async () => {
    const sandbox = createMockSandbox();
    await executeSandboxTool(sandbox, 'sandbox_git_clone', {
      repo_url: 'https://github.com/test/repo',
    });

    expect(sandbox.exec).toHaveBeenCalledWith(
      'git clone --depth=1 --branch=main https://github.com/test/repo /workspace',
      { timeout: 120_000 }
    );
  });

  it('sandbox_git_clone returns error when repo_url is missing', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'sandbox_git_clone', {});
    expect(result).toEqual({ error: 'repo_url is required' });
  });

  it('returns error for unknown tool name', async () => {
    const sandbox = createMockSandbox();
    const result = await executeSandboxTool(sandbox, 'unknown_tool', {});
    expect(result).toEqual({ error: 'Unknown sandbox tool: unknown_tool' });
  });
});

// =============================================================================
// SANDBOX_ENABLED gate
// =============================================================================

describe('isSandboxEnabled', () => {
  it('returns false when SANDBOX_ENABLED is not set', () => {
    expect(isSandboxEnabled({} as any)).toBe(false);
  });

  it('returns false when SANDBOX_ENABLED is "false"', () => {
    expect(isSandboxEnabled({ SANDBOX_ENABLED: 'false' } as any)).toBe(false);
  });

  it('returns false when SANDBOX binding is missing', () => {
    expect(isSandboxEnabled({ SANDBOX_ENABLED: 'true' } as any)).toBe(false);
  });

  it('returns true when SANDBOX_ENABLED is "true" and SANDBOX binding exists', () => {
    expect(isSandboxEnabled({ SANDBOX_ENABLED: 'true', SANDBOX: {} } as any)).toBe(true);
  });
});

// =============================================================================
// Config resolution
// =============================================================================

describe('resolveSandboxAgentConfig', () => {
  it('uses defaults when no env vars or overrides provided', () => {
    const config = resolveSandboxAgentConfig({} as any);
    expect(config.modelId).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(config.maxTurns).toBe(20);
    expect(config.execTimeoutMs).toBe(30_000);
    expect(config.gitTimeoutMs).toBe(120_000);
    expect(config.sandboxId).toBe('default');
    expect(config.branch).toBe('main');
  });

  it('respects env var overrides', () => {
    const config = resolveSandboxAgentConfig({
      SANDBOX_DEFAULT_MODEL: '@cf/custom/model',
      SANDBOX_AGENT_MAX_TURNS: '10',
      SANDBOX_EXEC_TIMEOUT_MS: '60000',
      SANDBOX_GIT_TIMEOUT_MS: '240000',
    } as any);

    expect(config.modelId).toBe('@cf/custom/model');
    expect(config.maxTurns).toBe(10);
    expect(config.execTimeoutMs).toBe(60_000);
    expect(config.gitTimeoutMs).toBe(240_000);
  });

  it('overrides take precedence over env vars', () => {
    const config = resolveSandboxAgentConfig(
      { SANDBOX_DEFAULT_MODEL: '@cf/env/model' } as any,
      { modelId: '@cf/override/model', sandboxId: 'project-abc' },
    );

    expect(config.modelId).toBe('@cf/override/model');
    expect(config.sandboxId).toBe('project-abc');
  });
});

// =============================================================================
// Agent loop (mock-based)
// =============================================================================

describe('runSandboxAgent', () => {
  // Mock fetch globally for LLM calls
  const originalFetch = globalThis.fetch;

  function mockFetchResponse(responses: Array<{
    textContent: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  }>) {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const resp = responses[callIndex] || responses[responses.length - 1]!;
      callIndex++;

      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: resp.textContent,
            tool_calls: resp.toolCalls?.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
          finish_reason: resp.toolCalls ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('completes immediately when model returns no tool calls', async () => {
    mockFetchResponse([
      { textContent: 'Hello! How can I help?' },
    ]);

    const sandbox = createMockSandbox();
    const config = resolveSandboxAgentConfig({
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-token',
    } as any);

    const result = await runSandboxAgent(
      { CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-token' } as any,
      sandbox,
      config,
      'Hello',
    );

    expect(result.success).toBe(true);
    expect(result.totalTurns).toBe(1);
    expect(result.finalResponse).toBe('Hello! How can I help?');
    expect(result.turns[0]!.toolCalls).toHaveLength(0);

    globalThis.fetch = originalFetch;
  });

  it('executes tool calls and feeds results back', async () => {
    mockFetchResponse([
      {
        textContent: 'Let me list the files.',
        toolCalls: [{
          id: 'call_1',
          name: 'sandbox_list_files',
          arguments: JSON.stringify({ path: '/workspace' }),
        }],
      },
      { textContent: 'I found file1.ts and file2.ts.' },
    ]);

    const sandbox = createMockSandbox();
    const config = resolveSandboxAgentConfig({
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-token',
    } as any);

    const result = await runSandboxAgent(
      { CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-token' } as any,
      sandbox,
      config,
      'List files in workspace',
    );

    expect(result.success).toBe(true);
    expect(result.totalTurns).toBe(2);
    expect(result.turns[0]!.toolCalls).toHaveLength(1);
    expect(result.turns[0]!.toolCalls[0]!.name).toBe('sandbox_list_files');
    expect(sandbox.listFiles).toHaveBeenCalledWith('/workspace');

    globalThis.fetch = originalFetch;
  });

  it('respects maxTurns limit', async () => {
    // Always return tool calls to force hitting the limit
    mockFetchResponse([
      {
        textContent: '',
        toolCalls: [{
          id: 'call_loop',
          name: 'sandbox_exec',
          arguments: JSON.stringify({ command: 'echo hi' }),
        }],
      },
    ]);

    const sandbox = createMockSandbox();
    const config = resolveSandboxAgentConfig({
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-token',
    } as any, { maxTurns: 3 });

    const result = await runSandboxAgent(
      { CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-token' } as any,
      sandbox,
      config,
      'Keep going',
    );

    expect(result.success).toBe(true);
    expect(result.totalTurns).toBe(3);

    globalThis.fetch = originalFetch;
  });

  it('handles LLM errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    const sandbox = createMockSandbox();
    const config = resolveSandboxAgentConfig({
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-token',
    } as any);

    const result = await runSandboxAgent(
      { CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-token' } as any,
      sandbox,
      config,
      'Hello',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');

    globalThis.fetch = originalFetch;
  });

  it('streams SSE events via onEvent callback', async () => {
    mockFetchResponse([
      {
        textContent: 'Running command...',
        toolCalls: [{
          id: 'call_1',
          name: 'sandbox_exec',
          arguments: JSON.stringify({ command: 'echo hello' }),
        }],
      },
      { textContent: 'Done!' },
    ]);

    const sandbox = createMockSandbox();
    const config = resolveSandboxAgentConfig({
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-token',
    } as any);

    const events: Array<{ type: string }> = [];
    const onEvent = vi.fn().mockImplementation(async (event) => {
      events.push(event);
    });

    await runSandboxAgent(
      { CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-token' } as any,
      sandbox,
      config,
      'Run echo hello',
      undefined,
      onEvent,
    );

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('agent_start');
    expect(eventTypes).toContain('turn_start');
    expect(eventTypes).toContain('thinking');
    expect(eventTypes).toContain('tool_call');
    expect(eventTypes).toContain('tool_result');
    expect(eventTypes).toContain('turn_end');
    expect(eventTypes).toContain('agent_done');

    globalThis.fetch = originalFetch;
  });

  it('tracks token usage across turns', async () => {
    mockFetchResponse([
      {
        textContent: 'Step 1',
        toolCalls: [{
          id: 'call_1',
          name: 'sandbox_exec',
          arguments: JSON.stringify({ command: 'echo 1' }),
        }],
      },
      { textContent: 'Step 2' },
    ]);

    const sandbox = createMockSandbox();
    const config = resolveSandboxAgentConfig({
      CF_ACCOUNT_ID: 'test-account',
      CF_API_TOKEN: 'test-token',
    } as any);

    const result = await runSandboxAgent(
      { CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-token' } as any,
      sandbox,
      config,
      'Do work',
    );

    // 2 LLM calls, each with 100 prompt + 50 completion
    expect(result.tokenUsage?.promptTokens).toBe(200);
    expect(result.tokenUsage?.completionTokens).toBe(100);

    globalThis.fetch = originalFetch;
  });
});
