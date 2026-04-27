/**
 * Unit tests for SAM Phase D tools: create_idea, list_ideas, find_related_ideas,
 * get_ci_status, get_orchestrator_status.
 *
 * Tests cover:
 * - Parameter validation (missing/invalid required params)
 * - Ownership verification (reject unowned projectId)
 * - Successful execution with mocked D1/DO/fetch
 * - Registration in toolHandlers (executeTool dispatch)
 */
import { describe, expect, it, vi } from 'vitest';

import { executeTool } from '../../../src/durable-objects/sam-session/tools';
import { createIdea } from '../../../src/durable-objects/sam-session/tools/create-idea';
import { findRelatedIdeas } from '../../../src/durable-objects/sam-session/tools/find-related-ideas';
import { getCiStatus } from '../../../src/durable-objects/sam-session/tools/get-ci-status';
import { getOrchestratorStatus } from '../../../src/durable-objects/sam-session/tools/get-orchestrator-status';
import { listIdeas } from '../../../src/durable-objects/sam-session/tools/list-ideas';
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

vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn().mockResolvedValue('ghp_test_token_123'),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock D1Database that returns configurable results. */
function mockD1(options: {
  firstResult?: Record<string, unknown> | null;
  allResults?: Record<string, unknown>[];
  runChanges?: number;
} = {}) {
  // Drizzle ORM calls stmt.bind(...).raw(true) to get row arrays, then maps to objects.
  // We must return arrays-of-arrays matching the column order Drizzle expects.
  const allResultArrays = (options.allResults ?? []).map((row) => Object.values(row));
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(options.firstResult ?? null),
    all: vi.fn().mockResolvedValue({
      results: options.allResults ?? [],
      success: true,
    }),
    raw: vi.fn().mockResolvedValue(allResultArrays),
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
          getStatus: vi.fn().mockResolvedValue({ activeMissions: [], recentDecisions: [] }),
          getSchedulingQueue: vi.fn().mockResolvedValue([]),
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

// ─── create_idea ──────────────────────────────────────────────────────────────

describe('create_idea', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await createIdea({ projectId: '', title: 'test' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing title', async () => {
    const ctx = buildCtx();
    const result = await createIdea({ projectId: 'proj-1', title: '' }, ctx);
    expect(result).toEqual({ error: 'title is required.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-1',
      name: 'create_idea',
      input: { projectId: 'not-owned', title: 'Test idea' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBe('Project not found or not owned by you.');
  });
});

// ─── list_ideas ───────────────────────────────────────────────────────────────

describe('list_ideas', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await listIdeas({ projectId: '' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-2',
      name: 'list_ideas',
      input: { projectId: 'not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── find_related_ideas ─────────────────────────────────────────────────────

describe('find_related_ideas', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await findRelatedIdeas({ projectId: '', query: 'test' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing query', async () => {
    const ctx = buildCtx();
    const result = await findRelatedIdeas({ projectId: 'proj-1', query: '' }, ctx);
    expect(result).toEqual({ error: 'query is required.' });
  });

  it('rejects short query', async () => {
    const ctx = buildCtx();
    const result = await findRelatedIdeas({ projectId: 'proj-1', query: 'a' }, ctx);
    expect(result).toEqual({ error: 'query must be at least 2 characters.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-3',
      name: 'find_related_ideas',
      input: { projectId: 'not-owned', query: 'test query' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── get_ci_status ──────────────────────────────────────────────────────────

describe('get_ci_status', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await getCiStatus({ projectId: '' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-4',
      name: 'get_ci_status',
      input: { projectId: 'not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── get_orchestrator_status ────────────────────────────────────────────────

describe('get_orchestrator_status', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await getOrchestratorStatus({ projectId: '' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-5',
      name: 'get_orchestrator_status',
      input: { projectId: 'not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── create_idea (success paths) ──────────────────────────────────────────────

describe('create_idea — success paths', () => {
  it('creates idea when project is owned', async () => {
    // Drizzle calls prepare().bind().all() for the SELECT ownership check,
    // then prepare().bind().first() for the COUNT, then prepare().bind().run() for INSERT.
    // Our mock D1 returns firstResult for first() and allResults for all().
    const ctx = buildCtx({
      // Ownership SELECT returns a project row via all()
      dbAllResults: [{ id: 'proj-1' }],
      // COUNT query via first() returns below limit
      dbFirstResult: { cnt: 5 },
    });
    const result = (await createIdea(
      { projectId: 'proj-1', title: 'My cool idea', description: 'Details here', priority: 3 },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ideaId).toBeDefined();
    expect(result.title).toBe('My cool idea');
    expect(result.status).toBe('draft');
    expect(result.priority).toBe(3);
    expect(result.message).toBe('Idea created successfully.');
  });

  it('clamps priority to 0-10 range', async () => {
    const ctx = buildCtx({
      dbAllResults: [{ id: 'proj-1' }],
      dbFirstResult: { cnt: 0 },
    });
    const result = (await createIdea(
      { projectId: 'proj-1', title: 'Test', priority: 99 },
      ctx,
    )) as Record<string, unknown>;
    expect(result.priority).toBe(10);
  });
});

// ─── get_ci_status (branch paths) ────────────────────────────────────────────

describe('get_ci_status — branch paths', () => {
  it('returns no_repository when project has no repository', async () => {
    const ctx = buildCtx({
      // Ownership query returns project with no repository
      dbAllResults: [{ id: 'proj-1', repository: null, defaultBranch: 'main' }],
    });
    const result = (await getCiStatus({ projectId: 'proj-1' }, ctx)) as Record<string, unknown>;
    expect(result.status).toBe('no_repository');
  });

  it('returns error for invalid repository format', async () => {
    const ctx = buildCtx({
      dbAllResults: [{ id: 'proj-1', repository: 'not a valid repo!', defaultBranch: 'main' }],
    });
    const result = (await getCiStatus({ projectId: 'proj-1' }, ctx)) as Record<string, unknown>;
    expect(result.error).toBe('Invalid repository format.');
  });

  it('returns no_credentials when decrypt fails (no valid token)', async () => {
    const { decrypt } = await import('../../../src/services/encryption');
    const mockDecrypt = decrypt as ReturnType<typeof vi.fn>;
    // Make decrypt throw to simulate credential resolution failure
    mockDecrypt.mockRejectedValueOnce(new Error('decrypt failed'));

    const ctx = buildCtx({
      dbAllResults: [{ id: 'proj-1', repository: 'owner/repo', defaultBranch: 'main' }],
    });
    const result = (await getCiStatus({ projectId: 'proj-1' }, ctx)) as Record<string, unknown>;
    expect(result.status).toBe('no_credentials');
  });
});

// ─── get_orchestrator_status (error path) ────────────────────────────────────

describe('get_orchestrator_status — error path', () => {
  it('returns graceful error when orchestrator DO throws', async () => {
    const ctx = buildCtx({
      dbAllResults: [{ id: 'proj-1' }],
    });
    // Override the orchestrator stub to throw
    const orchStub = (ctx.env as Record<string, unknown>).PROJECT_ORCHESTRATOR as Record<string, unknown>;
    (orchStub.get as ReturnType<typeof vi.fn>).mockReturnValue({
      getStatus: vi.fn().mockRejectedValue(new Error('DO unavailable')),
      getSchedulingQueue: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    });

    const result = (await getOrchestratorStatus({ projectId: 'proj-1' }, ctx)) as Record<string, unknown>;
    expect(result.orchestrator).toBeNull();
    expect(result.note).toContain('not available');
  });
});

// ─── SAM_TOOLS array verification ─────────────────────────────────────────────

describe('SAM_TOOLS array', () => {
  it('contains all Phase D tool definitions', async () => {
    const { SAM_TOOLS } = await import('../../../src/durable-objects/sam-session/tools');
    const toolNames = SAM_TOOLS.map((t) => t.name);
    for (const name of ['create_idea', 'list_ideas', 'find_related_ideas', 'get_ci_status', 'get_orchestrator_status']) {
      expect(toolNames).toContain(name);
    }
  });
});

// ─── Tool registration ───────────────────────────────────────────────────────

describe('Phase D tool registration', () => {
  const ctx = buildCtx();

  it('all 5 new tools are registered in executeTool', async () => {
    for (const toolName of [
      'create_idea',
      'list_ideas',
      'find_related_ideas',
      'get_ci_status',
      'get_orchestrator_status',
    ]) {
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

  it('Phase A tools still work', async () => {
    for (const toolName of ['dispatch_task', 'get_task_details', 'create_mission', 'get_mission']) {
      const toolCall: CollectedToolCall = {
        id: `compat-${toolName}`,
        name: toolName,
        input: {},
      };
      const result = await executeTool(toolCall, ctx);
      const r = result as { error?: string };
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
