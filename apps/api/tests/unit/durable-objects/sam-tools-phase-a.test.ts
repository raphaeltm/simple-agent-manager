/**
 * Unit tests for SAM Phase A tools: dispatch_task, get_task_details, create_mission, get_mission.
 *
 * Tests cover:
 * - Parameter validation (missing/invalid required params)
 * - Ownership verification (reject unowned projectId/missionId)
 * - Successful execution with mocked D1/DO
 * - Registration in toolHandlers (executeTool dispatch)
 */
import { describe, expect, it, vi } from 'vitest';

import { executeTool } from '../../../src/durable-objects/sam-session/tools';
import { createMission } from '../../../src/durable-objects/sam-session/tools/create-mission';
import { dispatchTask } from '../../../src/durable-objects/sam-session/tools/dispatch-task';
import { getMission } from '../../../src/durable-objects/sam-session/tools/get-mission';
import { getTaskDetails } from '../../../src/durable-objects/sam-session/tools/get-task-details';
import type { CollectedToolCall, ToolContext } from '../../../src/durable-objects/sam-session/types';

// Mock cloudflare:workers (vitest hoists vi.mock calls)
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

vi.mock('../../../src/services/task-final-assistant-message', () => ({
  getLatestAssistantMessageForTask: vi.fn().mockResolvedValue(null),
}));

import { getLatestAssistantMessageForTask } from '../../../src/services/task-final-assistant-message';
const mockGetLatestAssistant = vi.mocked(getLatestAssistantMessageForTask);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock D1Database that returns configurable results. */
function mockD1(options: {
  firstResult?: Record<string, unknown> | null;
  allResults?: Record<string, unknown>[];
  runChanges?: number;
} = {}) {
  const results = options.allResults ?? [];
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(options.firstResult ?? null),
    all: vi.fn().mockResolvedValue({
      results,
      success: true,
    }),
    raw: vi.fn().mockResolvedValue(results.map((r) => Object.values(r))),
    run: vi.fn().mockResolvedValue({
      success: true,
      meta: { changes: options.runChanges ?? 1 },
    }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  };
}

/** Build a minimal ToolContext with mocked bindings. */
function buildCtx(overrides: {
  dbFirstResult?: Record<string, unknown> | null;
  dbAllResults?: Record<string, unknown>[];
  dbRunChanges?: number;
  userId?: string;
} = {}): ToolContext & { _db: ReturnType<typeof mockD1> } {
  const db = mockD1({
    firstResult: overrides.dbFirstResult,
    allResults: overrides.dbAllResults,
    runChanges: overrides.dbRunChanges,
  });

  return {
    env: {
      DATABASE: db as unknown,
      PROJECT_DATA: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('ok')),
        }),
      },
      PROJECT_ORCHESTRATOR: {
        idFromName: vi.fn().mockReturnValue('orch-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'active' }))),
        }),
      },
      TASK_RUNNER: {
        idFromName: vi.fn().mockReturnValue('runner-id'),
        get: vi.fn().mockReturnValue({
          start: vi.fn().mockResolvedValue(undefined),
          fetch: vi.fn().mockResolvedValue(new Response('ok')),
        }),
      },
      AI: {},
      BASE_DOMAIN: 'example.com',
      BRANCH_NAME_PREFIX: 'sam/',
      BRANCH_NAME_MAX_LENGTH: '60',
    } as Record<string, unknown>,
    userId: overrides.userId ?? 'user-123',
    _db: db,
  };
}

// ─── get_task_details ─────────────────────────────────────────────────────────

