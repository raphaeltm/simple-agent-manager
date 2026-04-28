/**
 * Unit tests for ProjectAgent Durable Object.
 *
 * Covers:
 * - Project-scoped tool definitions (projectId stripped from input schemas)
 * - Tool handler projectId injection via withProjectId wrapper
 * - Tool execution dispatch and error handling
 * - AgentLoopOptions integration (system prompt, tools, executor, toolContextExtras)
 */
import { describe, expect, it, vi } from 'vitest';


// Mock cloudflare:workers
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

describe('Project Agent Tool Definitions', () => {
  it('exports tool definitions with projectId stripped', async () => {
    const { PROJECT_AGENT_TOOLS } = await import(
      '../../../src/durable-objects/project-agent/tools'
    );

    expect(PROJECT_AGENT_TOOLS.length).toBeGreaterThan(0);

    for (const tool of PROJECT_AGENT_TOOLS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('input_schema');
      expect(tool.input_schema.type).toBe('object');

      // projectId must NOT appear in any tool's input schema
      expect(tool.input_schema.properties).not.toHaveProperty('projectId');
      if (tool.input_schema.required) {
        expect(tool.input_schema.required).not.toContain('projectId');
      }
    }
  });

  it('includes expected tool categories', async () => {
    const { PROJECT_AGENT_TOOLS } = await import(
      '../../../src/durable-objects/project-agent/tools'
    );
    const names = PROJECT_AGENT_TOOLS.map((t) => t.name);

    // Knowledge
    expect(names).toContain('search_knowledge');
    expect(names).toContain('get_project_knowledge');
    expect(names).toContain('add_knowledge');

    // Policies
    expect(names).toContain('add_policy');
    expect(names).toContain('list_policies');

    // Tasks
    expect(names).toContain('dispatch_task');
    expect(names).toContain('search_tasks');
    expect(names).toContain('get_task_details');

    // Sessions
    expect(names).toContain('list_sessions');
    expect(names).toContain('get_session_messages');

    // Ideas
    expect(names).toContain('create_idea');
    expect(names).toContain('list_ideas');

    // Missions
    expect(names).toContain('create_mission');
    expect(names).toContain('get_mission');

    // Codebase
    expect(names).toContain('search_code');
    expect(names).toContain('get_file_content');

    // Monitoring
    expect(names).toContain('get_ci_status');

    // Conversation memory
    expect(names).toContain('search_conversation_history');
  });

  it('does NOT include cross-project tools', async () => {
    const { PROJECT_AGENT_TOOLS } = await import(
      '../../../src/durable-objects/project-agent/tools'
    );
    const names = PROJECT_AGENT_TOOLS.map((t) => t.name);

    // These are SAM-level (cross-project) tools, not project-scoped
    expect(names).not.toContain('list_projects');
    expect(names).not.toContain('get_project_status');
  });
});

describe('Project Agent Tool Execution', () => {
  it('returns error for unknown tools', async () => {
    const { executeProjectTool } = await import(
      '../../../src/durable-objects/project-agent/tools'
    );

    const result = await executeProjectTool(
      { id: 'call-1', name: 'nonexistent_tool', input: {} },
      { env: {} as Record<string, unknown>, userId: 'u1', projectId: 'p1' },
    );
    expect(result).toEqual({ error: 'Unknown tool: nonexistent_tool' });
  });

  it('injects projectId from context for project-scoped tools', async () => {
    const { executeProjectTool } = await import(
      '../../../src/durable-objects/project-agent/tools'
    );

    // search_knowledge requires projectId — the handler should receive it from ctx
    const result = await executeProjectTool(
      { id: 'call-2', name: 'search_knowledge', input: { query: 'test' } },
      {
        env: { DATABASE: {} } as Record<string, unknown>,
        userId: 'user-1',
        projectId: 'project-1',
      },
    );

    // Will fail because mock DATABASE isn't real, but the error should NOT be
    // "Project agent context missing projectId" — that would mean injection failed
    const errorResult = result as { error?: string };
    if (errorResult.error) {
      expect(errorResult.error).not.toContain('missing projectId');
    }
  });

  it('returns error when projectId is missing from context', async () => {
    const { executeProjectTool } = await import(
      '../../../src/durable-objects/project-agent/tools'
    );

    const result = await executeProjectTool(
      { id: 'call-3', name: 'search_knowledge', input: { query: 'test' } },
      {
        env: {} as Record<string, unknown>,
        userId: 'user-1',
        // No projectId
      },
    );

    expect(result).toEqual({ error: 'Project agent context missing projectId.' });
  });

  it('does not inject projectId for tools that do not need it', async () => {
    const { executeProjectTool } = await import(
      '../../../src/durable-objects/project-agent/tools'
    );

    // get_task_details uses taskId, not projectId
    const result = await executeProjectTool(
      { id: 'call-4', name: 'get_task_details', input: { taskId: 'task-1' } },
      {
        env: { DATABASE: {} } as Record<string, unknown>,
        userId: 'user-1',
        projectId: 'project-1',
      },
    );

    // Will fail because mock DB, but should not say "Unknown tool"
    const errorResult = result as { error?: string };
    if (errorResult.error) {
      expect(errorResult.error).not.toContain('Unknown tool');
    }
  });
});

describe('Project Agent System Prompt', () => {
  it('exports a system prompt focused on project scope', async () => {
    const { PROJECT_AGENT_SYSTEM_PROMPT } = await import(
      '../../../src/durable-objects/project-agent/system-prompt'
    );

    expect(typeof PROJECT_AGENT_SYSTEM_PROMPT).toBe('string');
    expect(PROJECT_AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(PROJECT_AGENT_SYSTEM_PROMPT).toContain('Project Agent');
    expect(PROJECT_AGENT_SYSTEM_PROMPT).toContain('project');
    // Should scope itself to a single project
    expect(PROJECT_AGENT_SYSTEM_PROMPT).toContain('single project');
  });
});