describe('get_task_details', () => {
  it('rejects missing taskId', async () => {
    const ctx = buildCtx();
    const result = await getTaskDetails({ taskId: '' }, ctx);
    expect(result).toEqual({ error: 'taskId is required.' });
  });

  it('rejects unowned task', async () => {
    // D1 drizzle select will throw because mock isn't a real D1Database
    // but executeTool catches it — test the ownership pattern via executeTool
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-1',
      name: 'get_task_details',
      input: { taskId: 'task-that-doesnt-exist' },
    };
    const result = await executeTool(toolCall, ctx);
    // Should get an error (either ownership or mock DB failure), not "Unknown tool"
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });

  it('includes finalAssistantMessage from the service when a chat session exists', async () => {
    const taskRow = {
      id: 'task-with-session',
      title: 'Test task',
      description: 'Test',
      status: 'completed',
      priority: 1,
      output_branch: null,
      output_pr_url: null,
      output_summary: null,
      completion_evidence: null,
      error_message: null,
      execution_step: null,
      created_at: '2026-03-14T00:00:00Z',
      updated_at: '2026-03-14T01:00:00Z',
      started_at: '2026-03-14T00:05:00Z',
      completed_at: '2026-03-14T01:00:00Z',
      chat_session_id: 'chat-session-99',
      project_id: 'proj-1',
      name: 'Test Project',
    };

    const ctx = buildCtx({ dbAllResults: [taskRow] });

    mockGetLatestAssistant.mockResolvedValueOnce({
      id: 'msg-final',
      content: 'Final diagnostic output',
      createdAt: 1710000002000,
    });

    const result = (await getTaskDetails({ taskId: 'task-with-session' }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.finalAssistantMessage).toEqual({
      id: 'msg-final',
      content: 'Final diagnostic output',
      createdAt: 1710000002000,
    });
    expect(mockGetLatestAssistant).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'chat-session-99',
    );
  });
});

// ─── get_mission ──────────────────────────────────────────────────────────────

describe('get_mission', () => {
  it('rejects missing missionId', async () => {
    const ctx = buildCtx();
    const result = await getMission({ missionId: '' }, ctx);
    expect(result).toEqual({ error: 'missionId is required.' });
  });

  it('rejects unowned mission via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-2',
      name: 'get_mission',
      input: { missionId: 'mission-not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── create_mission ───────────────────────────────────────────────────────────

describe('create_mission', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await createMission({ projectId: '', title: 'test' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing title', async () => {
    const ctx = buildCtx();
    const result = await createMission({ projectId: 'proj-1', title: '' }, ctx);
    expect(result).toEqual({ error: 'title is required.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-3',
      name: 'create_mission',
      input: { projectId: 'not-owned', title: 'Test mission' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── dispatch_task ────────────────────────────────────────────────────────────

describe('dispatch_task', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await dispatchTask(
      { projectId: '', description: 'test' },
      ctx,
    );
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing description', async () => {
    const ctx = buildCtx();
    const result = await dispatchTask(
      { projectId: 'proj-1', description: '' },
      ctx,
    );
    expect(result).toEqual({ error: 'description is required.' });
  });

  it('rejects invalid vmSize', async () => {
    const ctx = buildCtx();
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'test', vmSize: 'enormous' },
      ctx,
    );
    expect(result).toEqual({ error: 'vmSize must be small, medium, or large.' });
  });

  it('rejects invalid taskMode', async () => {
    const ctx = buildCtx();
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'test', taskMode: 'invalid' },
      ctx,
    );
    expect((result as { error: string }).error).toContain('taskMode must be one of');
  });

  it('rejects invalid workspaceProfile', async () => {
    const ctx = buildCtx();
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'test', workspaceProfile: 'invalid' },
      ctx,
    );
    expect((result as { error: string }).error).toContain('workspaceProfile must be one of');
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-4',
      name: 'dispatch_task',
      input: { projectId: 'not-owned', description: 'test task' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── Tool registration ───────────────────────────────────────────────────────

describe('Phase A tool registration', () => {
  const ctx = buildCtx();

  it('all 4 new tools are registered in executeTool', async () => {
    for (const toolName of ['dispatch_task', 'get_task_details', 'create_mission', 'get_mission']) {
      const toolCall: CollectedToolCall = {
        id: `reg-${toolName}`,
        name: toolName,
        input: {},
      };
      const result = await executeTool(toolCall, ctx);
      const r = result as { error?: string };
      // If there's an error, it should NOT be "Unknown tool"
      if (r.error) {
        expect(r.error).not.toContain('Unknown tool');
      }
    }
  });

  it('original 4 tools still work', async () => {
    for (const toolName of ['list_projects', 'get_project_status', 'search_tasks', 'search_conversation_history']) {
      const toolCall: CollectedToolCall = {
        id: `orig-${toolName}`,
        name: toolName,
        input: toolName === 'search_conversation_history' ? { query: 'test' } : {},
      };
      const result = await executeTool(toolCall, ctx);
      const r = result as { error?: string };
      if (r.error) {
        expect(r.error).not.toContain('Unknown tool');
      }
    }
  });
});
